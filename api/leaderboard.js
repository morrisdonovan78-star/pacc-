'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const crypto = require('crypto');   // private-lobby handshake token (see the lobby-* actions)
const { kvGet, kvSet, kvSetPerm, kvDel, kvZadd, kvZrem, kvZrevrange,
        kvHget, kvHset, kvHgetall, kvLrange } = require('../lib/kv');

// Seconds the top-20 board is served from a precomputed blob. Building it live costs ~60 KV
// commands and it is the most-refreshed endpoint on the site; that combination is what exhausted
// the KV request budget and took payouts down with it. The board is a vanity ranking, so being a
// few seconds stale is invisible to players.
const LB_CACHE_TTL = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Stats are scoped per-game — ph:ss:{address} / lb:ss:earned for Slither Snakes,
// ph:pac:{address} / lb:pac:earned for Pac-Man — so the two games' leaderboards never
// mix, even for a wallet that plays both. Only whitelisted values pass through; anything
// else (or missing) falls back to 'pac' since that was this endpoint's original game.
function gameOf(g) { return g === 'ss' ? 'ss' : 'pac'; }

// ── ACCOUNT-KEYED IDENTITY (fixes "leaderboard/friends show an old wallet") ──────────────────────
// Everything historically keyed on the wallet ADDRESS, so when a player's wallet changed (new device
// minted a second wallet) their name/leaderboard entry stayed on the OLD address and friends sent money
// there. We now map wallet <-> Privy ACCOUNT and always resolve the DISPLAYED/receive wallet to the
// account's CURRENT wallet:  a2c:<addr> = account sub,  c2a:<sub> = current wallet address.
// Recorded on every login (action:'link') + on setname. Fully backward-compatible: an address with no
// account link resolves to itself (legacy behaviour unchanged).
function parseJwt(token) {
  try {
    const p = String(token).split('.')[1];
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const c = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (c && c.exp && Math.floor(Date.now() / 1000) > c.exp) return null; // expired
    return c && c.sub ? c : null;
  } catch (_) { return null; }
}
// Record the account<->wallet link (idempotent). c2a is the account's CURRENT wallet.
async function recordLink(sub, address) {
  if (!sub || !address) return;
  await Promise.all([
    kvSetPerm('a2c:' + address, sub).catch(() => {}),
    kvSetPerm('c2a:' + sub, address).catch(() => {}),
  ]);
}
// Resolve ANY (possibly old) address to the account's current wallet. Falls back to the input.
async function currentAddr(address) {
  if (!address) return address;
  try {
    const sub = await kvGet('a2c:' + address);
    if (!sub) return address;
    const cur = await kvGet('c2a:' + sub);
    return cur || address;
  } catch (_) { return address; }
}

// Display name is account-level (shared identity across both games), stored unscoped.
async function readStats(game, address) {
  const empty = { name:'', earned:0, wagered:0, games:0, kills:0, deaths:0, wins:0, losses:0 };
  const [name, h] = await Promise.all([
    kvHget('ph:' + address, 'name').catch(() => null),
    kvHgetall('ph:' + game + ':' + address).catch(() => null),
  ]);
  if (!h) return { ...empty, name: name || '' };
  return {
    name:    name || '',
    earned:  parseInt(h.earned)  || 0,
    wagered: parseInt(h.wagered) || 0,
    games:   parseInt(h.games)   || 0,
    kills:   parseInt(h.kills)   || 0,
    deaths:  parseInt(h.deaths)  || 0,
    wins:    parseInt(h.wins)    || 0,
    losses:  parseInt(h.losses)  || 0,
  };
}

