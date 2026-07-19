'use strict';
// lib/privlobby.js — PURE rules for private, invite-only lobbies.
//
// ZERO I/O, like lib/p2pbet.js. KV, HMAC secrets and sockets live in the callers
// (api/leaderboard.js for the lobby record, server.js for the handshake check), so every rule here
// can be proved offline before anything touches a server holding player deposits.
//
// ── THE ISOLATION GUARANTEE ───────────────────────────────────────────────────────────────────
// Public lobbies are an EXACT-STRING allowlist on the game server:
//     LOBBY_IDS = new Set(['free-lobby','ss-free-lobby','ss-paid-lobby-1','ss-paid-lobby-5',…])
// Private lobbies deliberately use a PREFIX that no public id can ever match, so the server gate
// becomes `LOBBY_IDS.has(id) || isPrivateLobbyId(id)`. That is purely ADDITIVE: every public lobby
// still matches the identical string and runs the identical branch. No public condition is edited,
// which is what makes "public lobbies behave exactly as before" a structural property rather than
// a promise. The public lobby-count and admin-listing arrays are likewise left untouched, so
// private rooms stay out of public listings by omission rather than by filtering.
//
// Gameplay is unchanged by construction: the simulation is per-room (`ssGames.get(lid)`), so a
// private room is just another room running the same tick, physics, collision and cash-out code.
// There is no "public mode" for it to diverge from.

const PRIV_PREFIX   = 'ss-priv-';
const ID_CHARS      = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const ID_LEN        = 8;
const MAX_MEMBERS   = 12;      // hard cap on invited players per lobby
const INVITE_TTL_MS = 86400000; // 24h — an invite outlives a session but not forever
const CODE_LEN      = 6;       // human-shareable join code

const STATUS = { OPEN: 'open', LIVE: 'live', CLOSED: 'closed' };
// The stakes a host may choose. Mirrors the public lobbies (free / $1 / $5) so a private match
// is priced like a normal one and settle.js needs no new price handling.
const ALLOWED_USD = [0, 1, 5];

// ── ids ───────────────────────────────────────────────────────────────────────
function isPrivateLobbyId(id) {
  if (typeof id !== 'string') return false;
  if (id.indexOf(PRIV_PREFIX) !== 0) return false;
  const tail = id.slice(PRIV_PREFIX.length);
  if (tail.length !== ID_LEN) return false;
  for (const ch of tail) if (ID_CHARS.indexOf(ch) < 0) return false;
  return true;
}
// `rnd` is injectable so tests are deterministic and the module stays pure.
function makeLobbyId(rnd) {
  const r = rnd || Math.random;
  let s = '';
  for (let i = 0; i < ID_LEN; i++) s += ID_CHARS[Math.floor(r() * ID_CHARS.length) % ID_CHARS.length];
  return PRIV_PREFIX + s;
}
function makeJoinCode(rnd) {
  const r = rnd || Math.random;
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ID_CHARS[Math.floor(r() * ID_CHARS.length) % ID_CHARS.length];
  return s.toUpperCase();
}

// ── the lobby record ──────────────────────────────────────────────────────────
function newLobby({ id, code, host, region, usd, nowMs }) {
  return {
    id, code,
    host,
    region: region === 'EU' ? 'EU' : 'NA',
    usd: Math.max(0, Math.floor(Number(usd) || 0)),   // 0 = free, else the entry price
    status: STATUS.OPEN,
    invited: [host],          // the host is always a member of their own lobby
    // Everyone must AGREE to the stake before the match can start. Keyed by address so it survives
    // invites/kicks. The host is not auto-ready: they agree to their own price like everyone else.
    ready: {},
    createdTs: nowMs,
    startedTs: 0,
  };
}

// ── membership ────────────────────────────────────────────────────────────────
function isHost(lobby, addr)   { return !!lobby && !!addr && lobby.host === addr; }
function isInvited(lobby, addr) {
  return !!lobby && !!addr && Array.isArray(lobby.invited) && lobby.invited.indexOf(addr) >= 0;
}

function validateInvite({ lobby, byAddr, invitee, nowMs }) {
  if (!lobby) return 'lobby not found';
  if (lobby.status === STATUS.CLOSED) return 'this lobby is closed';
  if (!isHost(lobby, byAddr)) return 'only the host can invite';
  if (!invitee) return 'pick a player to invite';
  if (invitee === lobby.host) return 'you are already in this lobby';
  if (isInvited(lobby, invitee)) return 'they are already invited';
  if (lobby.invited.length >= MAX_MEMBERS) return 'this lobby is full (' + MAX_MEMBERS + ' players)';
  if (isExpired(lobby, nowMs)) return 'this lobby has expired';
  return null;
}

// Kicking is host-only and can never remove the host — otherwise a lobby could be left ownerless
// with players still in it and no way to start or close it.
function validateKick({ lobby, byAddr, target }) {
  if (!lobby) return 'lobby not found';
  if (!isHost(lobby, byAddr)) return 'only the host can remove players';
  if (!target) return 'pick a player to remove';
  if (target === lobby.host) return 'the host cannot be removed';
  if (!isInvited(lobby, target)) return 'they are not in this lobby';
  return null;
}

