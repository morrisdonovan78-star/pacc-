/*
 * SNAKEPOT BATTLE ROYALE — multiplayer game server (NA Chicago + EU Frankfurt)
 * ---------------------------------------------------------------------------
 * Its OWN pm2 process on :3003, deliberately NOT inside pac-arena (:3001) or
 * kart-arena (:3002). Same reasoning as kart: snake/pac are proven money
 * processes and this is new code — a crash here must never touch them.
 *
 * Socket path is /br/socket.io so nginx routes it on the existing
 * us./eu.pac-arena.com certificates without a new subdomain.
 *
 * SERVER-AUTHORITATIVE EVERYTHING. Clients send inputs (move axes, look
 * angles, buttons). This process runs the simulation — movement, collision,
 * every shot's raycast, damage, downs, revives, loot, the zone, the win —
 * and broadcasts results. Nothing a client claims about position, health,
 * damage, inventory or winning is ever believed.
 *
 * MONEY: identical trust model to kart, reusing the SAME backend actions so
 * zero new code runs in the escrow path:
 *   - entry:  the platform page pays on-chain and calls settle `kart-entry`
 *             (generic over lobbyId; ours are `br-*`), gets an HMAC ticket.
 *   - this process verifies the ticket signature. It has no wallet, no RPC,
 *             no escrow key, and must never gain one.
 *   - settle: `kart-settle` with matchId as the raceId — idempotent, winners
 *             split pot minus 10%.
 *   - refund: `kart-refund` per entry, stable refund ids derived from pay time.
 * All money calls go through the durable on-disk queue (written before
 * attempted, retried with backoff until the far end CONFIRMS, dead-lettered
 * loudly). Copied from kart-server.js where it is proven in production.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const BR = require('./br-shared.js');   // ONE source of truth for map/physics/weapons

const PORT = process.env.BR_PORT || 3003;
const REGION = process.env.BR_REGION || 'NA';

const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const SETTLE_URL = process.env.SETTLE_URL || 'https://snakepot.com/api/settle';
const ENTRY_FEES_ENABLED = !!GAME_SECRET;
const SITE_URL = (process.env.SITE_URL || 'https://snakepot.com').replace(/\/+$/, '');

// ═══════════════════════════════════════════════════════════════════════════
// TICKETS — same canon as kart ('kart-entry:'), because the backend that
// issues them is the same action. A ticket binds (lobbyId, address, cents,
// lamports, ts); ours differ only in that lobby ids start 'br-'.
// ═══════════════════════════════════════════════════════════════════════════
const _spentTickets = new Map();
function retireTicket(t) { if (t) _spentTickets.set(String(t), Date.now()); }
function ticketSpent(t) { return t != null && _spentTickets.has(String(t)); }
setInterval(() => {
  const cut = Date.now() - 45 * 60 * 1000;
  for (const [k, v] of _spentTickets) if (v < cut) _spentTickets.delete(k);
}, 5 * 60 * 1000).unref?.();

function verifyTicket(lobbyId, ticket, tsig) {
  if (!GAME_SECRET || !ticket || !tsig) return null;
  const expect = crypto.createHmac('sha256', GAME_SECRET).update('kart-entry:' + ticket).digest('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(tsig))); } catch (_) { return null; }
  if (!ok) return null;
  const [lid, address, cents, lamports, ts] = String(ticket).split('|');
  if (lid !== lobbyId) return null;
  if (Date.now() - Number(ts) > 30 * 60 * 1000) return null;
  return { address, cents: Number(cents), lamports: Number(lamports) };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MONEY QUEUE — verbatim from kart-server.js (proven live), br file names.
 * Every payout and refund is written to disk BEFORE it is attempted, drained
 * with backoff until the far end confirms, then dead-lettered loudly.
 * ═══════════════════════════════════════════════════════════════════════════ */
const QUEUE_FILE = process.env.BR_QUEUE_FILE || path.join(__dirname, 'br-queue-' + REGION + '.json');
const QUEUE_DEAD_FILE = QUEUE_FILE.replace(/\.json$/, '-dead.json');
const JOB_MAX_TRIES = 500;
const JOB_BACKOFF_MAX_MS = 120000;
const DRAIN_MS = 5000;

const _jobs = new Map();
const _inflight = new Map();   // matchId -> { matchId, entries, potLamports, at }

function saveQueue() {
  try {
    const data = JSON.stringify({ v: 1, region: REGION, jobs: [..._jobs.values()], inflight: [..._inflight.values()] });
    fs.writeFileSync(QUEUE_FILE + '.tmp', data);
    fs.renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE);
  } catch (e) {
    console.error('[br] ⚠️ QUEUE SAVE FAILED — payouts are NOT durable right now:', e && e.message);
  }
}
function loadQueue() {
  let raw = null;
  try { raw = fs.readFileSync(QUEUE_FILE, 'utf8'); } catch (_) { return; }
  try {
    const d = JSON.parse(raw) || {};
    for (const j of d.jobs || []) if (j && j.id) { j.dueAt = 0; _jobs.set(j.id, j); }
    for (const r of d.inflight || []) if (r && r.matchId) _inflight.set(r.matchId, r);
    if (_jobs.size || _inflight.size) console.log('[br] queue restored: ' + _jobs.size + ' job(s), ' + _inflight.size + ' match(es) in flight');
  } catch (e) { console.error('[br] ⚠️ QUEUE FILE UNREADABLE', e && e.message); }
}
function moneyAlert(msg) {
  console.error('[br] ⚠️ MONEY ALERT: ' + msg);
  const url = (process.env.BR_ALERT_URL || process.env.KART_ALERT_URL || '').trim();
  if (!url) return;
  try {
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '⚠️ BR ' + REGION + ': ' + msg }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch (_) {}
}
function enqueueJob(kind, id, proofBase, body, extra) {
  if (_jobs.has(id)) return _jobs.get(id);
  const job = Object.assign({ id, kind, proofBase, body, tries: 0, dueAt: 0, createdAt: Date.now(), lastErr: null }, extra || {});
  _jobs.set(id, job);
  return job;
}
function jobIsTerminal(job, res) {
  if (!res) return false;
  if (res.status === 400) return true;
  return false;
}
async function attemptJob(job) {
  const ts = Date.now();
  const proof = crypto.createHmac('sha256', GAME_SECRET).update(job.proofBase + ':' + ts).digest('hex');
  const r = await fetch(SETTLE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify(job.body),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: !!(r.ok && j && !j.error), body: j };
}
function deadLetter(job, why) {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(QUEUE_DEAD_FILE, 'utf8')) || []; } catch (_) { arr = []; }
    arr.push(Object.assign({}, job, { deadAt: Date.now(), why }));
    fs.writeFileSync(QUEUE_DEAD_FILE, JSON.stringify(arr));
  } catch (e) { console.error('[br] dead-letter write failed', e && e.message); }
  _jobs.delete(job.id);
  moneyAlert(job.kind + ' DEAD-LETTERED ' + job.id + ' after ' + job.tries + ' tries (' + why + ') — last: ' +
    (job.lastErr || '?') + '. Settle by hand; payload in ' + QUEUE_DEAD_FILE);
}
let _draining = false;
async function drainQueue(limit = 6) {
  if (_draining || !_jobs.size || !GAME_SECRET) return;
  _draining = true;
  try {
    const now = Date.now();
    const due = [..._jobs.values()].filter((j) => (j.dueAt || 0) <= now).slice(0, limit);
    for (const job of due) {
      if (!_jobs.has(job.id)) continue;
      let res = null;
      try { res = await attemptJob(job); }
      catch (e) { job.lastErr = 'network: ' + ((e && e.message) || 'failed'); }
      if (res && res.ok) {
        _jobs.delete(job.id);
        console.log('[br] ' + job.kind + ' CONFIRMED ' + job.id + ' ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 200));
        saveQueue();
        continue;
      }
      job.tries = (job.tries || 0) + 1;
      if (res) job.lastErr = res.status + ' ' + JSON.stringify(res.body).slice(0, 160);
      if (jobIsTerminal(job, res)) { deadLetter(job, 'refused permanently'); saveQueue(); continue; }
      if (job.tries >= JOB_MAX_TRIES) { deadLetter(job, 'retries exhausted'); saveQueue(); continue; }
      job.dueAt = now + Math.min(JOB_BACKOFF_MAX_MS, 2000 * job.tries);
      console.error('[br] ' + job.kind + ' RETRY ' + job.id + ' try=' + job.tries + ' :: ' + job.lastErr);
      saveQueue();
    }
  } finally { _draining = false; }
}

/*
 * Refund ONE player's entry for a match that has not started. Queued FIRST,
 * then the entry removed — same three-line ordering as kart's refundOne, and
 * the refundId is derived from WHEN THE ENTRY WAS PAID so retries are
 * idempotent at the far end.
 */
function refundOne(lb, pid, why) {
  if (!GAME_SECRET || !lb || !lb.paid) return;
  const pd = lb.paid.get(pid);
  if (!pd || !pd.address || !(pd.lamports > 0)) return;
  const refundId = (lb.id + ':' + pid + ':' + (pd.at || 0)).slice(0, 90);
  enqueueJob('refund', 'refund:' + refundId, 'kart-refund:' + refundId, {
    action: 'kart-refund', refundId,
    entries: [{ address: pd.address, lamports: Math.floor(pd.lamports) }],
  });
  lb.paid.delete(pid);
  retireTicket(pd.ticket);
  saveQueue();
  audit('REFUND_QUEUED', { lobby: lb.id, pid, refundId, lamports: Math.floor(pd.lamports), why });
  console.log('[br] refund QUEUED', refundId, why);
  drainQueue();
}
function refundUnstarted(lb, why) {
  if (!GAME_SECRET || !lb || !lb.paid || !lb.paid.size) return;
  for (const pid of [...lb.paid.keys()]) refundOne(lb, pid, why);
}
function refundInFlightMatch(matchId, why) {
  const rec = _inflight.get(matchId);
  if (!rec) return false;
  _inflight.delete(matchId);
  const entries = (rec.entries || []).filter((e) => e && e.address && e.lamports > 0);
  if (!entries.length) { saveQueue(); return false; }
  // Per-entry jobs with stable ids so one failing cannot hold up the rest —
  // and so a 16-entry match is never bounced by the backend's 8-entry cap.
  for (let i = 0; i < entries.length; i++) {
    const refundId = ('unresolved:' + matchId + ':' + i).slice(0, 90);
    enqueueJob('refund', 'refund:' + refundId, 'kart-refund:' + refundId,
      { action: 'kart-refund', refundId, entries: [entries[i]] });
  }
  saveQueue();
  moneyAlert('match ' + matchId + ' ' + why + ' — refunding ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies'));
  drainQueue();
  return true;
}
function recoverInFlight() {
  for (const matchId of [..._inflight.keys()]) refundInFlightMatch(matchId, 'was INTERRUPTED BY A RESTART');
}
function markMatchInFlight(lb) {
  if (!GAME_SECRET || !(lb.potLamports > 0) || !lb.entriesThisMatch) return;
  const entries = [];
  for (const pd of lb.entriesThisMatch.values()) {
    if (pd && pd.address && pd.lamports > 0) entries.push({ address: pd.address, lamports: Math.floor(pd.lamports) });
  }
  if (!entries.length) return;
  _inflight.set(lb.matchId, { matchId: lb.matchId, entries, potLamports: lb.potLamports, at: Date.now() });
  saveQueue();
}
/*
 * Pay a finished paid match: the winning team splits pot − 10% evenly.
 * Recorded as a queued job; the in-flight record is dropped in the SAME file
 * write, so a crash can leave a refund owed OR a payout owed — never both.
 */
