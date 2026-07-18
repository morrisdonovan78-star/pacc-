'use strict';
// Records a player's wager server-side after they deposit on-chain.
// 1. Verifies their wallet signature (proves they own the wallet).
// 2. Verifies the on-chain tx (proves they actually paid).
// 3. Stores wallet → wagerLamports in KV (settle.js reads this at cashout time).

const nacl   = require('tweetnacl');
const crypto = require('crypto');
const { kvGet, kvSet, kvDel, kvSetPerm, kvZadd, kvZrem, kvHincrby, kvHget, kvHset } = require('../lib/kv');

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

// ── LOOKUP THAT PREFERS THE NODE THAT ACTUALLY FOUND IT ────────────────────────────────────────
// rpcCall races with Promise.any, which resolves on the fastest SUCCESSFUL response. For a lookup
// like getTransaction that is fatal, because a node which has not indexed the signature yet answers
// `null` — successfully. So the fastest un-indexed node wins the race and reports "not found" while
// a slower node already has the transaction. That is the "Still verifying deposit… (2/4)(3/4)(4/4)"
// failure: the SOL is on chain, we just kept asking whoever was quickest to say no.
//
// This is the same trap already fixed in api/rpc.js for getSignatureStatuses; api/join.js has its
// own rpcCall and never got it. Here we resolve on the first node that returns a NON-NULL result,
// and only conclude "not found" once every node has answered.
async function rpcCallFound(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async url => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result;
  };
  return await new Promise(resolve => {
    let left = RPCS.length;
    let settled = false;
    if (!left) return resolve(null);
    for (const url of RPCS) {
      one(url).then(res => {
        if (settled) return;
        if (res != null) { settled = true; return resolve(res); }   // this node HAS it — take it
        if (--left === 0) { settled = true; resolve(null); }        // everyone says not-found
      }).catch(() => {
        if (settled) return;
        if (--left === 0) { settled = true; resolve(null); }
      });
    }
  });
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
  for (let attempt = 0; attempt < 6; attempt++) {
    // Short early waits (a confirmed tx is usually indexed within a couple of seconds), then longer
    // ones. The old flat 1500ms x4 gave up after ~6s, which is inside the window where public RPCs
    // are still catching up — that is why a real, paid deposit reported "not confirmed".
    if (attempt > 0) await sleep(attempt <= 2 ? 900 : 2200);
    try {
      const tx = await rpcCallFound('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx) continue; // genuinely not indexed on ANY node yet — retry
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

    // Leaderboard join stat — atomic HINCRBY, no read-modify-write race. Stats are scoped
    // per-game (ss-* lobbyId = Slither Snakes, everything else = Pac-Man) so the two games'
    // leaderboards never mix, even for a wallet that plays both.
    // AWAITED (not fire-and-forget): Vercel can freeze/kill the function the instant the
    // response is sent, so an un-awaited background write is a coin flip on whether it
    // finishes — that's exactly what caused games/wagered to go missing while a later,
    // properly-awaited request (e.g. cashout) recorded fine. Errors are still swallowed so
    // a stats hiccup never fails the actual join.
    try{
      const game=(lobbyId&&lobbyId.startsWith('ss-'))?'ss':'pac';
      const namePk='ph:'+walletAddress;      // display name is shared across both games
      const statsPk='ph:'+game+':'+walletAddress;
      // Register/update display name. This is the ONLY place Slither Snakes ever registers a
      // name server-side (its client-side "save name" button is localStorage-only) — so
      // nameReg/nameIndex have to be maintained here too, or player-search would never find
      // any Slither Snakes player.
      //
      // 'SNAKE' is the client's fallback name (slither-snakes.html getMyName()) sent whenever
      // someone hasn't typed a custom one — NOT a real chosen name. Two things this guards
      // against, both previously live bugs:
      //  1. Registering it would let one arbitrary address squat nameReg:SNAKE, and every
      //     other un-named player's join would silently overwrite that mapping too.
      //  2. The old kvHsetnx (set-only-if-absent) permanently locked a player's name to
      //     whatever they had on their FIRST-EVER join. If that first join happened before
      //     they typed a real name, they were stuck showing as "SNAKE" forever — even after
      //     typing and saving a real one, since the field already had a value. Using an
      //     unconditional update (when the new name differs and isn't the fallback) lets a
      //     real name set later actually take effect on the next join.
      if(playerName&&typeof playerName==='string'){
        const clean=String(playerName).replace(/[^A-Za-z0-9_\- ]/g,'').trim().slice(0,20).toUpperCase();
        if(clean&&clean!=='SNAKE'){
          const current=await kvHget(namePk,'name');
          if(current!==clean){
            if(current) { await kvDel('nameReg:'+current).catch(()=>{}); await kvZrem('nameIndex',current).catch(()=>{}); }
            await kvHset(namePk,'name',clean);
            await kvSetPerm('nameReg:'+clean, walletAddress);
            await kvZadd('nameIndex', 0, clean);
          }
        }
      }
      await kvHincrby(statsPk,'wagered',lamps);
      await kvHincrby(statsPk,'games',1);
      // Keep sorted set score in sync (score = current earned lamports)
      const earned=await kvHget(statsPk,'earned');
      await kvZadd('lb:'+game+':earned',Number(earned)||0,walletAddress);
      // Global counters
      await kvHincrby('ph:'+game+':global','totalWagered',lamps);
      await kvHincrby('ph:'+game+':global','gamesPlayed',1);
    }catch(_){}

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