function validateStart({ lobby, byAddr }) {
  if (!lobby) return 'lobby not found';
  if (!isHost(lobby, byAddr)) return 'only the host can start the match';
  if (lobby.status === STATUS.LIVE) return 'the match has already started';
  if (lobby.status === STATUS.CLOSED) return 'this lobby is closed';
  if (lobby.invited.length < 2) return 'you need at least one other player to start';
  // Nobody gets pulled into a paid match they did not agree to: EVERY member must be ready, and
  // changing the stake clears every ready flag so they all have to agree again.
  const notReady = notReadyList(lobby);
  if (notReady.length) return 'waiting for ' + notReady.length + ' player' + (notReady.length === 1 ? '' : 's') + ' to ready up';
  return null;
}
function isReady(lobby, addr) { return !!(lobby && lobby.ready && lobby.ready[addr]); }
function notReadyList(lobby) {
  if (!lobby) return [];
  return (lobby.invited || []).filter(a => !isReady(lobby, a));
}
// Host sets the stake. Only while OPEN — changing it mid-match would move the goalposts on a run
// people already paid for.
function validateSetPrice({ lobby, byAddr, usd }) {
  if (!lobby) return 'lobby not found';
  if (!isHost(lobby, byAddr)) return 'only the host can set the stake';
  if (lobby.status !== STATUS.OPEN) return 'the match has already started';
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return 'invalid amount';
  if (ALLOWED_USD.indexOf(Math.floor(n)) < 0) return 'pick one of: free, $' + ALLOWED_USD.filter(Boolean).join(', $');
  return null;
}
function validateReady({ lobby, addr }) {
  if (!lobby) return 'lobby not found';
  if (lobby.status !== STATUS.OPEN) return 'the match has already started';
  if (!isInvited(lobby, addr)) return 'you are not in this lobby';
  return null;
}
// ⚠️ Changing the stake RESETS every ready flag — otherwise the host could get everyone to agree to
// free and then flip it to $5 with their agreement still standing.
function applySetPrice(lobby, usd) {
  return Object.assign({}, lobby, { usd: Math.max(0, Math.floor(Number(usd) || 0)), ready: {} });
}
function applyReady(lobby, addr, on) {
  const ready = Object.assign({}, lobby.ready || {});
  if (on) ready[addr] = true; else delete ready[addr];
  return Object.assign({}, lobby, { ready });
}

// Who may CONNECT. Deliberately allows joining a lobby that is already LIVE: that is what makes
// rejoining a private match work exactly like a public one after a disconnect or a refresh.
function canJoin({ lobby, addr, nowMs }) {
  if (!lobby) return 'lobby not found';
  if (lobby.status === STATUS.CLOSED) return 'this lobby is closed';
  if (isExpired(lobby, nowMs)) return 'this lobby has expired';
  if (!isInvited(lobby, addr)) return 'you need an invite to join this lobby';
  return null;
}

function isExpired(lobby, nowMs) {
  if (!lobby) return true;
  return (Number(nowMs) - Number(lobby.createdTs || 0)) > INVITE_TTL_MS;
}

function applyInvite(lobby, invitee) {
  const next = Object.assign({}, lobby, { invited: lobby.invited.slice() });
  next.invited.push(invitee);
  return next;
}
function applyKick(lobby, target) {
  const ready = Object.assign({}, lobby.ready || {});
  delete ready[target];      // don't leave a ghost ready flag behind for someone who is gone
  return Object.assign({}, lobby, { invited: lobby.invited.filter(a => a !== target), ready });
}
function applyStart(lobby, nowMs) {
  return Object.assign({}, lobby, { status: STATUS.LIVE, startedTs: nowMs });
}

// ── handshake token ───────────────────────────────────────────────────────────
// The game server must not have to call the API on every join (latency + a new failure mode on the
// money path). Instead the API hands the client a short-lived HMAC that the server verifies
// LOCALLY with the GAME_SECRET it already has — the same trust model as the existing entry token
// and the signed bettable-snake roster.
// `usd` is INSIDE the signature on purpose: the game server decides whether to demand an entry
// deposit from what this token says, so an unsigned price could be forged down to 0 to play a paid
// private lobby for free.
function inviteCanon(lobbyId, addr, usd, expTs) {
  return 'priv:' + lobbyId + ':' + addr + ':' + Math.max(0, Math.floor(Number(usd) || 0)) + ':' + expTs;
}
// Pure: the caller supplies its own HMAC function so this module stays I/O- and crypto-free.
function verifyInviteToken({ lobbyId, addr, usd, expTs, sig, nowMs, hmac }) {
  if (!lobbyId || !addr || !sig) return 'missing invite';
  if (!(Number(expTs) > Number(nowMs))) return 'invite expired — ask the host again';
  if (hmac(inviteCanon(lobbyId, addr, usd, expTs)) !== sig) return 'invalid invite';
  return null;
}

// What a member is allowed to see about a lobby. Never leaks anything a public listing wouldn't.
function publicView(lobby, names) {
  if (!lobby) return null;
  const nm = names || {};
  return {
    id: lobby.id, code: lobby.code, region: lobby.region, usd: lobby.usd,
    status: lobby.status, host: lobby.host, hostName: nm[lobby.host] || '',
    members: (lobby.invited || []).map(a => ({ address: a, name: nm[a] || '', host: a === lobby.host,
                                              ready: isReady(lobby, a) })),
    allReady: notReadyList(lobby).length === 0,
    notReady: notReadyList(lobby).length,
    allowedUsd: ALLOWED_USD,
    count: (lobby.invited || []).length, max: MAX_MEMBERS,
    createdTs: lobby.createdTs, startedTs: lobby.startedTs,
  };
}

module.exports = {
  PRIV_PREFIX, ID_LEN, MAX_MEMBERS, INVITE_TTL_MS, CODE_LEN, STATUS, ALLOWED_USD,
  isReady, notReadyList, validateSetPrice, validateReady, applySetPrice, applyReady,
  isPrivateLobbyId, makeLobbyId, makeJoinCode, newLobby,
  isHost, isInvited, isExpired,
  validateInvite, validateKick, validateStart, canJoin,
  applyInvite, applyKick, applyStart,
  inviteCanon, verifyInviteToken, publicView,
};