function settleMatch(lb, winners) {
  if (!GAME_SECRET || !(lb.potLamports > 0) || !winners.length) return;
  enqueueJob('settle', 'settle:' + lb.matchId, 'kart-settle:' + lb.matchId + ':' + lb.potLamports,
    { action: 'kart-settle', raceId: lb.matchId, winners: winners.map((a) => ({ address: a })), potLamports: lb.potLamports });
  _inflight.delete(lb.matchId);
  saveQueue();
  audit('SETTLEMENT_QUEUED', { matchId: lb.matchId, potLamports: lb.potLamports, winners: winners.map((a) => a.slice(0, 8)) });
  console.log('[br] settle QUEUED', lb.matchId, lb.potLamports + ' lamports to ' + winners.length + ' winner(s)');
  drainQueue();
}

// ═══════════════════════════════════════════════════════════════════════════
// LOBBIES
// ═══════════════════════════════════════════════════════════════════════════
const MODES = { solo: 1, duos: 2, trios: 3, quads: 4 };
const ABS_MAX = 16;
const COUNTDOWN_MS = 5000;
const MATCH_TIMEOUT_MS = 22 * 60 * 1000;
const EMPTY_LOBBY_TTL = 30 * 1000;
const RECONNECT_GRACE_MS = 90 * 1000;
const RESULTS_MS = 12000;
const MIN_STAKE_C = 10, MAX_STAKE_C = 50000;

const lobbies = new Map();
let nextLobbyNum = 1;

/*
 * AUDIT LOG — money is involved, so every consequential event is one JSON
 * line on disk with ids and a timestamp. Append-only; rotated by size so it
 * can never fill the disk. This is what makes a wager dispute answerable.
 */
const AUDIT_FILE = path.join(__dirname, 'br-audit-' + REGION + '.log');
function audit(event, fields) {
  try {
    try { const st = fs.statSync(AUDIT_FILE); if (st.size > 20 * 1024 * 1024) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1'); } catch (_) {}
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(Object.assign({ ev: event, ts: Date.now(), region: REGION }, fields || {})) + '\n');
  } catch (e) { console.error('[br] audit write failed', e && e.message); }
}

function normStake(v) {
  const c = Math.round((Number(v) || 0) * 100);
  if (!isFinite(c) || c <= 0) return 0;
  return Math.max(MIN_STAKE_C, Math.min(MAX_STAKE_C, c));
}
function maxFor(mode) { const ts = MODES[mode] || 1; return ts * Math.floor(ABS_MAX / ts); }

function makeLobby(opts) {
  const mode = MODES[opts.mode] ? opts.mode : 'solo';
  const teamSize = MODES[mode];
  const cap = maxFor(mode);
  let maxPlayers = Math.floor(Number(opts.maxPlayers) || cap);
  maxPlayers = Math.max(2, Math.min(cap, maxPlayers));
  // round UP to a whole number of teams so the creator's cap is always a valid configuration
  if (teamSize > 1) maxPlayers = Math.min(cap, Math.ceil(maxPlayers / teamSize) * teamSize);
  const stakeCents = normStake(opts.stake);
  const id = 'br-' + (nextLobbyNum++);
  const lb = {
    id,
    name: String(opts.name || '').slice(0, 28) || ((stakeCents ? '$' + (stakeCents / 100) + ' ' : '') + mode.toUpperCase() + ' match'),
    mode, teamSize,
    maxTeams: Math.floor(maxPlayers / teamSize) || 1,
    maxPlayers,
    isPrivate: !!opts.isPrivate,
    stakeCents,
    hostPid: opts.hostPid || null,
    joinMode: opts.joinMode === 'approve' ? 'approve' : 'open',   // approve = challenge/accept/deny
    state: 'lobby',              // lobby -> countdown -> playing -> done -> lobby
    players: new Map(),          // pid -> P (lobby members AND match entities)
    spectators: new Set(),       // socket ids watching only
    challenges: new Map(), nextCid: 1,   // cid -> pending challenge
    nextQueue: new Map(),        // pid -> { name, skin } — READY FOR NEXT while a match runs
    paid: new Map(),             // pid -> { cents, address, lamports, ticket, at }
    mapSeed: (Math.random() * 0xffffffff) >>> 0,
    map: null,
    loot: new Map(), nextIid: 1,
    zone: null,
    startAt: 0, tStart: 0, matchId: null,
    potCents: 0, potLamports: 0, entriesThisMatch: null,
    teamsAliveAtStart: 0, placementsLeft: 0,
    results: null,
    emptySince: Date.now(), createdAt: Date.now(),
  };
  lobbies.set(id, lb);
  return lb;
}

let nextN = 1;
function makePlayer(pid, sid, name, skin) {
  return {
    pid, sid, n: nextN++,
    name: String(name || 'Player').slice(0, 16),
    skin: Math.max(0, Math.min(7, Number(skin) || 0)),
    team: 0, ready: false,
    // match state
    inMatch: false, state: 'out', hp: 0, shield: 0, downHp: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    crouching: false, grounded: true, jumpLock: false,
    inv: [], slot: 0, ammo: { light: 0, medium: 0, heavy: 0, shells: 0 },
    useT: 0, useSlot: -1, reviveT: 0, reviveTgt: null, reloadT: 0,
    lastFire: 0, bloom: 0,
    kills: 0, dmg: 0, place: 0,
    input: { f: 0, s: 0, yaw: 0, pitch: 0, seq: 0 },
    lastDamager: null, lastDamageAt: 0,
    lastPacket: Date.now(), packetCount: 0, packetWindow: Date.now(),
    disconnectedAt: 0,
  };
}

function teamCounts(lb) {
  const c = new Array(lb.maxTeams).fill(0);
  for (const p of lb.players.values()) if (c[p.team] != null) c[p.team]++;
  return c;
}
function autoTeam(lb) {
  const c = teamCounts(lb);
  let best = 0, bestN = Infinity;
  for (let i = 0; i < lb.maxTeams; i++) if (c[i] < lb.teamSize && c[i] < bestN) { best = i; bestN = c[i]; }
  return bestN === Infinity ? -1 : best;
}

/*
 * CHALLENGES — the approve-to-join flow. A challenge is a REQUEST holding no
 * money: nobody is charged at any point in it (charging happens only at
 * READY, after the player is in the room). Deny → it disappears, no balance
 * touched. Accept → the server re-validates room state and space at THAT
 * moment (first accept wins the last slot; the loser is told, not charged).
 */
function voidChallenge(lb, cid, why) {
  const ch = lb.challenges && lb.challenges.get(cid);
  if (!ch) return;
  lb.challenges.delete(cid);
  const s2 = io.sockets.sockets.get(ch.sid);
  if (s2) s2.emit('br-challenge-out', { cid, accepted: false, why });
  audit('CHALLENGE_VOID', { lobby: lb.id, cid, pid: ch.pid, why });
}
function pushChallenges(lb) {
  const host = [...lb.players.values()].find((p) => p.pid === lb.hostPid);
  const s2 = host && host.sid && io.sockets.sockets.get(host.sid);
  if (!s2) return;
  s2.emit('br-challenges', {
    list: [...lb.challenges.values()].map((c) => ({ cid: c.cid, name: c.name, at: c.at })),
    stakeCents: lb.stakeCents,
  });
}

function lobbySummary(lb) {
  const readyN = [...lb.players.values()].filter((p) => p.ready).length;
  return {
    id: lb.id, name: lb.name, state: lb.state, mode: lb.mode, teamSize: lb.teamSize,
    stakeCents: lb.stakeCents, stakeUsd: lb.stakeCents / 100,
    players: lb.players.size, maxPlayers: lb.maxPlayers, ready: readyN,
    spectators: lb.spectators.size, joinMode: lb.joinMode,
    potCents: lb.state === 'lobby' ? lb.stakeCents * lb.paid.size : lb.potCents,
    private: lb.isPrivate,
  };
}
function listLobbies() {
  const out = [];
  for (const lb of lobbies.values()) {
    if (lb.isPrivate) continue;
    // An empty room is not an open match — it is a room on its way to being
    // reaped. Advertising it just sends people into a lobby nobody is in.
    if (lb.players.size === 0 && lb.spectators.size === 0) continue;
    out.push(lobbySummary(lb));
  }
  out.sort((a, b) => b.players - a.players);
  return out;
}
function broadcastLobbyList() { io.emit('br-lobbies', { lobbies: listLobbies(), region: REGION }); }

function roster(lb) {
  const out = [];
  for (const p of lb.players.values()) {
    out.push({
      n: p.n, name: p.name, skin: p.skin, team: p.team, ready: !!p.ready,
      host: p.pid === lb.hostPid, connected: !!p.sid,
      paid: lb.paid.has(p.pid),
      state: p.state, kills: p.kills, place: p.place,
    });
  }
  return out;
}
function sendState(lb) {
  const payload = {
    state: lb.state, mode: lb.mode, teamSize: lb.teamSize, maxTeams: lb.maxTeams,
    maxPlayers: lb.maxPlayers, stakeCents: lb.stakeCents, private: lb.isPrivate,
    id: lb.id, name: lb.name, region: REGION,
    startAt: lb.startAt, mapSeed: lb.mapSeed,
    potCents: lb.state === 'lobby' ? lb.stakeCents * lb.paid.size : lb.potCents,
    roster: roster(lb),
  };
  io.to(lb.id).emit('br-state', payload);
}

