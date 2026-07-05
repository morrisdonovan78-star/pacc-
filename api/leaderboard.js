'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const { kvGet, kvSetPerm, kvDel, kvZadd, kvZrevrange,
        kvHget, kvHset, kvHgetall } = require('../lib/kv');

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
      }

      // Register new name and persist to player hash
      await kvSetPerm('nameReg:' + clean, address);
      await kvHset('ph:' + address, 'name', clean);

      return res.status(200).json({ ok: true, name: clean });
    } catch (err) {
      console.error('[leaderboard/setname]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── TEMP one-time migration — remove after running once ─────────────────────
  // Commit 6640ac3 split leaderboard stats per-game but left the pre-existing unscoped
  // data (ph:{addr} / lb:earned / ph:global) behind, so the new pac-scoped keys came up
  // empty. That old data all predates Slither Snakes' paid lobbies going live, so it's
  // safe to copy it forward as Pac-Man history. Non-destructive: only copies, never deletes.
  if (req.method === 'GET' && req.query && req.query.do === 'migrate-pac-once' &&
      req.query.token === 'heMYW9wYbzmafdoNfJrEO1S99t7SFSZd') {
    try {
      const raw = await kvZrevrange('lb:earned', 0, -1) || [];
      const pairs = [];
      for (let i = 0; i < raw.length; i += 2) pairs.push({ address: raw[i], score: raw[i + 1] });

      const FIELDS = ['earned', 'wagered', 'games', 'kills', 'deaths', 'wins', 'losses'];
      let migrated = 0;
      for (const { address, score } of pairs) {
        await kvZadd('lb:pac:earned', Number(score) || 0, address);
        const h = await kvHgetall('ph:' + address);
        if (h) {
          for (const f of FIELDS) if (h[f] !== undefined) await kvHset('ph:pac:' + address, f, h[f]);
        }
        migrated++;
      }

      const g = await kvHgetall('ph:global');
      if (g) {
        for (const f of ['totalEarned', 'totalWagered', 'gamesPlayed']) {
          if (g[f] !== undefined) await kvHset('ph:pac:global', f, g[f]);
        }
      }

      return res.status(200).json({ ok: true, migrated, players: pairs.length });
    } catch (err) {
      console.error('[leaderboard/migrate]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const game = gameOf(req.query && req.query.game);

  // ── GET ?address= — single player profile ───────────────────────────────────
  if (req.query && req.query.address) {
    try {
      const addr = String(req.query.address).trim();
      const stats = await readStats(game, addr);
      const hasData = stats.earned > 0 || stats.wagered > 0 || stats.games > 0 || stats.name;
      if (!hasData) return res.status(200).json({ player: null });
      return res.status(200).json({ player: { address: addr, ...stats } });
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
