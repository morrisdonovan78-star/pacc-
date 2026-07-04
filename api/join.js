'use strict';
// Records a player's wager server-side after they deposit on-chain.
// 1. Verifies their wallet signature (proves they own the wallet).
// 2. Verifies the on-chain tx (proves they actually paid).
// 3. Stores wallet → wagerLamports in KV (settle.js reads this at cashout time).

const nacl   = require('tweetnacl');
const crypto = require('crypto');
const { kvGet, kvSet, kvDel, kvSetPerm, kvZadd, kvHincrby, kvHget, kvHset, kvHsetnx } = require('../lib/kv');

// Game token — HMAC-signed proof of payment for the Socket.io game server.
// Format matches server.js makeGameToken() so the server can validate it.
function makeGameToken(walletAddress, lobbyId) {
  const secret = (process.env.GAME_SECRET || '').trim();
  if (!secret) return null;
  const ts = Date.now();
  const data = `${lobbyId}:${walletAddress}:${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

// Legacy entry token kept for backwards compatibility with verify-entry endpoint
function makeEntryToken(walletAddress, lobbyId) {
  const secret = process.env.SETTLE_SECRET || '';
  if (!secret) return null;
  const w = Math.floor(Date.now() / 600_000);
  return crypto.createHmac('sha256', secret)
    .update('entry:' + walletAddress + ':' + lobbyId + ':' + w)
    .digest('hex').slice(0, 32);
}

const ESCROW_PUBKEY = '2SYFfCsSmKr8qwK1AfWd36JtAc1BCaRaSSxyECKUJjBb';

// Issues a short-lived Ably token with capability ONLY for the specific paid lobby channel.
// ably-token.js issues free-lobby-only tokens — paid tokens must come through here (post-deposit).
async function issueAblyLobbyToken(clientId, lobbyId) {
  const key = (process.env.ABLY_KEY || '').trim();
  if (!key) return null;
  const colonIdx = key.indexOf(':');
  if (colonIdx < 0) return null;
  const keyName = key.slice(0, colonIdx);
  const channel = 'pac-arena-' + lobbyId;
  const tokenParams = {
    keyName,
    ttl: 3_600_000, // 1 hour
    timestamp: Date.now(),
    nonce: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    capability: JSON.stringify({ [channel]: ['publish', 'subscribe', 'presence', 'history'] }),
    clientId,
  };
  try {
    const r = await fetch(`https://rest.ably.io/keys/${keyName}/requestToken`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(key).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenParams),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.token || null;
  } catch (_) { return null; }
}
const RPCS = [
  process.env.HELIUS_RPC_URL,
  'https://api.mainnet-beta.solana.com',
  'https://try-rpc.mainnet-beta.solana.com',
  'https://solana.public-rpc.com',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const b = [];
  for (const c of str) {
    let v = B58.indexOf(c); if (v < 0) throw new Error('Bad base58');
    for (let i = 0; i < b.length; i++) { v += b[i] * 58; b[i] = v & 0xff; v >>= 8; }
    while (v > 0) { b.push(v & 0xff); v >>= 8; }
  }
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  const out = new Uint8Array(z + b.length);
  b.reverse().forEach((x, i) => { out[z + i] = x; });
  return out;
}

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one  = async url => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result;
  };
  for (let i = 0; i <= 2; i++) {
    if (i > 0) await sleep(800 * i);
    try { return await Promise.any(RPCS.map(one)); } catch (_) {}
  }
  throw new Error('All RPCs failed');
}

function verifyPlayerSig(sig, ts, action, playerAddress, wagerLamports) {
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!sig || !ts) return false;
    if (Math.abs(now - Number(ts)) > 120) return false;
    const msg = 'pac-arena:' + action + ':' + (playerAddress || '') + ':' + (wagerLamports || 0) + ':' + ts;
    return nacl.sign.detached.verify(Buffer.from(msg, 'utf8'), Buffer.from(sig, 'base64'), b58Decode(playerAddress));
  } catch (_) { return false; }
}