// ── per-player private sync: inventory + ammo, sent only on change ─────────
function sendInv(lb, p) {
  if (!p.sid) return;
  const s = io.sockets.sockets.get(p.sid);
  if (!s) return;
  s.emit('br-inv', {
    inv: p.inv.map((it) => it ? { k: it.kind, t: it.tier, m: it.mag, q: it.qty } : null),
    slot: p.slot, ammo: p.ammo,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCH LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════
/*
 * The state machine is deliberately strict:
 *   lobby -> countdown -> playing -> done -> lobby
 * tryStart validates config + payment; endMatch is the ONLY place a winner is
 * decided and is guarded so it runs once per match.
 */
/*
 * START VALIDATION — the owner's rules, enforced by what goes on the field:
 *   SOLO:  at least 2 ready (and, in a paid room, PAID) players.
 *   TEAMS: at least 2 COMPLETE opposing teams — a team counts only when it
 *          has exactly teamSize members, every one connected, ready and paid.
 *          A duo of one is not a duo; it stays in the lobby and waits.
 * One ready player/team can NEVER start a match. The client's opinion of
 * "2/2 ready" is decoration; this function is the authority.
 */
function canStart(lb) {
  if (lb.state !== 'lobby') return { ok: false, why: 'not in lobby' };
  const eligible = (p) => p.ready && p.sid && (lb.stakeCents <= 0 || lb.paid.has(p.pid));
  if (lb.teamSize === 1) {
    const field = [...lb.players.values()].filter(eligible);
    if (field.length < 2) return { ok: false, why: 'Waiting for an opponent — ' + field.length + '/2 ready' + (lb.stakeCents > 0 ? ' & paid' : '') + '.' };
    return { ok: true, field };
  }
  const byTeam = new Map();
  for (const p of lb.players.values()) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const completeTeams = [];
  for (const [t, members] of byTeam) {
    if (members.length === lb.teamSize && members.every(eligible)) completeTeams.push(members);
  }
  if (completeTeams.length < 2) {
    return { ok: false, why: 'Need 2 complete ' + lb.mode + ' teams (' + lb.teamSize + ' ready' + (lb.stakeCents > 0 ? ' & paid' : '') + ' players each) — ' + completeTeams.length + ' ready now.' };
  }
  return { ok: true, field: completeTeams.flat() };
}

function startMatch(lb) {
  // ATOMIC: node is single-threaded and the first line re-checks the state,
  // so two simultaneous START presses collapse to one transition — the second
  // finds 'countdown' and is refused. A match can never start twice.
  const chk = canStart(lb);
  if (!chk.ok) return chk;
  const field = chk.field;
  // In a paid lobby, strip ready from anyone unpaid (kart's tryStart rule) —
  // they are not in the field and must not be on the grid.
  if (lb.stakeCents > 0) {
    for (const p of lb.players.values()) if (p.ready && !lb.paid.has(p.pid)) p.ready = false;
  }
  lb.mapSeed = (Math.random() * 0xffffffff) >>> 0;
  lb.map = BR.genMap(lb.mapSeed);
  lb.state = 'countdown';
  lb.startAt = Date.now() + COUNTDOWN_MS;
  lb.fieldPids = new Set(field.map((p) => p.pid));
  // From this moment the room is LOCKED: joinLobby refuses new players in any
  // non-'lobby' state, challenges are auto-void, and the field cannot change.
  for (const [cid, ch] of lb.challenges || []) voidChallenge(lb, cid, 'match locked');
  audit('MATCH_LOCKED', { lobby: lb.id, players: [...lb.fieldPids], stakeCents: lb.stakeCents });
  sendState(lb);
  broadcastLobbyList();
  return { ok: true };
}

function rollLoot(lb) {
  const rnd = BR.mulberry32((lb.mapSeed ^ 0x9e3779b9) >>> 0);
  const guns = ['pistol', 'smg', 'ar', 'burst', 'tacshot', 'shotgun', 'sniper', 'handcannon'];
  const gunW = [0.17, 0.17, 0.19, 0.12, 0.13, 0.12, 0.05, 0.05];
  const cons = ['bandage', 'medkit', 'shieldsm', 'shieldbig'];
  const consW = [0.4, 0.15, 0.3, 0.15];
  function pick(list, w) {
    let r = rnd(), acc = 0;
    for (let i = 0; i < list.length; i++) { acc += w[i]; if (r <= acc) return list[i]; }
    return list[0];
  }
  // rarity roll clamped to what this weapon actually drops at (floor loot skews low)
  function tier(gun, lucky) {
    const [lo, hi] = BR.WEAPON_TIERS[gun] || [0, 4];
    const r = rnd() + (lucky ? 0.25 : 0);
    const t = r < 0.45 ? 0 : r < 0.72 ? 1 : r < 0.9 ? 2 : r < 0.98 ? 3 : 4;
    return Math.max(lo, Math.min(hi, t));
  }
  function addItem(x, y, z, kind, extra) {
    const iid = lb.nextIid++;
    const it = Object.assign({ iid, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), kind }, extra || {});
    lb.loot.set(iid, it);
    return it;
  }
  // chests are interactable containers; contents roll when opened
  for (const c of lb.map.chests) addItem(c.x, c.y, c.z, 'chest', { opened: false });
  // floor loot: a gun or a consumable or ammo, lying in the open
  for (const f of lb.map.floorLoot) {
    const r = rnd();
    if (r < 0.45) { const g = pick(guns, gunW); addItem(f.x, f.y, f.z, g, { tier: tier(g, false), gun: true }); }
    else if (r < 0.72) { const cn = pick(cons, consW); addItem(f.x, f.y, f.z, cn, { qty: cn === 'bandage' ? 5 : 1 }); }
    else { const a = BR.AMMO_KINDS[Math.floor(rnd() * 4)]; addItem(f.x, f.y, f.z, 'ammo', { ammo: a, qty: BR.AMMO_PICKUP[a] }); }
  }
}

function beginPlay(lb) {
  lb.state = 'playing';
  lb.tStart = Date.now();
  lb.matchId = lb.id + ':' + lb.tStart;
  lb.loot = new Map(); lb.nextIid = 1;
  rollLoot(lb);

  // Snapshot the pot from entries actually collected (kart's rule) and record
  // it durable BEFORE anything can happen to it.
  lb.potCents = 0; lb.potLamports = 0;
  lb.entriesThisMatch = new Map();
  if (lb.stakeCents > 0) {
    for (const pid of lb.fieldPids) {
      const pd = lb.paid.get(pid);
      if (!pd) continue;
      lb.entriesThisMatch.set(pid, pd);
      lb.potCents += pd.cents;
      lb.potLamports += Math.max(0, Math.floor(pd.lamports || 0));
    }
    for (const pd of lb.entriesThisMatch.values()) retireTicket(pd.ticket);
    for (const pid of lb.entriesThisMatch.keys()) lb.paid.delete(pid);
    markMatchInFlight(lb);
  }

  // Spawn the field on perimeter pads, one pad cluster per team.
  const byTeam = new Map();
  for (const pid of lb.fieldPids) {
    const p = lb.players.get(pid);
    if (!p || !p.sid) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const teamIds = [...byTeam.keys()];
  lb.teamsAliveAtStart = teamIds.length;
  lb.placementsLeft = teamIds.length;
  // Snapshot the field for the RESULTS table — a player who leaves mid-match
  // is removed from lb.players, but their row (and their loss) still happened.
  lb.matchRoster = [];
  for (const pid of lb.fieldPids) {
    const p = lb.players.get(pid);
    if (p) lb.matchRoster.push({ pid, n: p.n, name: p.name, team: p.team });
  }
  const padStep = Math.max(1, Math.floor(lb.map.pads.length / teamIds.length));
  teamIds.forEach((tid, i) => {
    const pad = lb.map.pads[(i * padStep) % lb.map.pads.length];
    byTeam.get(tid).forEach((p, j) => {
      p.inMatch = true; p.state = 'alive';
      p.hp = BR.MAX_HP; p.shield = 0; p.downHp = 0;
      p.x = pad.x + Math.cos(j * 2.1) * 2.2; p.z = pad.z + Math.sin(j * 2.1) * 2.2; p.y = 0;
      p.vx = 0; p.vy = 0; p.vz = 0; p.yaw = pad.a; p.pitch = 0;
      p.inv = [{ kind: 'melee', tier: 0, mag: 0 }, null, null, null, null];
      p.slot = 0;
      p.ammo = { light: 0, medium: 0, heavy: 0, shells: 0 };
      p.useT = 0; p.reviveT = 0; p.reloadT = 0; p.bloom = 0;
      p.kills = 0; p.dmg = 0; p.place = 0; p.lastDamager = null;
      sendInv(lb, p);
    });
  });
  // Everyone in the room who is NOT in the field spectates this match.
  for (const p of lb.players.values()) if (!lb.fieldPids.has(p.pid)) { p.inMatch = false; p.state = 'out'; p.ready = false; }

  // The zone
  lb.zone = {
    cx: 0, cz: 0, r: BR.ZONE_R0,
    phase: 0, mode: 'wait',
    tNext: Date.now() + BR.ZONE_PHASES[0].wait * 1000,
    from: null, to: null, tMove0: 0, tMove1: 0,
    dps: BR.ZONE_PHASES[0].dps,
  };
  pickZoneTarget(lb);

  audit('MATCH_STARTED', { lobby: lb.id, matchId: lb.matchId, players: [...lb.fieldPids], potLamports: lb.potLamports, potCents: lb.potCents });
  io.to(lb.id).emit('br-begin', {
    matchId: lb.matchId, mapSeed: lb.mapSeed, tStart: lb.tStart,
    loot: [...lb.loot.values()],
    zone: zonePacket(lb),
  });
  sendState(lb);
  broadcastLobbyList();
}

function pickZoneTarget(lb) {
  const z = lb.zone, ph = BR.ZONE_PHASES[z.phase];
  if (!ph) return;
  const newR = z.r * ph.r;
  // new centre stays inside the current circle so the next zone is reachable
  const a = Math.random() * Math.PI * 2, d = Math.random() * Math.max(0, z.r - newR) * 0.8;
  z.to = { cx: z.cx + Math.cos(a) * d, cz: z.cz + Math.sin(a) * d, r: newR };
}
function zonePacket(lb) {
  const z = lb.zone;
  return z ? {
    cx: +z.cx.toFixed(1), cz: +z.cz.toFixed(1), r: +z.r.toFixed(1),
    phase: z.phase, mode: z.mode, tNext: z.tNext, dps: z.dps,
    to: z.to ? { cx: +z.to.cx.toFixed(1), cz: +z.to.cz.toFixed(1), r: +z.to.r.toFixed(1) } : null,
  } : null;
}
function tickZone(lb, now) {
  const z = lb.zone;
  if (!z) return;
  const ph = BR.ZONE_PHASES[z.phase];
  if (!ph) return;
  if (z.mode === 'wait' && now >= z.tNext) {
    z.mode = 'move'; z.from = { cx: z.cx, cz: z.cz, r: z.r };
    z.tMove0 = now; z.tMove1 = now + ph.move * 1000;
    io.to(lb.id).emit('br-zone', zonePacket(lb));
  } else if (z.mode === 'move') {
    const t = Math.min(1, (now - z.tMove0) / (z.tMove1 - z.tMove0));
    z.cx = z.from.cx + (z.to.cx - z.from.cx) * t;
    z.cz = z.from.cz + (z.to.cz - z.from.cz) * t;
    z.r = z.from.r + (z.to.r - z.from.r) * t;
    if (t >= 1) {
      z.phase++;
      const nph = BR.ZONE_PHASES[z.phase];
      if (nph) {
        z.mode = 'wait'; z.tNext = now + nph.wait * 1000; z.dps = nph.dps;
        pickZoneTarget(lb);
      } else { z.mode = 'hold'; z.dps = 10; }   // era-correct cap — see ZONE_PHASES note
      io.to(lb.id).emit('br-zone', zonePacket(lb));
    }
  }
}

// ── damage / downs / deaths ────────────────────────────────────────────────
function aliveTeams(lb) {
  const t = new Set();
  for (const p of lb.players.values()) {
    if (p.inMatch && (p.state === 'alive' || p.state === 'down')) t.add(p.team);
  }
  return t;
}
function teammatesUp(lb, p) {
  for (const o of lb.players.values()) {
    if (o !== p && o.inMatch && o.team === p.team && o.state === 'alive') return true;
  }
  return false;
}
function dropInventory(lb, p) {
  const drops = [];
  for (const it of p.inv) {
    if (!it || it.kind === 'melee') continue;
    const iid = lb.nextIid++;
    const a = Math.random() * Math.PI * 2;
    const item = it.gun !== false && BR.WEAPONS[it.kind] && it.kind !== 'melee' && !BR.CONSUMABLES[it.kind]
      ? { iid, x: +(p.x + Math.cos(a) * 0.8).toFixed(2), y: +p.y.toFixed(2), z: +(p.z + Math.sin(a) * 0.8).toFixed(2), kind: it.kind, tier: it.tier, gun: true, mag: it.mag }
      : { iid, x: +(p.x + Math.cos(a) * 0.8).toFixed(2), y: +p.y.toFixed(2), z: +(p.z + Math.sin(a) * 0.8).toFixed(2), kind: it.kind, qty: it.qty || 1 };
    lb.loot.set(iid, item);
    drops.push(item);
  }
  for (const k of BR.AMMO_KINDS) {
    if (p.ammo[k] > 0) {
      const iid = lb.nextIid++;
      const a = Math.random() * Math.PI * 2;
      const item = { iid, x: +(p.x + Math.cos(a) * 1.1).toFixed(2), y: +p.y.toFixed(2), z: +(p.z + Math.sin(a) * 1.1).toFixed(2), kind: 'ammo', ammo: k, qty: p.ammo[k] };
      lb.loot.set(iid, item);
      drops.push(item);
    }
  }
  p.inv = []; p.ammo = { light: 0, medium: 0, heavy: 0, shells: 0 };
  if (drops.length) io.to(lb.id).emit('br-loot-add', drops);
}
function eliminate(lb, p, killer, weapon) {
  p.state = 'dead';
  audit('PLAYER_ELIMINATED', { lobby: lb.id, matchId: lb.matchId, pid: p.pid, by: killer ? killer.pid : null, w: weapon || '' });
  dropInventory(lb, p);
  io.to(lb.id).emit('br-kill', {
    vn: p.n, kn: killer ? killer.n : 0, w: weapon || '', down: false,
  });
  if (killer && killer !== p) killer.kills++;
  // whole team gone? assign placement to every member
  const teamAlive = [...lb.players.values()].some((o) => o.inMatch && o.team === p.team && (o.state === 'alive' || o.state === 'down'));
  if (!teamAlive) {
    const place = lb.placementsLeft;
    lb.placementsLeft--;
    for (const o of lb.players.values()) if (o.inMatch && o.team === p.team) o.place = place;
  }
  checkWin(lb);
}
function applyDamage(lb, victim, dmg, attacker, weapon, head) {
  if (!victim.inMatch || victim.state === 'dead' || victim.state === 'out') return 0;
  if (lb.state !== 'playing') return 0;
  let dealt = 0;
  if (victim.state === 'down') {
    victim.downHp -= dmg; dealt = dmg;
    if (victim.downHp <= 0) eliminate(lb, victim, attacker || victim.lastDamager, weapon);
  } else {
    const fromShield = Math.min(victim.shield, dmg);
    victim.shield -= fromShield;
    const rest = dmg - fromShield;
    victim.hp -= rest;
    dealt = dmg;
    if (victim.hp <= 0) {
      victim.hp = 0;
      // team modes: go DOWN if a teammate is still standing, else die outright
      if (lb.teamSize > 1 && teammatesUp(lb, victim)) {
        victim.state = 'down'; victim.downHp = BR.DOWN_HP;
        victim.useT = 0; victim.reloadT = 0; victim.reviveT = 0;
        io.to(lb.id).emit('br-kill', { vn: victim.n, kn: attacker ? attacker.n : 0, w: weapon || '', down: true });
      } else {
        eliminate(lb, victim, attacker, weapon);
      }
    }
  }
  if (attacker && attacker !== victim) { attacker.dmg += dealt; victim.lastDamager = attacker; victim.lastDamageAt = Date.now(); }
  // tell the victim (hit direction flash) — and the attacker (hitmarker) via br-shot already
  if (victim.sid) {
    const s = io.sockets.sockets.get(victim.sid);
    // `w` lets the client tell storm ticks from real hits — the storm used to fire
    // the full hit sound + shake EVERY tick, which as a repeating alarm was unbearable.
    if (s) s.emit('br-dmg', { d: Math.round(dealt), fn: attacker ? attacker.n : 0, hs: !!head, w: weapon || '' });
  }
  return dealt;
}

function checkWin(lb) {
  if (lb.state !== 'playing') return;
  const teams = aliveTeams(lb);
  if (teams.size > 1) return;
  endMatch(lb, teams.size === 1 ? [...teams][0] : null, 'last team standing');
}

/*
 * THE ONLY PLACE A WINNER IS DECIDED. Server-validated state in, settlement
 * out. Guarded by the state flip so it can run exactly once per match.
 */
function endMatch(lb, winTeam, why) {
  if (lb.state !== 'playing') return;
  lb.state = 'done';

  const winners = [];      // pids
  for (const p of lb.players.values()) {
    if (p.inMatch && p.team === winTeam && (p.state === 'alive' || p.state === 'down')) { p.place = 1; }
    if (p.inMatch && p.team === winTeam) winners.push(p);
  }
  // anyone still alive on the winning team gets place 1 set above; ensure all
  // winning-team members (even dead ones) rank 1 for the results screen
  for (const p of winners) p.place = 1;

  // ── MONEY ──
  if (lb.potLamports > 0 && lb.entriesThisMatch) {
    const winAddrs = [];
    for (const p of winners) {
      const pd = lb.entriesThisMatch.get(p.pid);
      if (pd && pd.address) winAddrs.push(pd.address);
    }
    if (winTeam != null && winAddrs.length) {
      settleMatch(lb, winAddrs);
    } else {
      // No winner (everyone left / wiped simultaneously) — the pot goes back.
      refundInFlightMatch(lb.matchId, 'ended with no payable winner');
    }
  }

  // results table — from the roster snapshot, so leavers still show their loss
  const rows = (lb.matchRoster || []).map((r) => {
    const p = lb.players.get(r.pid);
    return {
      n: r.n, name: r.name, team: r.team,
      place: p ? (p.place || lb.placementsLeft || 0) : 0,
      kills: p ? p.kills : 0, dmg: p ? Math.round(p.dmg) : 0,
      win: r.team === winTeam, left: !p,
    };
  }).sort((a, b) => (b.win ? 1 : 0) - (a.win ? 1 : 0) || (a.place || 99) - (b.place || 99) || b.kills - a.kills);
  const fee = Math.floor(lb.potLamports * 0.10);
  const share = winners.length ? Math.floor((lb.potLamports - fee) / Math.max(1, winners.filter((p) => lb.entriesThisMatch && lb.entriesThisMatch.get(p.pid)).length)) : 0;
  lb.results = {
    winTeam, why, rows, potCents: lb.potCents, stakeCents: lb.stakeCents,
    potLamports: lb.potLamports, shareLamports: share, mode: lb.mode,
  };
  audit('MATCH_FINISHED', { lobby: lb.id, matchId: lb.matchId, winTeam, why, potLamports: lb.potLamports });
  io.to(lb.id).emit('br-end', lb.results);
  lb.potCents = 0; lb.potLamports = 0; lb.entriesThisMatch = null;

  console.log('[br] match ' + lb.matchId + ' ended (' + why + ') winTeam=' + winTeam);

  // Back to the lobby: keep people, keep teams, clear ready — PLAY AGAIN is
  // just readying up again in the same room.
  setTimeout(() => {
    if (!lobbies.has(lb.id)) return;
    lb.state = 'lobby';
    lb.startAt = 0; lb.matchId = null; lb.zone = null; lb.loot = new Map();
    for (const p of lb.players.values()) {
      p.ready = false; p.inMatch = false; p.state = 'out'; p.place = 0;
      p.kills = 0; p.dmg = 0;
      // players who disconnected mid-match and never came back leave the room now
      if (!p.sid) removePlayer(lb, p.pid, 'gone after match');
    }
    // Promote the READY FOR NEXT queue into real seats, in queue order, while
    // space lasts. They arrive UN-ready and UN-charged: the normal ready/pay
    // flow is still the only path onto the field.
    for (const [pid, q] of lb.nextQueue) {
      if (lb.players.size >= lb.maxPlayers) break;
      const s2 = q.sid && io.sockets.sockets.get(q.sid);
      if (!s2 || s2.data.pid !== pid || s2.data.lobbyId !== lb.id) continue;
      const p = makePlayer(pid, s2.id, q.name, q.skin);
      const t = autoTeam(lb);
      if (t < 0) break;
      p.team = t;
      lb.players.set(pid, p);
      lb.spectators.delete(s2.id);
      s2.emit('br-joined', { id: lb.id, yourN: p.n });
      s2.emit('br-notice', { msg: 'You are in the next match — pick a team and ready up.' });
      audit('PLAYER_JOINED', { lobby: lb.id, pid, n: p.n, via: 'next-queue' });
    }
    lb.nextQueue.clear();
    sendState(lb);
    broadcastLobbyList();
  }, RESULTS_MS);
}

// ── leaving / disconnect ───────────────────────────────────────────────────
function removePlayer(lb, pid, why) {
  const p = lb.players.get(pid);
  if (!p) return;
  // leaving an UNSTARTED paid match refunds; leaving mid-match forfeits (owner
  // rule, all games: once the wager is in it is locked until the match resolves)
  if (lb.state === 'lobby') refundOne(lb, pid, why);
  lb.players.delete(pid);
  if (lb.hostPid === pid) {
    // host migration: oldest remaining member becomes host
    const first = [...lb.players.values()][0];
    lb.hostPid = first ? first.pid : null;
  }
  if (lb.players.size === 0 && lb.spectators.size === 0) {
    lb.emptySince = Date.now();
    if (lb.state === 'lobby') refundUnstarted(lb, 'room emptied');
  }
  // a mid-match departure may hand the win to the last remaining team
  if (lb.state === 'playing') {
    if (p.inMatch && (p.state === 'alive' || p.state === 'down')) {
      p.state = 'dead';
      io.to(lb.id).emit('br-kill', { vn: p.n, kn: 0, w: 'left', down: false });
      checkWin(lb);
    }
    if (![...lb.players.values()].some((o) => o.inMatch && o.sid)) {
      // every connected participant is gone — resolve rather than hang
      endMatch(lb, null, 'everyone left');
    }
  }
  sendState(lb);
  broadcastLobbyList();
}

function leaveLobby(sock, why) {
  const lb = lobbies.get(sock.data.lobbyId);
  if (!lb) return;
  lb.spectators.delete(sock.id);
  if (lb.nextQueue) lb.nextQueue.delete(sock.data.pid);
  const pid = sock.data.pid;
  const p = pid ? lb.players.get(pid) : null;
  if (p && p.sid === sock.id) {
    /*
     * Two very different departures share this function:
     *  - an explicit LEAVE (why='left') is a choice — mid-match it forfeits on
     *    the spot (no refund; the stake is in the pot) and can hand the win to
     *    the last remaining team.
     *  - a transport drop gets the reconnect grace: the entity stays, idling,
     *    reclaimable by pid, because a network blip must not decide a wager.
     */
    if (why !== 'left' && lb.state !== 'lobby' && p.inMatch && (p.state === 'alive' || p.state === 'down')) {
      // mid-match disconnect: keep the entity for the reconnect window rather
      // than deleting a live player (and their stake) on a network blip
      p.sid = null;
      p.disconnectedAt = Date.now();
      p.input = { f: 0, s: 0, yaw: p.yaw, pitch: p.pitch, seq: p.input.seq };
      sendState(lb);
    } else {
      removePlayer(lb, pid, why || 'left');
    }
  }
  sock.leave(lb.id);
  sock.data.lobbyId = null;
  if (lb.players.size === 0 && lb.spectators.size === 0) lb.emptySince = Date.now();
  broadcastLobbyList();
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP — health / lobbies / queue (public, counts only)
// ═══════════════════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/health' || url === '/br/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    // `players` counts everyone sitting in a room; `playing` counts only bodies on a live
    // field. The games page used to print members as "in game", so two people idling in a
    // lobby read as an active match to everyone else.
    let members = 0, playing = 0;
    for (const l of lobbies.values()) {
      members += l.players.size;
      if (l.state === 'playing' || l.state === 'countdown') {
        for (const p of l.players.values()) if (p.inMatch && p.sid) playing++;
      }
    }
    return res.end(JSON.stringify({
      ok: true, region: REGION, lobbies: lobbies.size,
      players: members, playing,
      up: Math.round(process.uptime()),
      moneyQueue: _jobs.size, matchesInFlight: _inflight.size,
      fees: ENTRY_FEES_ENABLED,
    }));
  }
  if (url === '/lobbies' || url === '/br/lobbies') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, region: REGION, lobbies: listLobbies() }));
  }
  if (url === '/queue' || url === '/br/queue') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const now = Date.now();
    let dead = [];
    try { dead = JSON.parse(fs.readFileSync(QUEUE_DEAD_FILE, 'utf8')) || []; } catch (_) { dead = []; }
    const jobs = [..._jobs.values()];
    return res.end(JSON.stringify({
      ok: true, region: REGION, pending: jobs.length,
      dueNow: jobs.filter((j) => (j.dueAt || 0) <= now).length,
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, tries: j.tries, ageSec: Math.round((now - (j.createdAt || now)) / 1000), lastErr: j.lastErr })),
      matchesInFlight: _inflight.size,
      deadLettered: dead.length, deadIds: dead.slice(-20).map((d) => d.id),
    }));
  }
  res.writeHead(404); res.end('br');
});