async function readGlobal(game) {
  const empty = { totalEarned:0, totalWagered:0, gamesPlayed:0 };
  const h = await kvHgetall('ph:' + game + ':global');
  if (!h) return empty;
  return {
    totalEarned:  parseInt(h.totalEarned)  || 0,
    totalWagered: parseInt(h.totalWagered) || 0,
    gamesPlayed:  parseInt(h.gamesPlayed)  || 0,
  };
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── POST — register or update display name ──────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { action, address, name, jwt } = req.body || {};
      const claims = jwt ? parseJwt(jwt) : null;
      const sub = claims && claims.sub;

      // ── action:'link' — record the account<->wallet link on login (no name change) ──
      // This is what lets names/leaderboard resolve to the player's CURRENT wallet: every login
      // stamps c2a:<sub> = the wallet they're using now, so a name registered on any old address
      // (whose a2c points at this account) resolves forward to this current wallet.
      if (action === 'link') {
        if (!sub || !address) return res.status(400).json({ error: 'jwt and address required' });
        await recordLink(sub, address);
        return res.status(200).json({ ok: true });
      }

      // ══ PRIVATE, INVITE-ONLY LOBBIES ═══════════════════════════════════════════════════════════
      // Rules live in lib/privlobby.js (pure, 63 offline tests). This layer is storage + identity.
      //
      // ISOLATION: private lobbies use the `ss-priv-` prefix, which no public lobby id can match.
      // The game-server gate becomes `LOBBY_IDS.has(id) || isPrivateLobbyId(id)` — purely additive,
      // so every public lobby keeps its exact-string match and its existing code path. The public
      // lobby-count and admin-listing arrays are untouched, so private rooms never appear in them.
      //
      // KV:  pl:<id> = lobby record | plc:<CODE> = id (join-by-code) | plu:<addr> = zset of my ids
      if (action && action.indexOf('lobby-') === 0) {
        const PL = require('../lib/privlobby');
        const body = req.body || {};   // the handler destructures req.body above; alias it back
        const now = Date.now();
        // Every lobby action is account-authenticated AND bound to a wallet: the jwt proves the
        // account, and a2c/c2a proves that account currently owns the address being acted as. That
        // stops someone driving a lobby as a wallet that is not theirs.
        if (!sub) { return res.status(401).json({ error: 'jwt required' }); }
        const me = String(address || '');
        if (!me) return res.status(400).json({ error: 'address required' });
        const owns = await kvGet('a2c:' + me);
        if (owns && owns !== sub) return res.status(403).json({ error: 'that wallet belongs to another account' });
        if (!owns) await recordLink(sub, me).catch(() => {});

        const loadLobby = async id => {
          if (!PL.isPrivateLobbyId(String(id || ''))) return null;
          try { const raw = await kvGet('pl:' + id); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
        };
        const saveLobby = async l => { await kvSetPerm('pl:' + l.id, JSON.stringify(l)); };
        // Resolve display names for the roster in one pass.
        const namesFor = async addrs => {
          const out = {};
          for (const a of addrs) { try { out[a] = (await kvHget('ph:' + a, 'name')) || ''; } catch (_) { out[a] = ''; } }
          return out;
        };
        const viewOf = async l => PL.publicView(l, await namesFor(l.invited || []));

        // ── create ──────────────────────────────────────────────────────────────────────────────
        if (action === 'lobby-create') {
          const id = PL.makeLobbyId();
          const code = PL.makeJoinCode();
          const lobby = PL.newLobby({ id, code, host: me,
            region: String(body.region || 'NA').toUpperCase() === 'EU' ? 'EU' : 'NA',
            usd: body.usd, nowMs: now });
          await saveLobby(lobby);
          await kvSetPerm('plc:' + code, id);
          await kvZadd('plu:' + me, now, id).catch(() => {});
          return res.status(200).json({ ok: true, lobby: await viewOf(lobby) });
        }

        // ── invite (by wallet address OR by display name) ────────────────────────────────────────
        if (action === 'lobby-invite') {
          const lobby = await loadLobby(body.lobbyId);
          let target = String(body.invitee || '').trim();
          if (target && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target)) {
            // Not an address — treat it as a display name and look it up, then resolve it forward
            // to that account's CURRENT wallet (names are account-level, wallets can change).
            const reg = await kvGet('nameReg:' + target.toUpperCase());
            if (!reg) return res.status(404).json({ error: 'no player found with that name' });
            target = await currentAddr(reg);
          }
          const err = PL.validateInvite({ lobby, byAddr: me, invitee: target, nowMs: now });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const next = PL.applyInvite(lobby, target);
          await saveLobby(next);
          await kvZadd('plu:' + target, now, next.id).catch(() => {});
          return res.status(200).json({ ok: true, lobby: await viewOf(next) });
        }

        // ── kick ────────────────────────────────────────────────────────────────────────────────
        if (action === 'lobby-kick') {
          const lobby = await loadLobby(body.lobbyId);
          const target = String(body.target || '');
          const err = PL.validateKick({ lobby, byAddr: me, target });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const next = PL.applyKick(lobby, target);
          await saveLobby(next);
          await kvZrem('plu:' + target, next.id).catch(() => {});
          return res.status(200).json({ ok: true, lobby: await viewOf(next) });
        }

        // ── set the stake (host only, OPEN only) ────────────────────────────────────────────────
        // Resets every ready flag, so nobody stays "agreed" to a price that changed under them.
        if (action === 'lobby-setprice') {
          const lobby = await loadLobby(body.lobbyId);
          const err = PL.validateSetPrice({ lobby, byAddr: me, usd: body.usd });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const next = PL.applySetPrice(lobby, body.usd);
          await saveLobby(next);
          return res.status(200).json({ ok: true, lobby: await viewOf(next) });
        }

        // ── ready up (each member agrees to the stake) ───────────────────────────────────────────
        if (action === 'lobby-ready') {
          const lobby = await loadLobby(body.lobbyId);
          const err = PL.validateReady({ lobby, addr: me });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const next = PL.applyReady(lobby, me, body.ready !== false);
          await saveLobby(next);
          return res.status(200).json({ ok: true, lobby: await viewOf(next) });
        }

        // ── start ───────────────────────────────────────────────────────────────────────────────
        if (action === 'lobby-start') {
          const lobby = await loadLobby(body.lobbyId);
          const err = PL.validateStart({ lobby, byAddr: me });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const next = PL.applyStart(lobby, now);
          await saveLobby(next);
          return res.status(200).json({ ok: true, lobby: await viewOf(next) });
        }

        // ── read one (members only) ─────────────────────────────────────────────────────────────
        if (action === 'lobby-get') {
          let lobby = await loadLobby(body.lobbyId);
          if (!lobby && body.code) {                       // join-by-code
            const id = await kvGet('plc:' + String(body.code).toUpperCase());
            if (id) lobby = await loadLobby(id);
          }
          if (!lobby) return res.status(404).json({ error: 'lobby not found' });
          if (!PL.isInvited(lobby, me)) return res.status(403).json({ error: 'you need an invite to see this lobby' });
          return res.status(200).json({ ok: true, lobby: await viewOf(lobby) });
        }

        // ── my lobbies ──────────────────────────────────────────────────────────────────────────
        if (action === 'lobby-mine') {
          const z = await kvZrevrange('plu:' + me, 0, 20);
          const ids = []; if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
          const out = [];
          for (const id of ids) {
            const l = await loadLobby(id);
            if (l && PL.isInvited(l, me) && !PL.isExpired(l, now) && l.status !== PL.STATUS.CLOSED) out.push(await viewOf(l));
          }
          return res.status(200).json({ ok: true, lobbies: out });
        }

        // ── handshake token ─────────────────────────────────────────────────────────────────────
        // Short-lived HMAC the GAME SERVER verifies locally with the GAME_SECRET it already holds —
        // no API call on the join path, same trust model as the existing entry token. Bound to BOTH
        // the lobby and the wallet, so it cannot be handed to someone else or reused elsewhere.
        if (action === 'lobby-token') {
          const lobby = await loadLobby(body.lobbyId);
          const err = PL.canJoin({ lobby, addr: me, nowMs: now });
          if (err) return res.status(err === 'lobby not found' ? 404 : 403).json({ error: err });
          const secret = process.env.GAME_SECRET;
          if (!secret) return res.status(500).json({ error: 'server not configured for private lobbies' });
          const expTs = now + 120000;                       // 2 min: long enough to connect, no more
          const sig = crypto.createHmac('sha256', secret).update(PL.inviteCanon(lobby.id, me, lobby.usd, expTs)).digest('hex');
          return res.status(200).json({ ok: true, lobbyId: lobby.id, expTs, sig, region: lobby.region, usd: lobby.usd });
        }

        return res.status(400).json({ error: 'unknown lobby action' });
      }

      // ── action:'settings-get' / 'settings-set' — ACCOUNT-LEVEL client settings ────────────────
      // The account (Privy sub) is the source of truth for every Settings-panel option, including the
      // preferred game server. localStorage is only a cache, so settings follow the player across
      // refreshes, logouts and devices.
      //
      // Deliberately SCHEMA-AGNOSTIC: the server never enumerates the individual settings, it just
      // stores a bounded flat string map. Adding a future setting is a one-line client registry entry
      // with NO server change. Bounds (below) are what keeps that safe.
      if (action === 'settings-get' || action === 'settings-set') {
        if (!sub) return res.status(401).json({ error: 'jwt required' });
        const sKey = 'us:' + sub;

        if (action === 'settings-get') {
          let cur = {};
          try { cur = JSON.parse((await kvGet(sKey)) || '{}') || {}; } catch (_) { cur = {}; }
          return res.status(200).json({ ok: true, settings: cur });
        }

        // settings-set — MERGE, never replace. Two devices editing different settings must not
        // clobber each other, and a client that only knows about 3 of 6 keys must not delete the
        // other 3 (that's exactly how a stale tab would wipe a newer device's preferences).
        const patch = (req.body && req.body.settings) || {};
        if (typeof patch !== 'object' || Array.isArray(patch)) {
          return res.status(400).json({ error: 'settings must be an object' });
        }
        let cur = {};
        try { cur = JSON.parse((await kvGet(sKey)) || '{}') || {}; } catch (_) { cur = {}; }

        // Bounds — a settings blob is user-controlled input, so cap every dimension.
        for (const k of Object.keys(patch)) {
          if (typeof k !== 'string' || k.length > 40) continue;          // key length
          if (!/^[A-Za-z0-9_]+$/.test(k)) continue;                       // key charset
          const v = patch[k];
          if (v === null || v === undefined) { delete cur[k]; continue; } // explicit clear
          const s = String(v);
          if (s.length > 2000) continue;                                  // value size
          cur[k] = s;
        }
        if (Object.keys(cur).length > 60) {                               // total key count
          return res.status(400).json({ error: 'too many settings' });
        }
        const blob = JSON.stringify(cur);
        if (blob.length > 16000) return res.status(400).json({ error: 'settings too large' });

        await kvSetPerm(sKey, blob);
        // Keep the account<->wallet link fresh when we have an address (same as setname does).
        if (address) await recordLink(sub, address).catch(() => {});
        return res.status(200).json({ ok: true, settings: cur });
      }

      if (action !== 'setname' || !address || !name) {
        return res.status(400).json({ error: 'Bad request' });
      }
      const clean = String(name).replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 14).toUpperCase();
      if (!clean) return res.status(400).json({ error: 'Invalid name' });

      // Record the account<->wallet link so this name resolves to this wallet going forward.
      if (sub) await recordLink(sub, address);

      // Name-ownership check. If the name is registered to a DIFFERENT wallet, allow re-pointing it to
      // `address` ONLY when that old wallet belongs to the SAME account (a2c[old] === sub) — i.e. the
      // player reclaiming their own name onto their current wallet. Otherwise it's genuinely taken.
      const existingAddr = await kvGet('nameReg:' + clean);
      if (existingAddr && existingAddr !== address) {
        let ownsOld = false;
        if (sub) { const oldSub = await kvGet('a2c:' + existingAddr); if (oldSub && oldSub === sub) ownsOld = true; }
        if (!ownsOld) return res.status(200).json({ error: 'taken' });
      }

      // Clear old name registry entry if player is changing names (name is account-level,
      // shared across both games — not scoped per-game like the stat counters below)
      const oldName = await kvHget('ph:' + address, 'name');
      if (oldName && oldName !== clean) {
        await kvDel('nameReg:' + oldName.toUpperCase()).catch(()=>{});
        await kvZrem('nameIndex', oldName.toUpperCase()).catch(()=>{});
      }

      // Register new name and persist to player hash
      await kvSetPerm('nameReg:' + clean, address);
      await kvHset('ph:' + address, 'name', clean);
      // nameIndex is a flat list of every registered name (score 0 for all) — the only way
      // to support "search for a player by name" against a KV store with no native scan.
      await kvZadd('nameIndex', 0, clean);

      return res.status(200).json({ ok: true, name: clean });
    } catch (err) {
      console.error('[leaderboard/setname]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const game = gameOf(req.query && req.query.game);

  // ── GET ?resolve=<exact name> — the CURRENT sendable wallet for a name. The friends book calls
  // this right before copy/send so money always goes to the player's current wallet, never a stale
  // one saved months ago. Returns the account's current wallet (or the registered address if there's
  // no account link yet). ──────────────────────────────────────────────────────────────────────────
  if (req.query && req.query.resolve) {
    try {
      const nm = String(req.query.resolve).trim().toUpperCase().slice(0, 14);
      if (!nm) return res.status(200).json({ address: null });
      const reg = await kvGet('nameReg:' + nm);
      if (!reg) return res.status(200).json({ address: null });
      const cur = await currentAddr(reg);
      return res.status(200).json({ name: nm, address: cur });
    } catch (err) {
      console.error('[leaderboard/resolve]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── GET ?search= — find any player by (partial) name, not just the top 20 ──────
  // Backed by nameIndex, a flat set of every registered name — there's no native
  // "search" in a KV store, so this is a substring scan over that list. Fine at
  // current scale; would need a real search index if the player base gets huge.
  if (req.query && req.query.search) {
    try {
      const q = String(req.query.search).trim().toUpperCase().slice(0, 20);
      if (!q) return res.status(200).json({ results: [] });
      const raw = await kvZrevrange('nameIndex', 0, -1) || [];
      const names = [];
      for (let i = 0; i < raw.length; i += 2) names.push(raw[i]);
      const matches = [...new Set(names)].filter(n => n.includes(q)).slice(0, 20);
      const addrs = await Promise.all(matches.map(n => kvGet('nameReg:' + n)));
      const results = (await Promise.all(matches.map(async (name, idx) => {
        const address = addrs[idx];
        if (!address) return null;
        const [stats, cur] = await Promise.all([ readStats(game, address), currentAddr(address) ]);
        return {
          address: cur, name,   // `cur` = the player's CURRENT wallet (what friends copy/send to)
          earned:  stats.earned  || 0,
          wagered: stats.wagered || 0,
          games:   stats.games   || 0,
          kills:   stats.kills   || 0,
          deaths:  stats.deaths  || 0,
          wins:    stats.wins    || 0,
          losses:  stats.losses  || 0,
        };
      }))).filter(Boolean);
      return res.status(200).json({ results });
    } catch (err) {
      console.error('[leaderboard/search]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── GET ?address= — single player profile (+ earnings history for the chart) ────
  if (req.query && req.query.address) {
    try {
      const addr = String(req.query.address).trim();
      const [stats, histRaw] = await Promise.all([
        readStats(game, addr),
        kvLrange('ph:' + game + ':hist:' + addr, 0, 199).catch(() => null),
      ]);
      const hasData = stats.earned > 0 || stats.wagered > 0 || stats.games > 0 || stats.kills > 0 || stats.name;
      if (!hasData) return res.status(200).json({ player: null });
      // kvLpush writes newest-first; reverse to chronological order for the chart
      const history = (histRaw || [])
        .map(s => { try { return JSON.parse(s); } catch (_) { return null; } })
        .filter(Boolean)
        .reverse();
      return res.status(200).json({ player: { address: addr, ...stats, history } });
    } catch (err) {
      console.error('[leaderboard/player]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── GET — top-20 leaderboard (per game) ─────────────────────────────────────
  try {
    // Serve the precomputed blob when it is warm: one GET instead of ~60 commands. Only this
    // no-params branch is cached — the ?address / ?search / ?resolve branches returned earlier and
    // are per-player, so they must never share this key.
    const cacheKey = 'lbcache:' + game;
    const cached = await kvGet(cacheKey);
    if (cached) {
      try {
        const hit = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (hit && Array.isArray(hit.players)) {
          res.setHeader('X-LB-Cache', 'HIT');
          return res.status(200).json(hit);
        }
      } catch (_) { /* corrupt entry — fall through and rebuild it */ }
    }

    const raw = await kvZrevrange('lb:' + game + ':earned', 0, 19) || [];

    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ address: raw[i], score: raw[i + 1] });
    }

    const [playerResults, curAddrs, global] = await Promise.all([
      Promise.all(pairs.map(({ address }) => readStats(game, address))),
      Promise.all(pairs.map(({ address }) => currentAddr(address))),  // resolve each to the player's CURRENT wallet
      readGlobal(game),
    ]);

    const players = pairs.map(({ address }, idx) => {
      const stats = playerResults[idx];
      return {
        rank:    idx + 1,
        address: curAddrs[idx] || address,   // display/send the current wallet, not a stale old one
        name:    stats.name    || '',
        earned:  stats.earned  || 0,
        wagered: stats.wagered || 0,
        games:   stats.games   || 0,
        kills:   stats.kills   || 0,
        deaths:  stats.deaths  || 0,
        wins:    stats.wins    || 0,
        losses:  stats.losses  || 0,
      };
    });

    const payload = { game, players, global };
    // Best-effort store — a cache write that fails must never fail the request. Only cache a board
    // that actually built; caching an empty one during a KV wobble would pin the outage for the
    // whole TTL, which is exactly the failure mode this endpoint just lived through.
    if (players.length > 0) {
      try { await kvSet(cacheKey, JSON.stringify(payload), LB_CACHE_TTL); } catch (_) {}
    }
    res.setHeader('X-LB-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
