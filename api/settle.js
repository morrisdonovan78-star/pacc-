// api/settle.js — tweetnacl only, no @solana/web3.js (ESM/runtime issues)
'use strict';
const nacl    = require('tweetnacl');
const crypto  = require('crypto');
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const { kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvHincrby } = require('../lib/kv');

// ── Ed25519 wallet signature verification ─────────────────────────────────────
// The client signs: "pac-arena:{action}:{playerAddress}:{wagerLamports}:{unixTs}"
// using their Solana wallet private key (tweetnacl detached signature).
// Only the real wallet owner can produce a valid signature — forged cashouts are impossible.
function verifyPlayerSig(sig, ts, action, playerAddress, wagerLamports) {
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!sig || !ts) return false;
    if (Math.abs(now - Number(ts)) > 120) return false; // 2-minute window
    const msg = 'pac-arena:' + action + ':' + (playerAddress||'') + ':' + (wagerLamports||0) + ':' + ts;
    const msgBytes  = Buffer.from(msg, 'utf8');
    const sigBytes  = Buffer.from(sig, 'base64');
    const pubBytes  = b58Decode(playerAddress);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  } catch (_) { return false; }
}

const CREATOR_WALLET  = '2ZLqQww5koLr2J7PU54UwA7yNX4DRmMHMLAQjm411E7a';
const CREATOR_FEE_PCT = 0.10;
const TX_FEE          = 5000;  // exact Solana base fee (5000 lamports × 1 signature, no priority fees)
// Solana requires a system account's balance to be either exactly 0 OR >= RENT_MIN.
// It must NEVER sit between 0 and RENT_MIN — that triggers InsufficientFundsForRent.
// Players no longer deposit RENT_MIN on join (v23 client fix); the settle handler
// uses a sub-rent safety check to drain the escrow to exactly 0 when needed.
const RENT_MIN        = 890880; // lamports — used only for the sub-rent safety check below

// ── RPC endpoint list ────────────────────────────────────────────────────────
// All Vercel serverless functions share the same outbound IP pool.
// Public Solana RPCs rate-limit by IP — under game load ALL public nodes 429.
//
// FIX: Add your free Helius API key as a Vercel environment variable:
//   HELIUS_RPC_URL = https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
//   Sign up free at https://helius.dev (no credit card, 50 req/s)
//
// Until then we fall back to public nodes with batching + skip-preflight
// to reduce calls from ~10 down to ~4 per cashout.
const RPCS = [
  process.env.HELIUS_RPC_URL,                        // PRIMARY: set in Vercel env vars
  'https://api.mainnet-beta.solana.com',              // Solana official (rate-limited under load)
  'https://try-rpc.mainnet-beta.solana.com',          // Solana second official node
  'https://solana.public-rpc.com',                    // community public
  'https://solana-mainnet.g.alchemy.com/v2/demo',     // Alchemy demo
].filter(Boolean); // drop undefined (HELIUS_RPC_URL not set yet)

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const b = [];
  for (const c of str) {
    let v = B58.indexOf(c);
    if (v < 0) throw new Error('Bad base58 char: ' + c);
    for (let i = 0; i < b.length; i++) { v += b[i] * 58; b[i] = v & 0xff; v >>= 8; }
    while (v > 0) { b.push(v & 0xff); v >>= 8; }
  }
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  const out = new Uint8Array(z + b.length);
  b.reverse().forEach((x, i) => { out[z + i] = x; });
  return out;
}
function b58Encode(u8) {
  const d = [];
  for (const byte of u8) {
    let c = byte;
    for (let i = 0; i < d.length; i++) { c += d[i] * 256; d[i] = c % 58; c = Math.floor(c / 58); }
    while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); }
  }
  let p = ''; for (const b of u8) { if (b !== 0) break; p += '1'; }
  return p + d.reverse().map(x => B58[x]).join('');
}
// compact-u16 encoding used in Solana transaction wire format
function cu16(n) {
  if (n < 0x80)   return [n];
  if (n < 0x4000) return [(n & 0x7f) | 0x80, (n >> 7) & 0xff];
  return [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0xff];
}

// ── Escrow keypair from env ──────────────────────────────────────────────────
function getEscrow() {
  const raw = (process.env.ESCROW_SECRET || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('ESCROW_SECRET not set');
  let arr; try { arr = JSON.parse(raw); } catch (e) { throw new Error('ESCROW_SECRET bad JSON: ' + e.message); }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error('ESCROW_SECRET must be 64-byte array');
  const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(arr));
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, pubkeyB58: b58Encode(kp.publicKey) };
}