const io = new Server(server, {
  path: '/br/socket.io',
  transports: ['websocket', 'polling'],   // websocket FIRST — snake's lesson
  cors: { origin: true, credentials: false },
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5,
});

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
io.on('connection', (sock) => {
  sock.data.lobbyId = null;
  sock.data.pid = null;
  sock.data.joinedAt = Date.now();

  /*
   * IDENTITY. The client presents a persistent random token (its pid) at
   * hello. Everything about a player — seat, team, paid entry, live body —
   * keys off the pid, never the socket id, which is what makes reconnect a
   * rebind instead of a new person. The pid is client-random; it is NOT an
   * auth secret for money (tickets carry the wallet binding), it only names
   * a session identity, so client-random is sufficient and needs no server
   * round trip.
   */
  sock.on('br-hello', (d) => {
    d = d || {};
    const pid = String(d.pid || '').slice(0, 64);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(pid)) { sock.emit('br-notice', { msg: 'Bad session token — reload.' }); return; }
    sock.data.pid = pid;
    sock.emit('br-hello', { region: REGION, ok: true });
    sock.emit('br-lobbies', { lobbies: listLobbies(), region: REGION });

    // RECONNECT: if any lobby still holds a live entity for this pid, rebind.
    for (const lb of lobbies.values()) {
      const p = lb.players.get(pid);
      if (p && !p.sid) {
        p.sid = sock.id;
        p.disconnectedAt = 0;
        sock.join(lb.id);
        sock.data.lobbyId = lb.id;
        sock.emit('br-rejoined', { id: lb.id });
        sendState(lb);
        if (lb.state === 'playing' || lb.state === 'countdown') {
          sock.emit('br-begin', {
            matchId: lb.matchId, mapSeed: lb.mapSeed, tStart: lb.tStart,
            loot: [...lb.loot.values()], zone: zonePacket(lb), rejoin: true,
          });
          sendInv(lb, p);
        }
        return;
      }
    }
  });

  sock.on('br-list', () => sock.emit('br-lobbies', { lobbies: listLobbies(), region: REGION }));

  sock.on('br-create', (d) => {
    d = d || {};
    if (!sock.data.pid) return sock.emit('br-notice', { msg: 'Say hello first — reload.' });
    if (lobbies.size >= 60) return sock.emit('br-notice', { msg: 'Too many lobbies open right now.' });
    const lb = makeLobby({
      mode: String(d.mode || 'solo'), stake: d.stake, maxPlayers: d.maxPlayers,
      isPrivate: !!d.isPrivate, name: String(d.name || ''), hostPid: sock.data.pid,
      joinMode: d.joinMode,
    });
    audit('MATCH_CREATED', { lobby: lb.id, pid: sock.data.pid, mode: lb.mode, stakeCents: lb.stakeCents, maxPlayers: lb.maxPlayers, joinMode: lb.joinMode, private: lb.isPrivate });
    joinLobby(sock, lb, d);
    sock.emit('br-created', { id: lb.id });
    broadcastLobbyList();
  });

  /*
   * JOINING — the locked-room rules, enforced here and only here:
   *  - state !== 'lobby'  → the match is LOCKED. Old links, refreshes, raw
   *    socket calls, whatever: you spectate, with READY FOR NEXT available.
   *    (Exception: a pid that is already IN lb.players — a reconnecting
   *    participant — rebinds; that is the whole point of pids.)
   *  - full room → spectate, never a hard error and never a charge.
   *  - approve-mode room → new players do not enter directly; they file a
   *    challenge the host must ACCEPT. Nothing about a challenge moves money.
   * Slot races resolve here atomically: node runs handlers one at a time, so
   * the first join to find space gets it and the second finds the room full.
   */
  function joinLobby(s2, lb, d, viaAccept) {
    d = d || {};
    if (s2.data.lobbyId && s2.data.lobbyId !== lb.id) leaveLobby(s2, 'switched lobby');
    const pid = s2.data.pid;
    let p = lb.players.get(pid);
    if (!p) {
      if (lb.state !== 'lobby') {
        s2.emit('br-notice', { msg: 'MATCH IN PROGRESS — you cannot join this match. Spectating; press READY FOR NEXT to be in the next one.', kind: 'locked' });
        audit('JOIN_REJECTED_LOCKED', { lobby: lb.id, pid });
        return spectate(s2, lb);
      }
      if (lb.players.size >= lb.maxPlayers) {
        s2.emit('br-notice', { msg: 'MATCH FULL — spectating.', kind: 'full' });
        audit('JOIN_REJECTED_FULL', { lobby: lb.id, pid });
        return spectate(s2, lb);
      }
      if (lb.joinMode === 'approve' && pid !== lb.hostPid && !viaAccept) {
        // file (or refresh) a challenge; duplicates collapse by pid
        for (const c of lb.challenges.values()) if (c.pid === pid) { c.sid = s2.id; pushChallenges(lb); return spectate(s2, lb, true); }
        const cid = lb.nextCid++;
        lb.challenges.set(cid, { cid, pid, sid: s2.id, name: String(d.name || 'Player').slice(0, 16), skin: d.skin, at: Date.now() });
        audit('CHALLENGE_SENT', { lobby: lb.id, cid, pid });
        s2.emit('br-challenge-sent', { lobbyId: lb.id, stakeCents: lb.stakeCents });
        pushChallenges(lb);
        return spectate(s2, lb, true);
      }
      p = makePlayer(pid, s2.id, d.name, d.skin);
      const t = autoTeam(lb);
      if (t < 0) { s2.emit('br-notice', { msg: 'No team slot free — spectating.' }); return spectate(s2, lb); }
      p.team = t;
      lb.players.set(pid, p);
      if (!lb.hostPid) lb.hostPid = pid;
      audit('PLAYER_JOINED', { lobby: lb.id, pid, n: p.n });
    } else {
      p.sid = s2.id; p.disconnectedAt = 0;
      if (d.name) p.name = String(d.name).slice(0, 16);
    }
    lb.spectators.delete(s2.id);
    s2.join(lb.id);
    s2.data.lobbyId = lb.id;
    lb.emptySince = 0;
    s2.emit('br-joined', { id: lb.id, yourN: p.n });
    sendState(lb);
    broadcastLobbyList();
  }
  function spectate(s2, lb, pendingChallenge) {
    if (s2.data.lobbyId && s2.data.lobbyId !== lb.id) leaveLobby(s2, 'switched lobby');
    lb.spectators.add(s2.id);
    s2.join(lb.id);
    s2.data.lobbyId = lb.id;
    lb.emptySince = 0;
    s2.emit('br-joined', { id: lb.id, spectator: true, pendingChallenge: !!pendingChallenge, canQueueNext: lb.state !== 'lobby' });
    sendState(lb);
    if (lb.state === 'playing' || lb.state === 'countdown') {
      s2.emit('br-begin', { matchId: lb.matchId, mapSeed: lb.mapSeed, tStart: lb.tStart, loot: [...lb.loot.values()], zone: zonePacket(lb), spectate: true });
    }
  }

  /*
   * READY FOR NEXT — a spectator of a running match queues for the next one.
   * NOT a join: it changes nothing about the live match and holds no money.
   * At match end the queue is promoted into real lobby seats (space allowing),
   * where the normal ready/pay flow applies.
   */
  sock.on('br-next', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || !sock.data.pid) return;
    if (lb.state === 'lobby') return sock.emit('br-notice', { msg: 'The lobby is open — just join a team and ready up.' });
    if (lb.players.has(sock.data.pid)) return;   // participants don't queue
    const want = !(d && d.cancel);
    if (want) {
      lb.nextQueue.set(sock.data.pid, { name: String((d && d.name) || 'Player').slice(0, 16), skin: (d && d.skin) || 0, sid: sock.id });
      sock.emit('br-queued-next', { queued: true, position: lb.nextQueue.size });
    } else {
      lb.nextQueue.delete(sock.data.pid);
      sock.emit('br-queued-next', { queued: false });
    }
  });

  /*
   * CHALLENGE RESOLUTION — host only. Accept re-validates EVERYTHING at the
   * moment of acceptance (room open, slot free, challenger still connected):
   * two challenges racing for the last seat resolve in arrival order, and the
   * loser gets a clean refusal. Deny simply deletes — no charge existed.
   */
  sock.on('br-challenge-resolve', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || sock.data.pid !== lb.hostPid) return;
    const cid = Math.floor(Number(d && d.cid));
    const ch = lb.challenges.get(cid);
    if (!ch) return;
    if (!(d && d.accept)) {
      lb.challenges.delete(cid);
      const s2 = io.sockets.sockets.get(ch.sid);
      if (s2) s2.emit('br-challenge-out', { cid, accepted: false, why: 'The host denied your challenge. You have not been charged.' });
      audit('CHALLENGE_DENIED', { lobby: lb.id, cid, pid: ch.pid });
      pushChallenges(lb);
      return;
    }
    if (lb.state !== 'lobby') return voidChallenge(lb, cid, 'match already started');
    if (lb.players.size >= lb.maxPlayers) return voidChallenge(lb, cid, 'match filled up');
    const s2 = io.sockets.sockets.get(ch.sid);
    if (!s2 || s2.data.pid !== ch.pid) return voidChallenge(lb, cid, 'challenger left');
    lb.challenges.delete(cid);
    audit('CHALLENGE_ACCEPTED', { lobby: lb.id, cid, pid: ch.pid });
    s2.emit('br-challenge-out', { cid, accepted: true });
    joinLobby(s2, lb, { name: ch.name, skin: ch.skin }, true);
    pushChallenges(lb);
  });

  sock.on('br-join', (d) => {
    d = d || {};
    if (!sock.data.pid) return sock.emit('br-notice', { msg: 'Say hello first — reload.' });
    // join by id — works for private lobbies too: knowing the code IS the invite
    const lb = lobbies.get(String(d.lobbyId || '').trim());
    if (!lb) return sock.emit('br-notice', { msg: 'That lobby no longer exists.', kind: 'nolobby' });
    joinLobby(sock, lb, d);
  });

  /*
   * RENAME — lobby only. The platform resolves the player's SAVED display name
   * asynchronously (wallet hydration can outrun it), so a player can enter the
   * room as the "Player###" fallback before their real name arrives. Once a
   * match starts the name is frozen: results, kill feed and audit all quote it.
   */
  sock.on('br-rename', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'lobby') return;
    const p = lb.players.get(sock.data.pid);
    if (!p) return;
    const name = String((d && d.name) || '').trim().slice(0, 16);
    if (!name || name === p.name) return;
    p.name = name;
    sendState(lb);
    broadcastLobbyList();   // the lobby's advertised name may quote the host
  });

  sock.on('br-team', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'lobby') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.ready) return;   // committed players don't hop teams
    const t = Math.floor(Number(d && d.team));
    if (!(t >= 0 && t < lb.maxTeams)) return;
    const c = teamCounts(lb);
    if (c[t] >= lb.teamSize) return sock.emit('br-notice', { msg: 'That team is full.' });
    p.team = t;
    sendState(lb);
  });

  // host-only: move a player to a team / kick from lobby
  sock.on('br-host', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'lobby') return;
    if (sock.data.pid !== lb.hostPid) return;
    d = d || {};
    if (d.op === 'move') {
      const target = [...lb.players.values()].find((p) => p.n === Number(d.n));
      const t = Math.floor(Number(d.team));
      if (!target || !(t >= 0 && t < lb.maxTeams)) return;
      if (teamCounts(lb)[t] >= lb.teamSize) return sock.emit('br-notice', { msg: 'That team is full.' });
      if (target.ready) return sock.emit('br-notice', { msg: 'They are readied up — cannot move them now.' });
      target.team = t;
      sendState(lb);
    } else if (d.op === 'kick') {
      const target = [...lb.players.values()].find((p) => p.n === Number(d.n));
      if (!target || target.pid === lb.hostPid) return;
      const s2 = target.sid && io.sockets.sockets.get(target.sid);
      removePlayer(lb, target.pid, 'kicked by host');
      if (s2) { s2.leave(lb.id); s2.data.lobbyId = null; s2.emit('br-kicked', {}); }
    }
  });

  /*
   * READY — and, in a paid lobby, THE SINGLE POINT AN ENTRY FEE IS TAKEN.
   * Same owner rule as kart: readying commits the entry; the free way out is
   * LEAVE (full refund while the match has not started). Un-readying once
   * paid is refused so the pot cannot shrink while others commit against it.
   */
  sock.on('br-ready', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'lobby') return;
    const p = lb.players.get(sock.data.pid);
    if (!p) return;
    const want = !!(d && d.ready);

    if (want && lb.stakeCents > 0 && !lb.paid.has(p.pid)) {
      if (!ENTRY_FEES_ENABLED) return sock.emit('br-notice', { msg: 'Paid matches are not open yet — free matches are.' });
      const t = verifyTicket(lb.id, d && d.ticket, d && d.tsig);
      if (!t) return sock.emit('br-need-pay', { lobbyId: lb.id, stakeCents: lb.stakeCents });
      if (ticketSpent(d && d.ticket)) return sock.emit('br-need-pay', { lobbyId: lb.id, stakeCents: lb.stakeCents });
      if (t.cents !== lb.stakeCents) return sock.emit('br-notice', { msg: 'That entry was for a different stake.' });
      for (const [opid, pd] of lb.paid) if (pd.address === t.address && opid !== p.pid) lb.paid.delete(opid);
      lb.paid.set(p.pid, { cents: lb.stakeCents, address: t.address, lamports: t.lamports, ticket: (d && d.ticket) || null, at: Date.now() });
      audit('WAGER_COMMITTED', { lobby: lb.id, pid: p.pid, cents: lb.stakeCents, lamports: t.lamports, address: t.address.slice(0, 8) });
    }
    if (!want && lb.stakeCents > 0 && lb.paid.has(p.pid)) {
      return sock.emit('br-notice', { msg: 'You are in this match — leave the lobby if you want your entry back.' });
    }
    p.ready = want;
    sendState(lb);
    // full lobby with everyone ready starts itself; otherwise the host starts
    const chk = canStart(lb);
    if (chk.ok && lb.players.size >= lb.maxPlayers && [...lb.players.values()].every((x) => x.ready || !x.sid)) startMatch(lb);
  });

  sock.on('br-start', () => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb) return;
    if (sock.data.pid !== lb.hostPid) return sock.emit('br-notice', { msg: 'Only the host can start the match.' });
    const r = startMatch(lb);
    if (!r.ok) sock.emit('br-notice', { msg: r.why });
  });

  /*
   * INPUTS — the only thing a client may say about its body. Axes, look
   * angles, buttons, and a sequence number for prediction reconciliation.
   * Rate limited; values clamped in stepPlayer. Look angles are the client's
   * to choose (that is what a mouse is), positions are not.
   */
  sock.on('br-in', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing' || !d) return;
    const p = lb.players.get(sock.data.pid);
    if (!p || !p.inMatch || p.state === 'dead' || p.state === 'out') return;
    const now = Date.now();
    if (now - p.packetWindow > 1000) { p.packetWindow = now; p.packetCount = 0; }
    if (++p.packetCount > 130) return;   // >130 packets/sec is not a game client
    const pitch = Math.max(-1.55, Math.min(1.55, Number(d.p) || 0));
    p.input = {
      f: Number(d.f) || 0, s: Number(d.s) || 0,
      yaw: Number(d.y) || 0, pitch,
      sprint: !!d.sp, crouch: !!d.c, jump: !!d.j,
      fire: !!d.fi, aim: !!d.a,
      seq: (Number(d.q) || 0) >>> 0,
    };
    p.yaw = p.input.yaw; p.pitch = pitch;
    p.lastPacket = now;
  });

  sock.on('br-slot', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.state !== 'alive') return;
    const i = Math.floor(Number(d && d.slot));
    if (!(i >= 0 && i < 5) || !p.inv[i]) return;
    if (p.slot !== i) { p.slot = i; p.reloadT = 0; p.useT = 0; sendInv(lb, p); }
  });

  sock.on('br-reload', () => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.state !== 'alive' || p.reloadT > 0) return;
    const it = p.inv[p.slot];
    if (!it) return;
    const w = BR.WEAPONS[it.kind];
    if (!w || !w.ammo) return;
    if (it.mag >= w.mag || p.ammo[w.ammo] <= 0) return;
    p.reloadT = w.reload;
  });

  // use a consumable in slot i (or the current slot)
  sock.on('br-use', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.state !== 'alive' || p.useT > 0) return;
    const i = d && d.slot != null ? Math.floor(Number(d.slot)) : p.slot;
    const it = p.inv[i];
    if (!it) return;
    const c = BR.CONSUMABLES[it.kind];
    if (!c) return;
    if (c.heal && p.hp >= (c.cap || BR.MAX_HP)) return sock.emit('br-notice', { msg: 'Health is already there.' });
    if (c.shield && p.shield >= (c.shieldCap || BR.MAX_SHIELD)) return sock.emit('br-notice', { msg: 'Shield is already there.' });
    p.useT = c.use; p.useSlot = i;
  });

  sock.on('br-drop', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.state !== 'alive') return;
    const i = Math.floor(Number(d && d.slot));
    if (!(i >= 0 && i < 5)) return;
    const it = p.inv[i];
    if (!it || it.kind === 'melee') return;
    p.inv[i] = null;
    if (p.slot === i) p.slot = 0;
    const iid = lb.nextIid++;
    const item = BR.CONSUMABLES[it.kind]
      ? { iid, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), kind: it.kind, qty: it.qty || 1 }
      : { iid, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), kind: it.kind, tier: it.tier, gun: true, mag: it.mag };
    lb.loot.set(iid, item);
    io.to(lb.id).emit('br-loot-add', [item]);
    sendInv(lb, p);
  });

  /*
   * INTERACT: pick up an item / open a chest / start a revive. Server checks
   * distance against ITS OWN position for the player — a client cannot loot
   * across the map by lying, because its claim about where it is was never
   * part of the message.
   */
  sock.on('br-interact', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || p.state !== 'alive') return;
    // revive?
    if (d && d.revive != null) {
      const tgt = [...lb.players.values()].find((o) => o.n === Number(d.revive));
      if (!tgt || tgt.team !== p.team || tgt.state !== 'down') return;
      const dist = Math.hypot(tgt.x - p.x, tgt.z - p.z);
      if (dist > BR.REVIVE_DIST) return;
      p.reviveT = BR.REVIVE_TIME; p.reviveTgt = tgt.pid;
      return;
    }
    const iid = Math.floor(Number(d && d.iid));
    const it = lb.loot.get(iid);
    if (!it) return;
    const dist = Math.hypot(it.x - p.x, it.z - p.z, (it.y - p.y) * 0.5);
    if (dist > BR.INTERACT_DIST + 0.8) return;

    if (it.kind === 'chest') {
      if (it.opened) return;
      it.opened = true;
      // burst 3 items around the chest
      const rnd = Math.random;
      const guns = ['smg', 'ar', 'burst', 'tacshot', 'shotgun', 'sniper', 'handcannon'];
      const drops = [];
      const mk = (kind, extra) => {
        const nid = lb.nextIid++;
        const a = rnd() * Math.PI * 2;
        const item = Object.assign({ iid: nid, x: +(it.x + Math.cos(a) * 1.0).toFixed(2), y: it.y, z: +(it.z + Math.sin(a) * 1.0).toFixed(2), kind }, extra);
        lb.loot.set(nid, item);
        drops.push(item);
      };
      const g = guns[Math.floor(rnd() * guns.length)];
      const [tlo, thi] = BR.WEAPON_TIERS[g] || [0, 4];
      const tr = rnd();
      const tier = Math.max(tlo, Math.min(thi, tr < 0.3 ? 1 : tr < 0.65 ? 2 : tr < 0.92 ? 3 : 4));
      mk(g, { tier, gun: true });
      const wa = BR.WEAPONS[g].ammo;
      if (wa) mk('ammo', { ammo: wa, qty: BR.AMMO_PICKUP[wa] * 2 });
      const cons = ['bandage', 'medkit', 'shieldsm', 'shieldbig'][Math.floor(rnd() * 4)];
      mk(cons, { qty: cons === 'bandage' ? 5 : 1 });
      io.to(lb.id).emit('br-chest', { iid, drops });
      return;
    }

    // pick up
    if (it.kind === 'ammo') {
      const k = it.ammo;
      if (!BR.AMMO_KINDS.includes(k)) return;
      if (p.ammo[k] >= BR.AMMO_MAX[k]) return sock.emit('br-notice', { msg: 'Ammo full.' });
      p.ammo[k] = Math.min(BR.AMMO_MAX[k], p.ammo[k] + (it.qty || 0));
    } else if (BR.CONSUMABLES[it.kind]) {
      const c = BR.CONSUMABLES[it.kind];
      // stack into an existing slot or take a free one
      let s = p.inv.findIndex((x) => x && x.kind === it.kind && (x.qty || 0) < c.stack);
      if (s < 0) s = p.inv.findIndex((x, ix) => ix > 0 && !x);
      if (s < 0) return sock.emit('br-notice', { msg: 'Inventory full.' });
      if (p.inv[s]) p.inv[s].qty = Math.min(c.stack, (p.inv[s].qty || 0) + (it.qty || 1));
      else p.inv[s] = { kind: it.kind, qty: it.qty || 1 };
    } else if (BR.WEAPONS[it.kind]) {
      let s = p.inv.findIndex((x, ix) => ix > 0 && !x);
      if (s < 0) {
        // swap with the held gun (never the melee in slot 0)
        s = p.slot > 0 ? p.slot : -1;
        if (s < 0) return sock.emit('br-notice', { msg: 'Inventory full — switch to a gun to swap it.' });
        const old = p.inv[s];
        const nid = lb.nextIid++;
        const dropped = { iid: nid, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), kind: old.kind, tier: old.tier, gun: true, mag: old.mag };
        lb.loot.set(nid, dropped);
        io.to(lb.id).emit('br-loot-add', [dropped]);
      }
      p.inv[s] = { kind: it.kind, tier: it.tier || 0, mag: it.mag != null ? it.mag : BR.WEAPONS[it.kind].mag, gun: true };
      p.slot = s;
    } else return;

    lb.loot.delete(iid);
    io.to(lb.id).emit('br-loot-del', { iid });
    sendInv(lb, p);
  });

  /*
   * PING — a team marker. Coordinates only, clamped to the map, rate-limited;
   * relayed to teammates (or, in solo, back to the sender for their own map).
   */
  let _pingLast = 0;
  sock.on('br-ping', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb || lb.state !== 'playing') return;
    const p = lb.players.get(sock.data.pid);
    if (!p || !p.inMatch) return;
    const now = Date.now();
    if (now - _pingLast < 700) return;
    _pingLast = now;
    const px = Math.max(-BR.HALF, Math.min(BR.HALF, Number(d && d.x) || 0));
    const pz = Math.max(-BR.HALF, Math.min(BR.HALF, Number(d && d.z) || 0));
    const kind = d && d.kind === 'danger' ? 'danger' : 'go';
    for (const o of lb.players.values()) {
      if (o.team !== p.team || !o.sid) continue;
      const s2 = io.sockets.sockets.get(o.sid);
      if (s2) s2.emit('br-ping', { n: p.n, x: +px.toFixed(1), z: +pz.toFixed(1), kind });
    }
  });

  let _chatLast = 0, _chatBurst = 0;
  sock.on('br-chat', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb) return;
    const msg = String((d || {}).msg || '').slice(0, 140).trim();
    if (!msg) return;
    const nowc = Date.now();
    if (nowc - _chatLast < 1200) { if (++_chatBurst > 3) return; } else { _chatBurst = 0; }
    _chatLast = nowc;
    const p = lb.players.get(sock.data.pid);
    const team = !!(d && d.team) && p && lb.teamSize > 1;
    if (team) {
      for (const o of lb.players.values()) {
        if (o.team === p.team && o.sid) {
          const s2 = io.sockets.sockets.get(o.sid);
          if (s2) s2.emit('br-chat', { name: p.name, msg, team: true });
        }
      }
    } else {
      // io.to includes the sender — client must NOT echo locally (snake's lesson)
      io.to(lb.id).emit('br-chat', { name: p ? p.name : 'spectator', msg });
    }
  });

  sock.on('br-leave', () => leaveLobby(sock, 'left'));
  sock.on('disconnect', (reason) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (lb && lb.stakeCents > 0) {
      console.log('[br] DISCONNECT reason=' + reason + ' lobby=' + sock.data.lobbyId + ' state=' + (lb && lb.state));
    }
    leaveLobby(sock, 'disconnected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION — fixed 40Hz step per playing lobby, 20Hz broadcast
// ═══════════════════════════════════════════════════════════════════════════
const SIM_HZ = 40;
const SIM_DT = 1 / SIM_HZ;
const SIM_MAX_CATCHUP = 6;

function fireWeapon(lb, p, now) {
  const it = p.inv[p.slot];
  if (!it) return;
  const w = BR.WEAPONS[it.kind];
  if (!w) return;
  if (p.reloadT > 0 || p.useT > 0 || p.reviveT > 0) return;
  if ((now - p.lastFire) / 1000 < w.rate) return;
  if (w.ammo) {
    if (it.mag <= 0) {
      // auto-reload attempt on empty trigger
      if (p.ammo[w.ammo] > 0 && p.reloadT <= 0) p.reloadT = w.reload;
      return;
    }
    it.mag--;
  }
  p.lastFire = now;

  const eye = p.y + (p.crouching ? BR.EYE_CROUCH : BR.EYE);
  const moving = Math.hypot(p.vx, p.vz) > 1.5;
  const baseSpread = w.spread * (p.input.aim ? 0.45 : 1) * (moving ? 1.7 : 1) * (p.grounded ? 1 : 2.2) * (p.crouching ? 0.8 : 1);
  p.bloom = Math.min(2.2, p.bloom + 0.28);
  const spread = baseSpread * (1 + p.bloom * 0.5);

  const dmgMult = BR.TIER_MULT[it.tier || 0] || 1;
  const hits = [];
  let shotDir = null;
  for (let pel = 0; pel < w.pellets; pel++) {
    // spread = random angular deviation applied straight to yaw/pitch. Exact
    // enough at these angles, and trivially symmetric.
    const a = Math.random() * Math.PI * 2, r = (Math.random() + Math.random()) * 0.5 * spread;
    const yaw2 = p.yaw + Math.cos(a) * r;
    const pitch2 = p.pitch + Math.sin(a) * r;
    const cp = Math.cos(pitch2);
    const dx = -Math.sin(yaw2) * cp, dyN = Math.sin(pitch2), dz = -Math.cos(yaw2) * cp;
    if (!shotDir) shotDir = [dx, dyN, dz];

    const wallD = BR.rayWorld(p.x, eye, p.z, dx, dyN, dz, w.range, lb.map.boxes);
    let best = null, bestD = wallD;
    for (const o of lb.players.values()) {
      if (o === p || !o.inMatch || o.state === 'dead' || o.state === 'out') continue;
      if (o.team === p.team && lb.teamSize > 1) continue;   // no friendly fire
      const hit = BR.rayPlayer(p.x, eye, p.z, dx, dyN, dz, bestD, o.x, o.y, o.z, o.crouching, o.state === 'down');
      if (hit && hit.d < bestD) { best = { o, head: hit.head }; bestD = hit.d; }
    }
    if (best) {
      let dmg = w.dmg * dmgMult;
      if (best.head) dmg *= w.hsMult;
      // range falloff past 60% of range (not sniper)
      if (it.kind !== 'sniper' && bestD > w.range * 0.6) dmg *= Math.max(0.55, 1 - (bestD - w.range * 0.6) / w.range);
      dmg = Math.round(dmg);
      const dealt = applyDamage(lb, best.o, dmg, p, it.kind, best.head);
      hits.push({ n: best.o.n, d: bestD, dmg: dealt, hs: !!best.head });
    } else {
      hits.push({ n: 0, d: bestD });
    }
  }
  // one event describes the whole trigger pull (all pellets) — tracers + hitmarkers
  io.to(lb.id).emit('br-shot', {
    n: p.n, w: it.kind,
    o: [+p.x.toFixed(2), +eye.toFixed(2), +p.z.toFixed(2)],
    dir: shotDir ? [+shotDir[0].toFixed(3), +shotDir[1].toFixed(3), +shotDir[2].toFixed(3)] : [0, 0, -1],
    h: hits.map((h) => ({ n: h.n, d: +h.d.toFixed(1), g: h.dmg || 0, hs: !!h.hs })),
  });
}

function simulate(lb, now) {
  lb._acc = (lb._acc || 0) + (now - (lb._simAt || now)) / 1000;
  lb._simAt = now;
  let steps = Math.floor(lb._acc / SIM_DT);
  if (steps > SIM_MAX_CATCHUP) { steps = SIM_MAX_CATCHUP; lb._acc = 0; } else { lb._acc -= steps * SIM_DT; }

  for (let n = 0; n < steps; n++) {
    for (const p of lb.players.values()) {
      if (!p.inMatch || p.state === 'dead' || p.state === 'out') continue;
      const inp = p.sid ? p.input : { f: 0, s: 0, yaw: p.yaw, pitch: p.pitch };
      BR.stepPlayer(p, inp, SIM_DT, lb.map);
      p.ackSeq = inp.seq || 0;
      p.bloom = Math.max(0, p.bloom - SIM_DT * 1.6);

      // timers
      if (p.reloadT > 0) {
        p.reloadT -= SIM_DT;
        if (p.reloadT <= 0) {
          p.reloadT = 0;
          const it = p.inv[p.slot];
          const w = it && BR.WEAPONS[it.kind];
          if (w && w.ammo) {
            const need = w.mag - it.mag;
            const take = Math.min(need, p.ammo[w.ammo]);
            it.mag += take; p.ammo[w.ammo] -= take;
            sendInv(lb, p);
          }
        }
      }
      if (p.useT > 0 && p.state === 'alive') {
        p.useT -= SIM_DT;
        if (p.useT <= 0) {
          p.useT = 0;
          const it = p.inv[p.useSlot];
          const c = it && BR.CONSUMABLES[it.kind];
          if (c) {
            if (c.heal) p.hp = Math.min(c.cap || BR.MAX_HP, p.hp + c.heal);
            if (c.shield) p.shield = Math.min(c.shieldCap || BR.MAX_SHIELD, p.shield + c.shield);
            it.qty = (it.qty || 1) - 1;
            if (it.qty <= 0) { p.inv[p.useSlot] = null; if (p.slot === p.useSlot) p.slot = 0; }
            sendInv(lb, p);
          }
        }
      }
      // revive channel: must stay close, both alive/down as expected
      if (p.reviveT > 0) {
        const tgt = p.reviveTgt ? lb.players.get(p.reviveTgt) : null;
        const ok = tgt && tgt.state === 'down' && p.state === 'alive' &&
          Math.hypot(tgt.x - p.x, tgt.z - p.z) <= BR.REVIVE_DIST + 0.6 &&
          !p.input.fire && Math.hypot(p.vx, p.vz) < 0.8;
        if (!ok) { p.reviveT = 0; p.reviveTgt = null; }
        else {
          p.reviveT -= SIM_DT;
          if (p.reviveT <= 0) {
            p.reviveT = 0; p.reviveTgt = null;
            tgt.state = 'alive'; tgt.hp = 30; tgt.downHp = 0;
            io.to(lb.id).emit('br-revived', { n: tgt.n, by: p.n });
          }
        }
      }
      // downed bleed
      if (p.state === 'down') {
        // pause bleed while a teammate channels the revive
        const beingRevived = [...lb.players.values()].some((o) => o.reviveTgt === p.pid && o.reviveT > 0);
        if (!beingRevived) {
          p.downHp -= BR.DOWN_BLEED * SIM_DT;
          if (p.downHp <= 0) eliminate(lb, p, p.lastDamager, 'bleed');
        }
      }
      // fire
      if (p.input.fire && p.state === 'alive' && p.sid) fireWeapon(lb, p, now);
    }
  }

  // zone damage at 1Hz per player
  if (!lb._zoneTickAt || now - lb._zoneTickAt >= 1000) {
    lb._zoneTickAt = now;
    const z = lb.zone;
    if (z) {
      for (const p of lb.players.values()) {
        if (!p.inMatch || (p.state !== 'alive' && p.state !== 'down')) continue;
        const d = Math.hypot(p.x - z.cx, p.z - z.cz);
        if (d > z.r) applyDamage(lb, p, z.dps, null, 'storm', false);
      }
    }
  }

  // reconnect grace: a player disconnected too long dies in place (no refund —
  // owner's rule for every game: a disconnect is the player's problem)
  for (const p of lb.players.values()) {
    if (p.inMatch && !p.sid && p.disconnectedAt && (now - p.disconnectedAt) > RECONNECT_GRACE_MS &&
        (p.state === 'alive' || p.state === 'down')) {
      p.disconnectedAt = 0;
      eliminate(lb, p, null, 'timeout');
    }
  }
}

function broadcastMatch(lb, now) {
  const players = [];
  for (const p of lb.players.values()) {
    if (!p.inMatch || p.state === 'out') continue;
    players.push({
      n: p.n,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2), vz: +p.vz.toFixed(2),
      yw: +p.yaw.toFixed(3), pt: +p.pitch.toFixed(2),
      st: p.state === 'alive' ? 0 : p.state === 'down' ? 1 : 2,
      hp: Math.ceil(p.hp), sh: Math.ceil(p.shield), dh: Math.ceil(p.downHp),
      cr: p.crouching ? 1 : 0, tm: p.team,
      wk: p.inv[p.slot] ? p.inv[p.slot].kind : 'melee',
      rl: p.reloadT > 0 ? 1 : 0, us: p.useT > 0 ? 1 : 0,
      rv: p.reviveT > 0 ? 1 : 0, ai: p.input.aim ? 1 : 0,
      sp: (Math.hypot(p.vx, p.vz) > 6.5 && !p.crouching) ? 1 : 0,
      dc: p.sid ? 0 : 1,
      k: p.kills, dg: Math.round(p.dmg),
      q: p.ackSeq || 0,
    });
  }
  io.to(lb.id).emit('br-t', { t: now - lb.tStart, players, zone: zonePacket(lb) });
}

const TICK_MS = 25;
let _bcFlip = false;
/*
 * START FAILURE — the wager taken / match never started case, closed exactly.
 * If beginPlay throws, the room goes to START_FAILED: every committed entry is
 * refunded ONCE (stable ids; the sweep knows which ledger the entries are in
 * so the two refund paths can never both fire for the same entry), no fee is
 * taken, no winner exists, and the room returns to the lobby.
 */
function startFailed(lb, err) {
  console.error('[br] START FAILED ' + lb.id + ':', (err && err.stack) || err);
  audit('MATCH_START_FAILED', { lobby: lb.id, matchId: lb.matchId, err: String((err && err.message) || err) });
  if (lb.matchId && _inflight.has(lb.matchId)) {
    // entries reached the durable in-flight record — refund through it
    refundInFlightMatch(lb.matchId, 'START FAILED');
  } else if (lb.entriesThisMatch && lb.entriesThisMatch.size) {
    // entries were moved out of lb.paid but never became in-flight
    for (const [pid, pd] of lb.entriesThisMatch) {
      if (!pd || !pd.address || !(pd.lamports > 0)) continue;
      const refundId = (lb.id + ':' + pid + ':' + (pd.at || 0)).slice(0, 90);
      enqueueJob('refund', 'refund:' + refundId, 'kart-refund:' + refundId,
        { action: 'kart-refund', refundId, entries: [{ address: pd.address, lamports: Math.floor(pd.lamports) }] });
      retireTicket(pd.ticket);
    }
    saveQueue(); drainQueue();
  }
  refundUnstarted(lb, 'START FAILED');   // anything still sitting in lb.paid
  lb.entriesThisMatch = null; lb.potCents = 0; lb.potLamports = 0; lb.matchId = null;
  lb.state = 'lobby'; lb.startAt = 0; lb.zone = null;
  for (const p of lb.players.values()) { p.ready = false; p.inMatch = false; p.state = 'out'; }
  io.to(lb.id).emit('br-start-failed', { msg: 'MATCH DID NOT START — ' + (lb.stakeCents > 0 ? 'your wager has been refunded.' : 'try again.') });
  sendState(lb);
  broadcastLobbyList();
}

setInterval(() => {
  const now = Date.now();
  _bcFlip = !_bcFlip;
  for (const lb of [...lobbies.values()]) {
    if (lb.state === 'countdown' && now >= lb.startAt) {
      try { beginPlay(lb); } catch (e) { try { startFailed(lb, e); } catch (e2) { console.error('[br] startFailed threw', e2); } }
    }
    if (lb.state === 'playing') {
      tickZone(lb, now);
      simulate(lb, now);
      if (now - lb.tStart > MATCH_TIMEOUT_MS) {
        // pick the best surviving team rather than hanging forever
        let best = null, bestScore = -1;
        const score = new Map();
        for (const p of lb.players.values()) {
          if (!p.inMatch) continue;
          const s = (score.get(p.team) || 0) + ((p.state === 'alive' || p.state === 'down') ? 100 : 0) + p.kills;
          score.set(p.team, s);
        }
        for (const [t, s] of score) if (s > bestScore) { bestScore = s; best = t; }
        endMatch(lb, best, 'time limit');
      }
      if (_bcFlip) broadcastMatch(lb, now);
    }
    if (lb.challenges && lb.challenges.size) {
      for (const [cid, ch] of [...lb.challenges]) {
        if (now - ch.at > 120000) voidChallenge(lb, cid, 'challenge expired');
      }
    }
    if (lb.players.size === 0 && lb.spectators.size === 0 &&
        lb.emptySince && now - lb.emptySince > EMPTY_LOBBY_TTL) {
      refundUnstarted(lb, 'lobby reaped');
      if (lb.state === 'playing') endMatch(lb, null, 'lobby reaped');
      lobbies.delete(lb.id);
      broadcastLobbyList();
    }
  }
}, TICK_MS);

// ── BOOT ───────────────────────────────────────────────────────────────────
loadQueue();
recoverInFlight();
setInterval(() => { drainQueue().catch((e) => console.error('[br] drain threw', e && e.message)); }, DRAIN_MS);
drainQueue().catch(() => {});

server.listen(PORT, () => {
  console.log('[br] ' + REGION + ' listening on :' + PORT + '  fees=' + (ENTRY_FEES_ENABLED ? 'ON' : 'OFF') +
    '  queue ' + _jobs.size + ' job(s)');
});

process.on('uncaughtException', (e) => console.error('[br] uncaught', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[br] unhandled', (e && e.stack) || e));
