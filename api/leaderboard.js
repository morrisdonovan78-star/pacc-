'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const { kvGet, kvSetPerm, kvDel, kvZadd, kvZrem, kvZrevrange,
        kvHget, kvHset, kvHgetall, kvLrange } = require('../lib/kv');
const { verifyPrivyJwt } = require('../lib/privyAuth');

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
// (Privy JWT is now SIGNATURE-verified via lib/privyAuth.verifyPrivyJwt — a forged token can no longer
// claim another account's sub to repoint their wallet.)
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
      const claims = jwt ? await verifyPrivyJwt(jwt) : null;   // SIGNATURE-verified (forgeries rejected)
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
      const hasData = stats.earned > 0 || stats.wagered > 0 || stats.games > 0 || stats.name;
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

    return res.status(200).json({ game, players, global });
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