// ── Single-method RPC call — race all nodes, retry 3× on any failure ────────
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  let lastMsg = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try { return await Promise.any(RPCS.map(one)); }
    catch (e) {
      lastMsg = (e.errors || []).map(x => x.message).join(' | ');
      if (attempt < 2) { console.warn('[rpc] attempt ' + (attempt + 1) + ' failed (' + lastMsg + ') — retrying…'); continue; }
      throw new Error('All RPCs failed: ' + lastMsg);
    }
  }
}

// ── Batched getBalance + getLatestBlockhash in ONE HTTP request ───────────────
// JSON-RPC batching halves pre-transaction RPC calls (2 → 1 HTTP round-trip).
// JSON-RPC batching halves pre-transaction RPC round-trips (2 → 1 HTTP request).
async function fetchBalAndHash(escPubkey) {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'getBalance',         params: [escPubkey, { commitment: 'confirmed' }] },
    { jsonrpc: '2.0', id: 2, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
  ];
  const body = JSON.stringify(batch);
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('Expected array from batch RPC');
    const balEntry = arr.find(x => x.id === 1);
    const bhEntry  = arr.find(x => x.id === 2);
    if (balEntry?.error) throw new Error('getBalance error: ' + balEntry.error.message);
    if (bhEntry?.error)  throw new Error('getBlockhash error: ' + bhEntry.error.message);
    const bal = typeof balEntry?.result?.value === 'number' ? balEntry.result.value
              : typeof balEntry?.result       === 'number' ? balEntry.result : null;
    const blockhash = bhEntry?.result?.value?.blockhash ?? bhEntry?.result?.blockhash ?? null;
    if (bal === null) throw new Error('Bad balance in batch response');
    if (!blockhash)  throw new Error('Bad blockhash in batch response');
    return { bal, blockhash };
  };
  let lastMsg = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try { return await Promise.any(RPCS.map(one)); }
    catch (e) {
      lastMsg = (e.errors || []).map(x => x.message).join(' | ');
      if (attempt < 2) { console.warn('[rpc-batch] attempt ' + (attempt + 1) + ' failed (' + lastMsg + ') — retrying…'); continue; }
      throw new Error('All RPCs failed (balance+blockhash): ' + lastMsg);
    }
  }
}

// ── Build & sign a Solana legacy transaction (escrow signs) ──────────────────
function buildTx(esc, blockhash, transfers) {
  // Validate inputs before doing anything
  if (!blockhash || typeof blockhash !== 'string') throw new Error('buildTx: missing blockhash');
  for (const t of transfers) {
    if (!t.to || t.to.length !== 32) throw new Error('buildTx: recipient must be 32 bytes, got ' + (t.to && t.to.length));
    const lamps = Math.round(Number(t.lamports));
    if (!Number.isFinite(lamps) || lamps <= 0) throw new Error('buildTx: invalid lamports=' + t.lamports);
    t.lamports = lamps; // normalise to integer
  }

  // Account list: escrow, ...recipients, system_program
  const SYS = new Uint8Array(32); // system program = all zeros
  const accts = [esc.publicKey];
  for (const t of transfers) {
    if (!accts.some(a => a.every((v, i) => v === t.to[i]))) accts.push(t.to);
  }
  accts.push(SYS);
  const sysIdx = accts.length - 1;

  // Header: [numRequiredSig, numReadonlySignedAccts, numReadonlyUnsignedAccts]
  // escrow=writable+signer, recipients=writable, system=readonly
  const header = new Uint8Array([1, 0, 1]);

  // Account keys: compact-u16 count + 32 bytes each
  const keys = new Uint8Array([...cu16(accts.length), ...accts.flatMap(a => [...a])]);

  // Recent blockhash (32 bytes decoded from base58)
  const bh = b58Decode(blockhash);
  if (bh.length !== 32) throw new Error('buildTx: blockhash decoded to ' + bh.length + ' bytes (expected 32)');

  // Instructions: compact-u16 count, then each instruction
  const ixs = [transfers.length]; // compact-u16 count (always < 128)
  for (const t of transfers) {
    const toIdx = accts.findIndex(a => a.every((v, i) => v === t.to[i]));
    if (toIdx < 0) throw new Error('buildTx: recipient not found in account list');
    // Bincode-encoded SystemProgram::Transfer { lamports }
    // discriminant u32-LE = 2, then lamports u64-LE
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);           // Transfer discriminant
    new DataView(data.buffer).setBigUint64(4, BigInt(t.lamports), true);
    // instruction: programIdIndex, accounts (cu16 len + indices), data (cu16 len + bytes)
    ixs.push(sysIdx, 2, 0, toIdx, ...cu16(data.length), ...data);
  }

  // Assemble message
  const msg = new Uint8Array([...header, ...keys, ...bh, ...ixs]);

  // Sign
  const sig = nacl.sign.detached(msg, esc.secretKey);

  // Wire format: compact-u16 sigcount + sig + message
  return new Uint8Array([1, ...sig, ...msg]);
}

