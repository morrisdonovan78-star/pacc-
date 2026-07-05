'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const { kvGet, kvSetPerm, kvDel, kvZadd, kvZrem, kvZrevrange,
        kvHget, kvHset, kvHgetall, kvLrange } = require('../lib/kv');

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
      const { action, address, name } = req.body || {};
      if (action !== 'setname' || !address || !name) {
        return res.status(400).json({ error: 'Bad request' });
      }
      const clean = String(name).replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 14).toUpperCase();
      if (!clean) return res.status(400).json({ error: 'Invalid name' });

      // Check if name is already taken by a different address
      const existingAddr = await kvGet('nameReg:' + clean);
      if (existingAddr && existingAddr !== address) {
        return res.status(200).json({ error: 'taken' });
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

  // ── TEMP one-time migration — remove after running once ─────────────────────
  // The previous nameIndex backfill only wrote nameIndex, never nameReg — so search could
  // list a name but could never resolve it to an address (readStats needs nameReg to find
  // the wallet). Worse, join.js (the ONLY place Slither Snakes ever registers a name
  // server-side — its client "save name" button is localStorage-only) never wrote either
  // key at all, so no Slither Snakes player was ever searchable. This redoes the backfill
  // correctly (nameReg + nameIndex, for anyone in either game's leaderboard sorted set) now
  // that join.js also maintains both going forward.
  if (req.method === 'GET' && req.query && req.query.do === 'backfill-names-v2' &&
      req.query.token === 'MkX8KbjmendOkpqoRa_RklStNx6J-DM-') {
    try {
      let indexed = 0, skippedFallback = 0;
      const seen = new Set();
      // 'SNAKE' is the client's generic fallback name, not a real chosen one (see join.js) —
      // never index it, and scrub it out if some earlier join already registered it for
      // whichever address happened to join without a custom name most recently.
      await kvDel('nameReg:SNAKE').catch(() => {});
      await kvZrem('nameIndex', 'SNAKE').catch(() => {});
      for (const g of ['ss', 'pac']) {
        const raw = await kvZrevrange('lb:' + g + ':earned', 0, -1) || [];
        for (let i = 0; i < raw.length; i += 2) {
          const addr = raw[i];
          if (seen.has(addr)) continue;
          seen.add(addr);
          const name = await kvHget('ph:' + addr, 'name');
          if (name && name !== 'SNAKE') {
            await kvSetPerm('nameReg:' + name, addr);
            await kvZadd('nameIndex', 0, name);
            indexed++;
          } else if (name === 'SNAKE') {
            skippedFallback++;
          }
        }
      }
      return res.status(200).json({ ok: true, indexed, skippedFallback });
    } catch (err) {
      console.error('[leaderboard/backfill-v2]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const game = gameOf(req.query && req.query.game);

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
        const stats = await readStats(game, address);
        return {
          address, name,
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

    const [playerResults, global] = await Promise.all([
      Promise.all(pairs.map(({ address }) => readStats(game, address))),
      readGlobal(game),
    ]);

    const players = pairs.map(({ address }, idx) => {
      const stats = playerResults[idx];
      return {
        rank:    idx + 1,
        address,
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