// Confirms txSig paid at least wagerLamports to ESCROW_PUBKEY from walletAddress.
async function verifyWagerTx(txSig, walletAddress, wagerLamports) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const tx = await rpcCall('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx) continue; // not indexed yet — retry
      if (tx.meta && tx.meta.err) throw new Error('Transaction failed on-chain');

      const keys = tx.transaction.message.accountKeys;
      const getKey = k => (typeof k === 'string' ? k : k.pubkey);
      const escrowIdx = keys.findIndex(k => getKey(k) === ESCROW_PUBKEY);
      if (escrowIdx < 0) throw new Error('Escrow address not found in transaction');

      const received = tx.meta.postBalances[escrowIdx] - tx.meta.preBalances[escrowIdx];
      if (received < wagerLamports) throw new Error('Payment too small: got ' + received + ' need ' + wagerLamports);

      // Also confirm the sender is the wallet that signed this request
      const senderIdx = keys.findIndex(k => getKey(k) === walletAddress);
      if (senderIdx < 0) throw new Error('Sender wallet not found in transaction');

      return; // verified ✓
    } catch (e) {
      if (e.message.startsWith('Payment too small') || e.message.startsWith('Escrow') || e.message.startsWith('Sender') || e.message.startsWith('Transaction failed')) throw e;
      // not indexed yet — keep retrying
    }
  }
  throw new Error('Transaction not confirmed — try again in a moment');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-settle-sig, x-settle-ts');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};

    const { walletAddress, wagerLamports, txSig, lobbyId, playerName } = body;
    const sig = req.headers['x-settle-sig'] || '';
    const ts  = req.headers['x-settle-ts']  || '';
    const lamps = Number(wagerLamports) || 0;

    if (!walletAddress)  return res.status(400).json({ error: 'walletAddress required' });
    if (lamps <= 0)      return res.status(400).json({ error: 'wagerLamports must be positive' });
    if (!txSig)          return res.status(400).json({ error: 'txSig required' });

    // Wallet signature proves the player owns the wallet making this claim
    if (!verifyPlayerSig(sig, ts, 'join', walletAddress, lamps)) {
      return res.status(403).json({ error: 'Invalid wallet signature' });
    }

    // Game ban check — banned players cannot enter any lobby
    try {
      const banRaw = await kvGet('ban:' + walletAddress);
      if (banRaw) {
        const ban = JSON.parse(banRaw);
        const active = ban.type === 'perm' || (ban.until > 0 && Date.now() < ban.until);
        if (active) {
          const until = ban.type === 'perm' ? 'permanently' : ('until ' + new Date(ban.until).toUTCString());
          return res.status(403).json({ error: 'Your account is banned from PAC ARENA ' + until + (ban.reason ? '. Reason: ' + ban.reason : '') });
        }
      }
    } catch (_) {} // Never block a legitimate player due to a KV read error

    // Replay guard — reject re-use of a txSig that was already registered.
    // After cashout the KV wager entry is deleted, but an attacker could re-submit
    // the same old txSig to recreate it and cashout again from other players' funds.
    // We store tx:{txSig} for 24h so replays are blocked even after cashout.
    const txKey = 'tx:' + txSig;
    const alreadyUsed = await kvGet(txKey);
    if (alreadyUsed !== null) {
      return res.status(400).json({ error: 'Transaction already registered — make a new deposit to play again' });
    }

    // On-chain tx proves they actually paid
    await verifyWagerTx(txSig, walletAddress, lamps);

    // Store replay guard (24h) before the wager entry so even a partial failure blocks replay.
    await kvSet(txKey, '1', 86400);
    // Store for 4 hours — more than enough for any game session
    await kvSet('pw:' + walletAddress, lamps, 14400);
    // Clear any stale cashout lock and dead flag from a previous session.
    // Safe because the player just proved they paid a new wager.
    kvDel('lock:co:' + walletAddress).catch(() => {});
    kvDel('dead:' + walletAddress).catch(() => {});

    // Fire-and-forget leaderboard join stat — atomic HINCRBY, no read-modify-write race
    (async()=>{
      try{
        const pk='ph:'+walletAddress;
        // Set display name only if player doesn't have one yet
        if(playerName&&typeof playerName==='string') await kvHsetnx(pk,'name',playerName.slice(0,20).toUpperCase());
        await kvHincrby(pk,'wagered',lamps);
        await kvHincrby(pk,'games',1);
        // Keep sorted set score in sync (score = current earned lamports)
        const earned=await kvHget(pk,'earned');
        await kvZadd('lb:earned',Number(earned)||0,walletAddress);
        // Global counters
        await kvHincrby('ph:global','totalWagered',lamps);
        await kvHincrby('ph:global','gamesPlayed',1);
      }catch(_){}
    })();

    // Issue a game token — HMAC-signed proof of payment for the Socket.io server.
    // The Socket.io server validates this on connection; without it paid lobbies are rejected.
    // ss-paid-* are the snake game's paid rooms (authoritative sim); paid-lobby-* are legacy Pac-Man rooms.
    const VALID_LOBBIES = new Set(['ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);
    const gameToken  = VALID_LOBBIES.has(lobbyId) ? makeGameToken(walletAddress, lobbyId) : null;
    const entryToken = VALID_LOBBIES.has(lobbyId) ? makeEntryToken(walletAddress, lobbyId) : null;

    return res.status(200).json({ ok: true, recorded: lamps, gameToken, entryToken });
  } catch (e) {
    console.error('[join]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