// ── Send tx AND wait for on-chain confirmation ───────────────────────────────
// Returns { sig, confirmed } where confirmed=true means we observed on-chain confirmation.
// confirmed=false means the TX was sent successfully but hasn't confirmed in our short poll
// window — it will confirm within a few more seconds on-chain.
async function sendAndConfirm(txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');
  let sig;
  try {
    // skipPreflight:false — RPC simulates the tx before broadcasting.
    // If simulation fails (e.g. InsufficientFundsForRent) NO fee is charged from escrow
    // and we get an immediate -32002 error that triggers the retry loop with a fresh balance.
    // With Helius at 50 req/s the extra simulation call is not a problem.
    sig = await rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    throw new Error('Send failed: ' + e.message);
  }
  console.log('[settle] sent sig=' + sig);

  // Quick poll — 2 checks at 1.5s intervals (3s total).
  // This catches most confirmations (Solana typically confirms in 1-2 slots ≈ 0.4-0.8s).
  // If not confirmed within 3s we return immediately with confirmed:false — the TX is
  // already in the network and WILL confirm. Keeping the poll short prevents the function
  // from approaching the 60s Vercel timeout when RPCs are slow.
  for (let i = 0; i < 2; i++) {
    await sleep(1500);
    try {
      const res = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = res && res.value && res.value[0];
      if (s) {
        if (s.err) {
          console.error('[settle] TX FAILED on-chain sig=' + sig + ' err=' + JSON.stringify(s.err));
          throw new Error('TX rejected on-chain: ' + JSON.stringify(s.err));
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log('[settle] confirmed sig=' + sig + ' status=' + s.confirmationStatus);
          return { sig, confirmed: true };
        }
      }
    } catch (e) {
      if (e.message.startsWith('TX rejected')) throw e;
      // RPC poll error — keep trying
    }
  }
  // Not confirmed in 3s — return optimistically. TX is in the mempool and will land.
  console.log('[settle] sent (unconfirmed yet) sig=' + sig + ' — client will see balance update shortly');
  return { sig, confirmed: false };
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  let done = false;
  const guard = setTimeout(() => {
    if (!done) { done = true; try { res.status(500).json({ error: 'Timed out — try again' }); } catch (_) {} }
  }, 55000);

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-settle-sig, x-settle-ts');
    if (req.method === 'OPTIONS') { clearTimeout(guard); done = true; return res.status(200).end(); }
    if (req.method !== 'POST')   { clearTimeout(guard); done = true; return res.status(405).end(); }

    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};

    const { action, playerAddress } = body;
    const wagerLamportsRaw = Number(body.wagerLamports) || 0;

    // ── elim-lock: game server calls this immediately on kill to block victim cashout ──
    if (action === 'elim-lock') {
      const adminSec  = (req.headers['x-admin-secret'] || '').trim();
      const serverSec = (process.env.ADMIN_SECRET || '').trim();
      if (!adminSec || !serverSec || adminSec !== serverSec) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { victimAddress } = body;
      if (!victimAddress || typeof victimAddress !== 'string' || victimAddress.length < 20) {
        clearTimeout(guard); done = true;
        return res.status(400).json({ error: 'victimAddress required' });
      }
      // Set dead flag (blocks cashout) and atomically delete their wager record simultaneously
      await Promise.all([
        kvSet('dead:' + victimAddress, '1', 600),
        kvGetDel('pw:' + victimAddress),
      ]).catch(() => {});
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
    }

    // ── Wallet signature auth — required for all fund-moving actions ─────────
    // The player signs the request with their Solana private key.
    // Only the real wallet owner can produce a valid signature.
    if (action !== 'balance') {
      const sig = req.headers['x-settle-sig'] || '';
      const ts  = req.headers['x-settle-ts']  || '';
      if (!verifyPlayerSig(sig, ts, action, playerAddress || '', wagerLamportsRaw)) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Invalid wallet signature — cashout must originate from the game client' });
      }
    }

    const esc = getEscrow();

    // ── balance ───────────────────────────────────────────────────────────────
    if (action === 'balance') {
      const bal = await rpc('getBalance', [esc.pubkeyB58, { commitment: 'confirmed' }]);
      clearTimeout(guard); done = true;
      return res.status(200).json({ balance: bal.value, escrowPubkey: esc.pubkeyB58, solBalance: bal.value / 1e9 });
    }

    // ── cashout / win ─────────────────────────────────────────────────────────
    if (action === 'cashout' || action === 'win') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const playerPubkey = b58Decode(playerAddress);
      if (playerPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be a 32-byte Solana address' }); }

      // NX lock: only one cashout can run at a time per wallet.
      // Prevents two concurrent requests from both reading kvWager > 0 and both sending txs.
      const coLockKey = 'lock:co:' + playerAddress;
      const coLock = await kvSetNX(coLockKey, '1', 20);
      if (!coLock) {
        clearTimeout(guard); done = true;
        return res.status(429).json({ error: 'Cashout already in progress — wait a moment and try again' });
      }

      try {
        // Dead check: if the kill handler (or elim-lock) already marked this player dead,
        // refuse cashout even if their wager record briefly still exists.
        const isDead = await kvGet('dead:' + playerAddress);
        if (isDead) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'Cannot cashout — you were eliminated' });
        }
        // GETDEL atomically reads and deletes the wager in one step.
        // This eliminates the race where a kill could delete it after we read it but before we finish.
        const kvWager = Number(await kvGetDel('pw:' + playerAddress)) || 0;
        if (kvWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'No wager on record — you may have been eliminated or already cashed out' });
        }
        // Second dead check: catches kills that raced with our kvGetDel above.
        // elim-lock or settle/kill may have set dead: in the ~5 ms between our first check and here.
        // Restore the wager so the kill-reward path is unaffected, then reject.
        const isDeadNow = await kvGet('dead:' + playerAddress);
        if (isDeadNow) {
          kvSet('pw:' + playerAddress, String(kvWager), 600).catch(() => {});
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'Cannot cashout — you were eliminated' });
        }
        // Use client-signed accumulated amount (initial wager + kill-food winnings).
        // kvWager confirms the player has an active deposit; wagerLamportsRaw is the signed total they claim.
        // Cap at 20× initial to guard against fraudulent inflation; avail caps the actual transfer.
        const wagerLamports = wagerLamportsRaw > kvWager
          ? Math.min(wagerLamportsRaw, kvWager * 20)
          : kvWager;
        console.log('[settle] cashout kv=' + kvWager + ' signed=' + wagerLamportsRaw + ' using=' + wagerLamports);

        let sig, playerCut, creatorCut, txConfirmed = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) await sleep(1200);
          const { bal, blockhash } = await fetchBalAndHash(esc.pubkeyB58);
          console.log('[settle] cashout attempt=' + attempt + ' bal=' + bal + ' blockhash=' + blockhash.slice(0,8) + '… player=' + playerAddress.slice(0,8) + '…');
          const avail = bal - TX_FEE;
          if (avail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow balance too low to cashout — try again shortly' }); }
          let payout = wagerLamports > 0 ? Math.min(wagerLamports, avail) : avail;
          const remaining = avail - payout;
          if (remaining > 0 && remaining < RENT_MIN) { payout = avail; }
          creatorCut = Math.floor(payout * CREATOR_FEE_PCT);
          playerCut  = payout - creatorCut;
          console.log('[settle] cashout payout=' + payout + ' (wager=' + wagerLamports + ' avail=' + avail + ' remaining=' + remaining + ') player=' + playerCut + ' creator=' + creatorCut);
          const transfers = creatorCut > 0
            ? [{ to: playerPubkey, lamports: playerCut }, { to: b58Decode(CREATOR_WALLET), lamports: creatorCut }]
            : [{ to: playerPubkey, lamports: payout }];
          try {
            const tx = buildTx(esc, blockhash, transfers);
            const result = await sendAndConfirm(tx);
            sig = result.sig; txConfirmed = result.confirmed;
            (async()=>{ try{ await kvDel('krl:'+playerAddress); }catch(_){} })();
            (async()=>{
              try{
                const pk='ph:'+playerAddress;
                const newEarned=await kvHincrby(pk,'earned',playerCut);
                await kvHincrby(pk,'wins',1);
                await kvZadd('lb:earned',Number(newEarned)||0,playerAddress);
                await kvHincrby('ph:global','totalEarned',playerCut);
              }catch(_){}
            })();
            break;
          } catch (e) {
            const isOnChainFail = e.message.includes('TX rejected') || e.message.includes('insufficient') || e.message.includes('0x1') || e.message.includes('-32002') || e.message.includes('Send failed');
            if (attempt < 2 && isOnChainFail) {
              console.warn('[settle] cashout attempt ' + attempt + ' fail (' + e.message.slice(0, 80) + ') — retrying with fresh balance');
              continue;
            }
            throw e;
          }
        }
        clearTimeout(guard); done = true;
        return res.status(200).json({ sig, playerCut, creatorCut, confirmed: txConfirmed });
      } finally {
        await kvDel(coLockKey);
      }
    }

    // ── kill ──────────────────────────────────────────────────────────────────
    if (action === 'kill') {
      if (!playerAddress || !body.wagerLamports) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress + wagerLamports required' }); }
      const killPubkey = b58Decode(playerAddress);
      if (killPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be 32 bytes' }); }

      // Fail CLOSED: if GAME_SECRET is missing the kill proof cannot be verified —
      // deny the claim entirely rather than skipping the gate and allowing console drains.
      if (!GAME_SECRET) {
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: 'Kill rewards not available — server configuration error' });
      }

      const kpBody = typeof body.killProof === 'string' ? body.killProof : '';
      const ktBody = Number(body.killTs) || 0;
      const vaBody = typeof body.victimAddress === 'string' ? body.victimAddress : '';

      // Validate proof format and freshness before touching KV
      const proofAge = Date.now() - ktBody;
      if (!kpBody || kpBody.length !== 64 || !ktBody || !vaBody || proofAge > 300000 || proofAge < 0) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Kill proof required — must originate from an active game' });
      }

      // Verify HMAC first (cheap CPU check before any KV writes)
      const expectedProof = crypto.createHmac('sha256', GAME_SECRET).update(`${playerAddress}:${vaBody}:${ktBody}`).digest('hex');
      let proofOk = false;
      try { proofOk = crypto.timingSafeEqual(Buffer.from(expectedProof), Buffer.from(kpBody)); } catch (_) {}
      if (!proofOk) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Invalid kill proof' });
      }

      // Atomically claim this proof via NX — only the first request wins even under concurrent load.
      // Eliminates the read-then-write race in the old pattern.
      // No per-wallet rate limit: each kill event has a unique proof (killerId:victimId:timestamp),
      // so back-to-back kills each get their own proof and are all paid immediately.
      const proofClaimed = await kvSetNX('kpu:' + kpBody, '1', 300);
      if (!proofClaimed) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Kill proof already redeemed' });
      }

      // Immediately block victim cashout: set dead flag + atomically remove their wager.
      // This runs BEFORE the TX so even if the cashout request is in-flight right now,
      // it will hit the dead check or find no wager record and be refused.
      if (vaBody && vaBody !== playerAddress && vaBody.length > 20) {
        await Promise.all([
          kvSet('dead:' + vaBody, '1', 600),
          kvGetDel('pw:' + vaBody),
        ]).catch(() => {});
      }

      // Retry once on on-chain fail — concurrent kills can race on the shared escrow balance
      let sig, killerCut, creatorCut, txConfirmed2 = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) await sleep(1200);
        const { bal: killBal, blockhash: killHash } = await fetchBalAndHash(esc.pubkeyB58);
        console.log('[settle] kill attempt=' + attempt + ' bal=' + killBal + ' blockhash=' + killHash.slice(0,8) + '… killer=' + playerAddress.slice(0,8) + '… wager=' + body.wagerLamports);
        const killAvail = killBal - TX_FEE;
        if (killAvail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
        // Kill reward capped by killer's KV-recorded wager — prevents anyone without an active deposit from draining escrow
        const kvKillWager = Number(await kvGet('pw:' + playerAddress)) || 0;
        if (kvKillWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'No active wager on record — must join with a deposit before claiming kill rewards' });
        }
        let total = Math.min(kvKillWager, killAvail);
        const killRemaining = killAvail - total;
        if (killRemaining > 0 && killRemaining < RENT_MIN) { total = killAvail; }
        creatorCut = Math.floor(total * CREATOR_FEE_PCT);
        killerCut  = total - creatorCut;
        console.log('[settle] kill total=' + total + ' killer=' + killerCut + ' creator=' + creatorCut);
        const transfers = creatorCut > 0
          ? [{ to: killPubkey, lamports: killerCut }, { to: b58Decode(CREATOR_WALLET), lamports: creatorCut }]
          : [{ to: killPubkey, lamports: total }];
        try {
          const tx = buildTx(esc, killHash, transfers);
          const result2 = await sendAndConfirm(tx);
          sig = result2.sig; txConfirmed2 = result2.confirmed;
          (async()=>{
            try{
              const pk='ph:'+playerAddress;
              await kvHincrby(pk,'kills',1);
              const newEarned=await kvHincrby(pk,'earned',killerCut||0);
              await kvZadd('lb:earned',Number(newEarned)||0,playerAddress);
              // Track death for victim — must happen regardless of wager since victim's
              // wager was already deleted above, so their settle/lose won't count it.
              if(vaBody && vaBody!==playerAddress) {
                await kvHincrby('ph:'+vaBody,'deaths',1);
              }
            }catch(_){}
          })();
          break;
        } catch (e) {
          const isOnChainFail = e.message.includes('TX rejected') || e.message.includes('insufficient') || e.message.includes('0x1') || e.message.includes('-32002') || e.message.includes('Send failed');
          if (attempt < 2 && isOnChainFail) {
            console.warn('[settle] kill attempt ' + attempt + ' fail (' + e.message.slice(0, 80) + ') — retrying');
            continue;
          }
          throw e;
        }
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ sig, amount: killerCut, creatorCut, confirmed: txConfirmed2 });
    }

    // ── lose ──────────────────────────────────────────────────────────────────
    if (action === 'lose') {
      // NX lock: prevents two concurrent lose requests from both sending txs
      const loLockKey = 'lock:lo:' + playerAddress;
      const loLock = await kvSetNX(loLockKey, '1', 20);
      if (!loLock) {
        clearTimeout(guard); done = true;
        return res.status(429).json({ error: 'Payout already in progress — wait a moment' });
      }

      try {
        const kvLoseWager = Number(await kvGet('pw:' + playerAddress)) || 0;
        if (kvLoseWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(200).json({ sig: null, amount: 0, confirmed: true });
        }
        const { bal: loseBal, blockhash: loseHash } = await fetchBalAndHash(esc.pubkeyB58);
        const loseAvail = loseBal - TX_FEE;
        if (loseAvail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
        const loseAmt = Math.min(kvLoseWager, loseAvail);
        const remaining = loseAvail - loseAmt;
        const finalAmt  = (remaining > 0 && remaining < RENT_MIN) ? loseAvail : loseAmt;
        const tx = buildTx(esc, loseHash, [{ to: b58Decode(CREATOR_WALLET), lamports: finalAmt }]);
        const { sig: loseSig, confirmed: loseConfirmed } = await sendAndConfirm(tx);
        await kvDel('pw:' + playerAddress);
        (async()=>{ try{ await kvDel('krl:'+playerAddress); await kvDel('kc:'+playerAddress); }catch(_){} })();
        (async()=>{
          try{
            await kvHincrby('ph:'+playerAddress,'losses',1);
            await kvHincrby('ph:'+playerAddress,'deaths',1);
          }catch(_){}
        })();
        clearTimeout(guard); done = true;
        return res.status(200).json({ sig: loseSig, amount: finalAmt, confirmed: loseConfirmed });
      } finally {
        await kvDel(loLockKey);
      }
    }

    clearTimeout(guard); done = true;
    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[settle] CRASH:', e && (e.stack || e.message) || String(e));
    if (!done) { done = true; clearTimeout(guard); try { res.status(500).json({ error: e && e.message || String(e) }); } catch (_) {} }
  }
};
