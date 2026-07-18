// api/settle.js — tweetnacl only, no @solana/web3.js (ESM/runtime issues)
'use strict';
const nacl    = require('tweetnacl');
const crypto  = require('crypto');
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const { kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrem, kvZrevrange, kvHincrby,
        kvLpush, kvLtrim, kvLrange, kvHget, kvHgetall, kvIncrby, kvExpire, kvMget, kvScan } = require('../lib/kv');
// Pure pari-mutuel engine (spectator betting). All money math lives here so it is unit-tested
// offline; this file only does auth, KV, and the on-chain transfers. See lib/betting.js.
const BET = require('../lib/betting');

// Appends a timestamped earnings snapshot (for the player-profile chart) and caps the
// list at 200 points so it can't grow unbounded for long-lived accounts.
async function pushEarningsPoint(game, address, earned) {
  const key = 'ph:' + game + ':hist:' + address;
  await kvLpush(key, JSON.stringify({ t: Date.now(), e: Number(earned) || 0 }));
  await kvLtrim(key, 0, 199);
}

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

// ══════════════════════════════════════════════════════════════════════════════
// ── SPECTATOR BETTING (pari-mutuel) — additive, never touches the wager/cashout paths above ──
// ══════════════════════════════════════════════════════════════════════════════
// Money-safety model (see lib/betting.js): a bet payout is sized ONLY from the resolving market's
// own pool (× 0.92), never from the wallet balance; the global solvency invariant is asserted before
// EVERY transfer so betting can never reduce what is available for a player cashout.

const BET_MKT_TTL = 172800;                 // market records / bets live 48h (ample for audit + retries)
const BET_LEDGER  = 'betledger';            // hash: { betLiability, accruedFee } — atomic HINCRBY
const ALERT_URL   = process.env.BET_ALERT_WEBHOOK || process.env.DISCORD_WEBHOOK || '';

// Loud, non-blocking alert whenever the invariant refuses a payout (the backstop tripped) or an
// accounting anomaly is seen. Never throws.
function betAlert(msg) {
  console.error('[BET-ALERT] ' + msg);
  if (!ALERT_URL) return;
  try {
    fetch(ALERT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '⚠️ SNAKE POT betting: ' + msg }), signal: AbortSignal.timeout(4000) }).catch(() => {});
  } catch (_) {}
}

// The two logical ledgers, read as integers (default 0). One hash → one round-trip.
async function readBetLedger() {
  const h = await kvHgetall(BET_LEDGER) || {};
  return {
    betLiability: Math.max(0, Math.floor(Number(h.betLiability) || 0)),
    accruedFee:   Math.max(0, Math.floor(Number(h.accruedFee)   || 0)),
  };
}

// Sum every outstanding player wager deposit (`pw:<addr>`), read-only, for the invariant's
// `wagerLiability` term. This is the term that guarantees in-game players can always cash out.
// Existing wager code is byte-for-byte untouched — we just observe it. Fail-CLOSED to a very large
// number on any KV error so a read failure can NEVER let a payout slip past the invariant.
async function sumWagerLiability() {
  const keys = await kvScan('pw:*');
  if (!keys.length) return 0;
  let total = 0;
  // chunk MGET to keep request bodies sane
  for (let i = 0; i < keys.length; i += 256) {
    const vals = await kvMget(keys.slice(i, i + 256));
    for (const v of vals) total += Math.max(0, Math.floor(Number(v) || 0));
  }
  return total;
}

// THE gate. Fetches live escrow balance + all liabilities and asks the pure engine whether paying
// `payoutLamports` now keeps escrow solvent for EVERYONE (players + bettors + house fee). Returns the
// invariant result plus the figures used, so callers can log/alert. Fail-closed on any error.
async function assertSolvency(escPubkeyB58, payoutLamports) {
  let onChainBalance = 0, wagerLiability = Number.MAX_SAFE_INTEGER, betLiability = 0, accruedFee = 0;
  try {
    const bal = await rpc('getBalance', [escPubkeyB58, { commitment: 'confirmed' }]);
    onChainBalance = (bal && typeof bal.value === 'number') ? bal.value : (typeof bal === 'number' ? bal : 0);
    wagerLiability = await sumWagerLiability();
    const led = await readBetLedger();
    betLiability = led.betLiability; accruedFee = led.accruedFee;
  } catch (e) {
    // Any failure → keep wagerLiability at MAX so checkInvariant refuses. Never pay blind.
    return { ok: false, reason: 'solvency-read-failed:' + (e && e.message || e), onChainBalance, wagerLiability, betLiability, accruedFee };
  }
  const inv = BET.checkInvariant({ onChainBalance, wagerLiability, betLiability, accruedFee, payoutLamports, txFee: TX_FEE });
  return { ...inv, onChainBalance, wagerLiability, betLiability, accruedFee };
}

// Verify a GAME_SECRET-HMAC server-to-server proof (same trust model as elim-lock / park-food).
// `payloadStr` is the exact string the game server signed. Uses the shared x-game-proof/x-game-ts headers.
function verifyGameProof(req, payloadStr) {
  if (!GAME_SECRET) return false;
  const gp  = (req.headers['x-game-proof'] || '').trim();
  const gts = Number(req.headers['x-game-ts'] || 0);
  if (!gp || !gts || Math.abs(Date.now() - gts) > 300000) return false;
  const expected = crypto.createHmac('sha256', GAME_SECRET).update(payloadStr).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) { return false; }
}

// Canonical string for a market descriptor — the game server signs this with GAME_SECRET so a client
// cannot invent a market, change its outcomes, or extend its betting window.
function marketCanon(m) {
  return 'betmkt:' + m.id + ':' + m.lobby + ':' + m.type + ':' + (Array.isArray(m.outcomes) ? m.outcomes.join(',') : '') + ':' + m.openTs + ':' + m.lockTs;
}
function verifyMarketDescriptor(m, sig) {
  if (!GAME_SECRET || !m || !sig) return false;
  const expected = crypto.createHmac('sha256', GAME_SECRET).update(marketCanon(m)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig))); } catch (_) { return false; }
}

// Confirm a bet deposit tx paid ≥ lamports into the escrow from walletAddress (mirrors join.js
// verifyWagerTx exactly — same escrow, same checks). Throws a descriptive error on any shortfall.
async function verifyBetDepositTx(txSig, walletAddress, lamports, escrowB58) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    let tx;
    try { tx = await rpc('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); }
    catch (_) { continue; } // transient RPC error — retry
    if (!tx) continue;      // not indexed yet — retry
    if (tx.meta && tx.meta.err) throw new Error('Deposit tx failed on-chain');
    const keys = tx.transaction.message.accountKeys;
    const getKey = k => (typeof k === 'string' ? k : k.pubkey);
    const escrowIdx = keys.findIndex(k => getKey(k) === escrowB58);
    if (escrowIdx < 0) throw new Error('Escrow not found in deposit tx');
    const received = tx.meta.postBalances[escrowIdx] - tx.meta.preBalances[escrowIdx];
    if (received < lamports) throw new Error('Deposit too small: got ' + received + ' need ' + lamports);
    const senderIdx = keys.findIndex(k => getKey(k) === walletAddress);
    if (senderIdx < 0) throw new Error('Sender not found in deposit tx');
    return; // verified ✓
  }
  throw new Error('Deposit not confirmed yet — try again in a moment');
}

// Enumerate every individual bet on a market. Keys are `bet:<mkt>:<outcome>:<addr>` → lamports.
// Returns { pools:{outcome:lamports}, stakesByOutcome:{outcome:{addr:lamports}}, allStakes:{addr:lamports}, bettors:Set }.
async function loadMarketBets(mktId) {
  const prefix = 'bet:' + mktId + ':';
  const keys = await kvScan(prefix + '*');
  const pools = {}, stakesByOutcome = {}, allStakes = {}, byKey = {};
  if (keys.length) {
    for (let i = 0; i < keys.length; i += 256) {
      const slice = keys.slice(i, i + 256);
      const vals = await kvMget(slice);
      for (let j = 0; j < slice.length; j++) {
        const k = slice[j];
        const lamps = Math.max(0, Math.floor(Number(vals[j]) || 0));
        if (lamps <= 0) continue;
        const rest = k.slice(prefix.length);           // "<outcome>:<addr>"
        const ci = rest.lastIndexOf(':');
        if (ci < 0) continue;
        const outcome = rest.slice(0, ci);
        const addr    = rest.slice(ci + 1);
        pools[outcome] = (pools[outcome] || 0) + lamps;
        (stakesByOutcome[outcome] = stakesByOutcome[outcome] || {})[addr] = (stakesByOutcome[outcome][addr] || 0) + lamps;
        allStakes[addr] = (allStakes[addr] || 0) + lamps;
        byKey[k] = { outcome, addr, lamps };
      }
    }
  }
  return { pools, stakesByOutcome, allStakes, byKey };
}

// Pay a set of { addr, lamports } recipients from escrow, in batches that fit one Solana tx, asserting
// the solvency invariant before EACH batch and claiming per-bettor NX single-pay locks so a retry (or a
// double-fired resolve) can never pay anyone twice. Decrements betLiability by exactly what is paid.
// Returns { paid, refused, txs, stranded } — stranded>0 means the invariant blocked some payouts
// (money stays safely in escrow; the alert fires). NEVER pays from anything but the caller's amounts.
async function payBetRecipients(esc, mktId, recipients, tag) {
  const BATCH = 12; // recipients per tx (well within Solana's account/size limits)
  let paidLamports = 0, refused = 0, txs = [], stranded = 0;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH).filter(r => r && r.lamports > 0);
    if (!batch.length) continue;

    // Claim each bettor with an NX lock so concurrent/replayed resolves cannot double-pay them.
    const claimed = [];
    for (const r of batch) {
      const claim = await kvSetNX('betpaid:' + mktId + ':' + r.addr, '1', BET_MKT_TTL);
      if (claim) claimed.push(r); // only pay first-claimers; already-claimed = already paid/being paid
    }
    if (!claimed.length) continue;

    const batchTotal = claimed.reduce((a, r) => a + r.lamports, 0);
    // INVARIANT — the backstop. Refuse if paying this batch would strand any player or bettor.
    const inv = await assertSolvency(esc.pubkeyB58, batchTotal);
    if (!inv.ok) {
      // release the claims so a later (funded) retry can still pay them; leave the money in escrow.
      for (const r of claimed) await kvDel('betpaid:' + mktId + ':' + r.addr).catch(() => {});
      stranded += claimed.length;
      betAlert('invariant REFUSED ' + tag + ' market=' + mktId + ' batchTotal=' + batchTotal +
               ' bal=' + inv.onChainBalance + ' wagerLiab=' + inv.wagerLiability + ' betLiab=' + inv.betLiability +
               ' fee=' + inv.accruedFee + ' deficit=' + (inv.deficit || 'n/a'));
      break; // stop — do not attempt further batches once solvency is in question
    }

    try {
      const { blockhash } = await fetchBalAndHash(esc.pubkeyB58);
      const transfers = claimed.map(r => ({ to: b58Decode(r.addr), lamports: r.lamports }));
      const tx = buildTx(esc, blockhash, transfers);
      const result = await sendAndConfirm(tx);
      txs.push(result.sig);
      // Retire liability only for what we actually sent.
      await kvHincrby(BET_LEDGER, 'betLiability', -batchTotal).catch(() => {});
      // The Solana network fee for this transfer is absorbed by the house's 8% (accruedFee), NOT by a
      // cushion — this is what lets betting run from an empty escrow. Decrement the fee ledger so it
      // stays honest (a future owner sweep never claims fee that was already spent on network costs).
      await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
      paidLamports += batchTotal;
    } catch (e) {
      // Send failed — release the claims so this batch can be retried on the next resolve call.
      for (const r of claimed) await kvDel('betpaid:' + mktId + ':' + r.addr).catch(() => {});
      refused += claimed.length;
      console.error('[bet] ' + tag + ' batch send failed market=' + mktId + ' — ' + (e && e.message || e));
      // keep going: other batches may still succeed; the caller/game-server retries the rest.
    }
  }
  return { paidLamports, refused, txs, stranded };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── P2P BETTING EXCHANGE — player-vs-player, even money, platform never takes a side ──
// ══════════════════════════════════════════════════════════════════════════════
// Creator stakes S on one side; an opponent stakes the SAME S on the other. Pot = 2S in escrow.
// Winner receives 2S − 8%. Unmatched → creator refunded 100%, no fee. The platform holds escrow,
// matches, settles from authoritative game truth, and takes 8% of COMPLETED wagers only.
//
// KV schema:
//   wg:<id>            JSON wager record
//   wgopen:<lobbyKey>  ZSET(createdTs) of wager ids currently OPEN (the public order book)
//   wglive:<lobbyKey>  ZSET(createdTs) of MATCHED wagers still awaiting settlement
//   wgu:<address>      ZSET(createdTs) of every wager a user is party to (their bet slip)
//   lock:wg:<id>       NX mutex around accept/settle/cancel (race guard)
//   wgpaid:<id>        NX single-pay marker (a settled wager can never pay twice)
//   wgtx:<txSig>       deposit replay guard
const P2P = require('../lib/p2pbet');
const WG_TTL       = 604800;   // wager records live 7 days (history)
const WG_OPEN_WINDOW_MS = 60000; // how long a new wager stays takeable before it's returned unmatched
const WG_RESERVE_MS = 90000;   // an acceptor has 90s to land their deposit before the claim expires
const WG_MIN_STAKE = 1_000_000;      // 0.001 SOL floor
const WG_MAX_STAKE = 100_000_000_000; // 100 SOL ceiling (sanity)

function wgLobbyKey(region, lobby) { return String(region || 'NA') + ':' + String(lobby || ''); }
async function wgLoad(id) {
  try { const raw = await kvGet('wg:' + id); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
async function wgSave(w) { await kvSet('wg:' + w.id, JSON.stringify(w), WG_TTL); return w; }

// The game server signs each bettable snake so a client cannot invent a subject that could never
// settle. Mirrors the elim-lock trust model: HMAC over region+lobby+pid+name+ipHash+expiry.
// ipHash lets us catch a player betting on their own snake from a second account (see wgSelfBetCheck).
function verifySnakeSig(region, lobby, pid, name, ipHash, expTs, sig) {
  if (!GAME_SECRET || !sig) return false;
  if (!(Number(expTs) > Date.now())) return false;                 // roster entry expired
  const canon = 'snake:' + region + ':' + lobby + ':' + pid + ':' + (name || '') + ':' + (ipHash || '') + ':' + expTs;
  const expected = crypto.createHmac('sha256', GAME_SECRET).update(canon).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig))); } catch (_) { return false; }
}

// Stable, privacy-preserving fingerprint of the caller's IP. Same secret on the game server, so the
// same network produces the same hash on both sides — raw IPs are never stored.
function clientIpHash(req) {
  try {
    const xf = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (!xf || !GAME_SECRET) return '';
    return crypto.createHmac('sha256', GAME_SECRET).update('ip:' + xf).digest('hex').slice(0, 16);
  } catch (_) { return ''; }
}

// ── SELF-BETTING GUARD ────────────────────────────────────────────────────────
// A player may freely use their ONE game wallet to create and accept wagers. The only thing they may
// never do is bet on (or against) THEIR OWN snake — that's the outcome they personally control.
// Two layers:
//   1. Identity — a snake's pid IS its wallet address, so `subject === bettor` is an exact match.
//   2. Network — if the bettor is on the same network as the snake they're backing, it's very likely
//      the same person on a second account. Blocked, and the attempt is counted so repeat abuse is
//      visible even if they later switch networks.
// Returns an error string to reject with, or null to allow.
async function wgSelfBetCheck({ bettor, subjects, subjectIpHashes, req }) {
  for (const s of subjects) {
    if (s && s === bettor) return 'You cannot bet on your own snake';
  }
  const myIp = clientIpHash(req);
  if (myIp) {
    for (let i = 0; i < subjects.length; i++) {
      const sIp = subjectIpHashes[i];
      if (sIp && sIp === myIp) {
        // Count it so a pattern is visible even across later IP changes.
        try {
          const k = 'wgselfhit:' + bettor;
          await kvIncrby(k, 1); await kvExpire(k, 604800);
          betAlert('self-bet attempt blocked (same network) bettor=' + String(bettor).slice(0, 8) +
                   ' subject=' + String(subjects[i]).slice(0, 8));
        } catch (_) {}
        return 'You cannot bet on a snake played from your own network';
      }
    }
  }
  return null;
}

// Push a live update to every spectator of that arena via the game server's websocket (no polling).
// Fire-and-forget: a failed push only costs a client a slightly stale list, never money.
function wgPush(region, lobby, event, wager) {
  if (!GAME_SECRET) return;
  try {
    const ts = Date.now();
    const proof = crypto.createHmac('sha256', GAME_SECRET).update('wager-event:' + lobby + ':' + ts).digest('hex');
    const base = String(region).toUpperCase() === 'EU' ? 'https://eu.pac-arena.com' : 'https://us.pac-arena.com';
    fetch(base + '/wager-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
      body: JSON.stringify({ lobby, event, wager }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  } catch (_) {}
}

// Pay exactly one recipient, gated by the global solvency invariant. Used for winner payouts,
// cancellations, returns and the "your deposit couldn't be matched" refund. Never sizes from balance.
async function wgPayOne(esc, toAddr, lamports, tag) {
  const amt = Math.floor(Number(lamports) || 0);
  if (!(amt > 0)) return { ok: false, reason: 'nothing to pay' };
  const inv = await assertSolvency(esc.pubkeyB58, amt);
  if (!inv.ok) {
    betAlert('invariant REFUSED ' + tag + ' to=' + String(toAddr).slice(0, 8) + ' amt=' + amt +
             ' bal=' + inv.onChainBalance + ' wagerLiab=' + inv.wagerLiability + ' betLiab=' + inv.betLiability +
             ' fee=' + inv.accruedFee + ' deficit=' + (inv.deficit || 'n/a'));
    return { ok: false, reason: 'insolvent', inv };
  }
  try {
    const { blockhash } = await fetchBalAndHash(esc.pubkeyB58);
    const tx = buildTx(esc, blockhash, [{ to: b58Decode(toAddr), lamports: amt }]);
    const result = await sendAndConfirm(tx);
    return { ok: true, sig: result.sig, confirmed: result.confirmed };
  } catch (e) {
    console.error('[wg] payout failed ' + tag + ' — ' + (e && e.message || e));
    return { ok: false, reason: (e && e.message) || 'send failed' };
  }
}

// Public-safe projection of a wager (never leaks internal reservation details).
function wgPublic(w) {
  if (!w) return null;
  return {
    id: w.id, lobby: w.lobby, region: w.region, type: w.type,
    subject: w.subject, subjectName: w.subjectName, subject2: w.subject2, subject2Name: w.subject2Name,
    side: w.side, takerSide: P2P.opposingSide(w.type, w.side),
    stake: w.stakeLamports, potentialWin: P2P.potentialWin(w.stakeLamports),
    creator: w.creator, creatorName: w.creatorName, acceptor: w.acceptor, acceptorName: w.acceptorName,
    status: w.status, createdTs: w.createdTs, lockTs: w.lockTs, durationMs: w.durationMs,
    winningSide: w.winningSide || null, winner: w.winner || null,
    payout: w.payout || 0, fee: w.fee || 0, payoutTx: w.payoutTx || null, settledTs: w.settledTs || null,
  };
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

    const { action, playerAddress, lobbyId } = body;
    const wagerLamportsRaw = Number(body.wagerLamports) || 0;
    // Leaderboard stats are scoped per-game so Slither Snakes and Pac-Man never mix,
    // even for a wallet that plays both. ss-* lobbyId = Slither Snakes, else Pac-Man.
    const game = (lobbyId && lobbyId.startsWith('ss-')) ? 'ss' : 'pac';

    // ── elim-lock: game server calls this immediately on kill to block victim cashout ──
    // Also the ONLY trustworthy place to record the killer's elimination stat: the snake game
    // pays kills via dropped food (action:'kill' never fires for ss), so without this the
    // leaderboard KILLS column sat at 0 for everyone. killerAddress rides the same
    // GAME_SECRET-HMAC'd server-to-server call, so clients can't inflate it.
    if (action === 'elim-lock') {
      const { victimAddress, killerAddress } = body;
      // Auth: EITHER the admin secret, OR — for the game server, which has GAME_SECRET but not
      // ADMIN_SECRET — a GAME_SECRET-HMAC proof over victim+timestamp (same secret that signs kill
      // proofs). Either proves the caller is our own infrastructure. Without this the dead-flag silently
      // 403'd (game server had no ADMIN_SECRET), so killed players were never blocked from cashing out
      // → double-spend / escrow shortfall. Fail-closed if neither credential validates.
      const adminSec  = (req.headers['x-admin-secret'] || '').trim();
      const serverSec = (process.env.ADMIN_SECRET || '').trim();
      let authed = !!(adminSec && serverSec && adminSec === serverSec);
      if (!authed && GAME_SECRET && victimAddress) {
        const gp  = (req.headers['x-game-proof'] || '').trim();
        const gts = Number(req.headers['x-game-ts'] || 0);
        if (gp && gts && Math.abs(Date.now() - gts) < 300000) {
          // New form binds the killer into the proof; old form kept so not-yet-updated game
          // servers stay authed during rollout (proofs never leave our own infra either way).
          const expectedNew = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victimAddress + ':' + (killerAddress || '') + ':' + gts).digest('hex');
          const expectedOld = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victimAddress + ':' + gts).digest('hex');
          try { authed = crypto.timingSafeEqual(Buffer.from(expectedNew), Buffer.from(gp)); } catch (_) {}
          if (!authed) { try { authed = crypto.timingSafeEqual(Buffer.from(expectedOld), Buffer.from(gp)); } catch (_) {} }
        }
      }
      if (!authed) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (!victimAddress || typeof victimAddress !== 'string' || victimAddress.length < 20) {
        clearTimeout(guard); done = true;
        return res.status(400).json({ error: 'victimAddress required' });
      }
      // Set dead flag (blocks cashout) and atomically delete their wager record simultaneously
      await Promise.all([
        kvSet('dead:' + victimAddress, '1', 600),
        kvGetDel('pw:' + victimAddress),
      ]).catch(() => {});
      // Record the killer's elimination — paid lobbies only (matches every other leaderboard
      // stat: "wagered lobbies only"), never bots, never self-kills.
      if (killerAddress && typeof killerAddress === 'string' && killerAddress.length >= 20 &&
          killerAddress !== victimAddress && killerAddress.indexOf('bot-') !== 0 &&
          lobbyId && lobbyId.indexOf('paid') !== -1) {
        try { await kvHincrby('ph:' + game + ':' + killerAddress, 'kills', 1); } catch (_) {}
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
    }

    // ── park-food / get-food: persist a paid lobby's UNCLAIMED gold food across an empty room ──────
    // Server-to-server only (GAME_SECRET-HMAC, exactly like elim-lock). Touches ONLY KV, never escrow:
    // the dead players' SOL is already pooled in escrow — these persist the CLAIM TICKETS (gold orbs)
    // so a returning player can still grab that value instead of it vanishing when the room tears down.
    // NO signing, NO transfers happen here, so no money can be moved or duplicated by this path.
    //
    // get-food uses GETDEL (atomic read+delete), NOT GET, on purpose: the same paid lobby id can run on
    // both the NA and EU nodes against ONE shared escrow. GETDEL means exactly one node/instance can
    // ever claim a given parked set; the loser gets nothing. That's what prevents restoring the same
    // gold food on two nodes and letting both sets of players cash it out (escrow shortfall). Whichever
    // instance claims it re-parks whatever is still unclaimed when IT empties, so nothing is lost.
    if (action === 'park-food' || action === 'get-food') {
      const lid = (body.lid || lobbyId || '').toString();
      let authed = false;
      const gp  = (req.headers['x-game-proof'] || '').trim();
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (GAME_SECRET && gp && gts && Math.abs(Date.now() - gts) < 300000) {
        const expected = crypto.createHmac('sha256', GAME_SECRET).update('food:' + lid + ':' + gts).digest('hex');
        try { authed = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) {}
      }
      if (!authed) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      // paid Slither lobbies only — this is the only place gold food carries real escrow value
      if (!lid || !lid.startsWith('ss-') || lid.indexOf('paid') === -1) {
        clearTimeout(guard); done = true; return res.status(400).json({ error: 'paid ss lobby required' });
      }
      // Key is per-lobby, so a $1 lobby's money can never surface in a $5 lobby (ss-paid-lobby-1 vs
      // ss-paid-lobby-5 are different keys). The lid is ALSO stamped inside the payload and re-checked
      // on read — belt-and-braces so a future key refactor can't hand one lobby another lobby's money.
      const KEY = 'foodpark:' + lid;
      if (action === 'get-food') {
        let orbs = [];
        try {
          const raw = await kvGetDel(KEY);
          if (raw) {
            const p = JSON.parse(raw);
            // fail CLOSED on any lid mismatch: never hand a lobby value parked by a different one
            if (p && p.lid === lid && Array.isArray(p.orbs)) orbs = p.orbs;
            else if (p && p.lid && p.lid !== lid) console.warn('[food] lid mismatch parked=' + p.lid + ' asked=' + lid + ' — refusing');
          }
        } catch (_) {}
        clearTimeout(guard); done = true;
        return res.status(200).json({ orbs });
      }
      // park-food: store the server's authoritative set of currently-unclaimed gold orbs. Permanent
      // (kvSetPerm, no TTL) so it genuinely never disappears; cleared when nothing is left unclaimed.
      // Validate BEFORE coercing: `Number(x) || 0` would turn junk ('a', NaN, undefined) into a
      // perfectly valid money orb sitting at the map origin. Reject non-finite coords outright.
      const orbs = Array.isArray(body.orbs)
        ? body.orbs.slice(0, 4000)
            .map(o => (o && typeof o === 'object') ? { x: Number(o.x), y: Number(o.y), w: Number(o.w) } : null)
            .filter(o => o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.w) && o.w > 0)
            .map(o => ({ x: Math.round(o.x), y: Math.round(o.y), w: o.w }))
        : [];
      try {
        if (orbs.length) await kvSetPerm(KEY, JSON.stringify({ lid, ts: Date.now(), orbs }));
        else await kvDel(KEY);
      } catch (_) {}
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, parked: orbs.length });
    }

    // ── wager-list: PUBLIC order book for one arena (open + live). No auth, no money. ────────────
    if (action === 'wager-list') {
      const lk = wgLobbyKey(body.region, body.lobby);
      const ids = [];
      for (const key of ['wgopen:' + lk, 'wglive:' + lk]) {
        const z = await kvZrevrange(key, 0, 199);           // newest first (score = createdTs)
        if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      }
      const now = Date.now();
      const open = [], live = [];
      for (const id of ids.slice(0, 300)) {
        const w = await wgLoad(id); if (!w) continue;
        if (w.status === P2P.STATUS.OPEN)      { if (now < Number(w.lockTs)) open.push(wgPublic(w)); }
        else if (w.status === P2P.STATUS.MATCHED) live.push(wgPublic(w));
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, open, live, now });
    }

    // ── wager-mine: PUBLIC read of one address's bet slip (all statuses). No money. ──────────────
    if (action === 'wager-mine') {
      const addr = String(body.address || '');
      if (!addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'address required' }); }
      const z = await kvZrevrange('wgu:' + addr, 0, 199);
      const ids = []; if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      const mine = [];
      for (const id of ids) { const w = await wgLoad(id); if (w) mine.push(wgPublic(w)); }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, wagers: mine, now: Date.now() });
    }

    // ── wager-settle: AUTHORITATIVE settlement from the game server (GAME_SECRET-HMAC) ───────────
    // The game server decides the winning side from live game truth; this pays the winner 2S − 8%
    // and books the fee. Idempotent + NX-locked: a wager can NEVER pay out twice.
    if (action === 'wager-settle') {
      const wid = String(body.wagerId || '');
      const winningSide = String(body.winningSide || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-settle:' + wid + ':' + winningSide + ':' + gts)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' });
      }
      if (!wid) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (w.status === P2P.STATUS.SETTLED) {   // idempotent replay
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, already: true, wager: wgPublic(w) });
        }
        const r = P2P.resolveWager(w, winningSide);
        if (!r) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wager is not settleable' }); }
        // Single-pay marker claimed BEFORE the transfer — a crash mid-send can never double-pay.
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }

        const esc = getEscrow();
        const pay = await wgPayOne(esc, r.winner, r.payout, 'wager-settle');
        if (!pay.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});   // release so a funded retry can pay
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'payout held: ' + (pay.reason || 'unknown'), retry: true });
        }
        // Book it: the whole pot leaves bet liability; the platform's 8% becomes accrued fee.
        await kvHincrby(BET_LEDGER, 'accruedFee', r.fee).catch(() => {});
        await kvHincrby(BET_LEDGER, 'betLiability', -r.pot).catch(() => {});
        await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {}); // network cost from the fee
        w.status = P2P.STATUS.SETTLED; w.winningSide = winningSide; w.winner = r.winner; w.loser = r.loser;
        w.payout = r.payout; w.fee = r.fee; w.payoutTx = pay.sig; w.settledTs = Date.now();
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wglive:' + lk, wid).catch(() => {});
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        wgPush(w.region, w.lobby, 'settled', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── wager-return: unmatched at close → creator refunded 100%, NO fee (GAME_SECRET-HMAC) ──────
    if (action === 'wager-return') {
      const wid = String(body.wagerId || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-return:' + wid + ':' + gts)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' });
      }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'busy' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (w.status === P2P.STATUS.RETURNED) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        // Only an UNMATCHED wager can be returned — a matched one must settle.
        if (!P2P.canTransition(w.status, P2P.STATUS.RETURNED)) {
          clearTimeout(guard); done = true; return res.status(400).json({ error: 'cannot return a ' + w.status + ' wager' });
        }
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        const esc = getEscrow();
        const amt = P2P.returnAmount(w.stakeLamports);          // 100%, no fee
        const pay = await wgPayOne(esc, w.creator, amt, 'wager-return');
        if (!pay.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'refund held: ' + (pay.reason || 'unknown'), retry: true });
        }
        await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
        await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
        w.status = P2P.STATUS.RETURNED; w.payoutTx = pay.sig; w.settledTs = Date.now(); w.fee = 0;
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        wgPush(w.region, w.lobby, 'returned', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
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

    // ── wager-create: a spectator opens a P2P wager and escrows their stake ──────────────────────
    // Layered auth: the wallet signature above proves ownership; the snake's GAME_SECRET signature
    // proves the subject really is in that arena (so it can always settle); the on-chain tx proves
    // the stake actually landed. Only ADDS to escrow, so no solvency gate is needed here.
    if (action === 'wager-create') {
      const creator = playerAddress;
      const stake   = wagerLamportsRaw;
      const region  = String(body.region || 'NA').toUpperCase() === 'EU' ? 'EU' : 'NA';
      const lobby   = String(body.lobby || '');
      const typeId  = String(body.type || '');
      const side    = String(body.side || '');
      const now     = Date.now();
      const lockTs  = now + WG_OPEN_WINDOW_MS;

      if (!creator || b58Decode(creator).length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'bad creator address' }); }

      const vErr = P2P.validateCreate({ typeId, side, stakeLamports: stake, lockTs, nowMs: now,
        subject: body.subject, subject2: body.subject2, minStake: WG_MIN_STAKE, maxStake: WG_MAX_STAKE });
      if (vErr) { clearTimeout(guard); done = true; return res.status(400).json({ error: vErr }); }

      // Subject snake(s) must carry the game server's signature for THIS arena.
      if (!verifySnakeSig(region, lobby, body.subject, body.subjectName, body.subjIpHash, body.subjExp, body.subjSig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired snake — refresh and try again' });
      }
      const needs2 = P2P.getBetType(typeId).needsSubject2;
      if (needs2 && !verifySnakeSig(region, lobby, body.subject2, body.subject2Name, body.subj2IpHash, body.subj2Exp, body.subj2Sig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired second snake' });
      }

      // You may bet freely with your one game wallet — but never on your own snake.
      const selfErr = await wgSelfBetCheck({
        bettor: creator,
        subjects: [body.subject, needs2 ? body.subject2 : null].filter(Boolean),
        subjectIpHashes: [body.subjIpHash, needs2 ? body.subj2IpHash : null].filter(x => x !== null),
        req,
      });
      if (selfErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: selfErr }); }

      const txSig = body.txSig;
      if (!txSig) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'txSig required' }); }
      if (await kvGet('wgtx:' + txSig) !== null) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Deposit already used' }); }
      await verifyBetDepositTx(txSig, creator, stake, esc.pubkeyB58);
      await kvSet('wgtx:' + txSig, '1', WG_TTL);

      const id = 'w' + now.toString(36) + Math.random().toString(36).slice(2, 8);
      const w = {
        id, region, lobby, type: typeId, side,
        subject: body.subject, subjectName: String(body.subjectName || '').slice(0, 20),
        subject2: body.subject2 || null, subject2Name: String(body.subject2Name || '').slice(0, 20),
        // kept so the ACCEPTOR can be self-bet checked too (never exposed publicly)
        subjIpHash: body.subjIpHash || '', subj2IpHash: body.subj2IpHash || '',
        durationMs: Math.max(0, Math.floor(Number(body.durationMs) || 0)),
        stakeLamports: stake, creator, creatorName: String(body.creatorName || '').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 16),
        acceptor: null, acceptorName: null, status: P2P.STATUS.OPEN,
        createdTs: now, lockTs, createTx: txSig,
      };
      await wgSave(w);
      const lk = wgLobbyKey(region, lobby);
      await kvZadd('wgopen:' + lk, now, id);
      await kvExpire('wgopen:' + lk, WG_TTL).catch(() => {});
      await kvZadd('wgu:' + creator, now, id);
      await kvExpire('wgu:' + creator, WG_TTL).catch(() => {});
      await kvHincrby(BET_LEDGER, 'betLiability', stake);
      wgPush(region, lobby, 'created', wgPublic(w));
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, wager: wgPublic(w) });
    }

    // ── wager-reserve: atomically CLAIM an open wager before depositing ──────────────────────────
    // This is what makes double-accept impossible AND stops anyone paying for a wager someone else
    // just took. The claim auto-expires (WG_RESERVE_MS) and the wager returns to the book.
    if (action === 'wager-reserve') {
      const taker = playerAddress;
      const wid   = String(body.wagerId || '');
      if (!taker || !wid) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 20);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'Someone else is taking this wager' }); }
      try {
        const w = await wgLoad(wid);
        const now = Date.now();
        // A stale reservation silently reverts to open before we validate.
        if (w && w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0; await wgSave(w);
          await kvZadd('wgopen:' + wgLobbyKey(w.region, w.lobby), w.createdTs, wid);
        }
        const aErr = P2P.validateAccept({ wager: w, acceptor: taker, nowMs: now });
        if (aErr) { clearTimeout(guard); done = true; return res.status(409).json({ error: aErr }); }
        // Taking the other side of a wager on YOUR OWN snake is just as exploitable as backing it
        // (you'd control the outcome you're betting against), so the same guard applies here.
        const selfErr = await wgSelfBetCheck({
          bettor: taker,
          subjects: [w.subject, w.subject2].filter(Boolean),
          subjectIpHashes: [w.subjIpHash || '', w.subj2IpHash || ''],
          req,
        });
        if (selfErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: selfErr }); }
        w.status = P2P.STATUS.RESERVED; w.reservedBy = taker; w.reservedUntil = now + WG_RESERVE_MS;
        await wgSave(w);
        await kvZrem('wgopen:' + wgLobbyKey(w.region, w.lobby), wid).catch(() => {}); // leaves the book at once
        wgPush(w.region, w.lobby, 'reserved', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, stake: w.stakeLamports, expiresTs: w.reservedUntil, wager: wgPublic(w) });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── wager-accept: acceptor's deposit landed → MATCH the wager and lock it ────────────────────
    if (action === 'wager-accept') {
      const taker = playerAddress;
      const wid   = String(body.wagerId || '');
      const txSig = body.txSig;
      if (!taker || !wid || !txSig) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId + txSig required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'busy' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (await kvGet('wgtx:' + txSig) !== null) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Deposit already used' }); }
        // The deposit is real regardless of whether the match still stands — verify it first.
        await verifyBetDepositTx(txSig, taker, w.stakeLamports, esc.pubkeyB58);
        await kvSet('wgtx:' + txSig, '1', WG_TTL);

        const now = Date.now();
        const claimOk = (w.status === P2P.STATUS.RESERVED && w.reservedBy === taker && Number(w.reservedUntil || 0) >= now);
        if (!claimOk || !(now < Number(w.lockTs))) {
          // Their money landed but the wager is no longer theirs to take → return it immediately.
          await kvHincrby(BET_LEDGER, 'betLiability', w.stakeLamports);   // briefly owed to them
          const back = await wgPayOne(esc, taker, w.stakeLamports, 'wager-accept-refund');
          if (back.ok) { await kvHincrby(BET_LEDGER, 'betLiability', -w.stakeLamports).catch(() => {}); await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {}); }
          clearTimeout(guard); done = true;
          return res.status(409).json({ error: 'That wager was taken first — your deposit was returned', refundTx: back.sig || null });
        }
        w.status = P2P.STATUS.MATCHED; w.acceptor = taker;
        w.acceptorName = String(body.acceptorName || '').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 16);
        w.matchedTs = now; w.acceptTx = txSig; w.reservedBy = null; w.reservedUntil = 0;
        // A "survive N" wager's clock starts when both sides are locked in — fair to creator and taker.
        if (w.type === 'survive' && w.durationMs > 0) w.resolveTs = now + w.durationMs;
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await kvZadd('wglive:' + lk, w.createdTs, wid);
        await kvExpire('wglive:' + lk, WG_TTL).catch(() => {});
        await kvZadd('wgu:' + taker, w.createdTs, wid);
        await kvExpire('wgu:' + taker, WG_TTL).catch(() => {});
        await kvHincrby(BET_LEDGER, 'betLiability', w.stakeLamports);   // pot is now 2× stake
        wgPush(w.region, w.lobby, 'matched', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w) });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── wager-cancel: creator withdraws an UNMATCHED wager → 100% back, no fee ───────────────────
    if (action === 'wager-cancel') {
      const requester = playerAddress;
      const wid = String(body.wagerId || '');
      if (!requester || !wid) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'busy' }); }
      try {
        const w = await wgLoad(wid);
        const cErr = P2P.validateCancel({ wager: w, requester, nowMs: Date.now() });
        if (cErr) { clearTimeout(guard); done = true; return res.status(409).json({ error: cErr }); }
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        const amt = P2P.returnAmount(w.stakeLamports);
        const back = await wgPayOne(esc, w.creator, amt, 'wager-cancel');
        if (!back.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'refund held: ' + (back.reason || 'unknown'), retry: true });
        }
        await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
        await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
        w.status = P2P.STATUS.CANCELLED; w.payoutTx = back.sig; w.settledTs = Date.now(); w.fee = 0;
        await wgSave(w);
        await kvZrem('wgopen:' + wgLobbyKey(w.region, w.lobby), wid).catch(() => {});
        wgPush(w.region, w.lobby, 'cancelled', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: back.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── balance ───────────────────────────────────────────────────────────────
    if (action === 'balance') {
      const bal = await rpc('getBalance', [esc.pubkeyB58, { commitment: 'confirmed' }]);
      clearTimeout(guard); done = true;
      return res.status(200).json({ balance: bal.value, escrowPubkey: esc.pubkeyB58, solBalance: bal.value / 1e9 });
    }

    // ── stat-loss: record a death + loss on the leaderboard (NO money moves) ─────
    // The client calls this whenever a paid player is eliminated. It only touches the stat
    // counters — there is zero fund transfer here — so it is safe to record on every death. This
    // is the SINGLE source of truth for a player's own deaths+losses (the kill handler below no
    // longer also bumps the victim's deaths, which is why 'losses' used to sit at 0 and K/D looked
    // wrong: nothing was ever writing them). Signature-gated like every other non-balance action,
    // so only the wallet owner can record their own loss (and inflating your own losses only ever
    // hurts your own K/D — there's no incentive to abuse it).
    if (action === 'stat-loss') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      try {
        await kvHincrby('ph:' + game + ':' + playerAddress, 'losses', 1);
        await kvHincrby('ph:' + game + ':' + playerAddress, 'deaths', 1);
      } catch (_) {}
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
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
            // Awaited (not fire-and-forget) — Vercel can freeze the function the instant the
            // response is sent, so an un-awaited background write may never finish.
            try{ await kvDel('krl:'+playerAddress); }catch(_){}
            try{
              const pk='ph:'+game+':'+playerAddress;
              // Leaderboard "earned" is the gross cashout total (wager + winnings) the player
              // actually saw on their in-game $ display when they hit cashout — NOT playerCut,
              // which is that amount minus the 10% platform fee. Using playerCut made cashing
              // out for (say) $2 in a $1 lobby show as $1.80 earned, which looked wrong since
              // the fee is a platform cut, not something the player should see subtracted from
              // their own earnings figure. The actual wallet transfer below is UNCHANGED — this
              // only affects the stat/leaderboard number, never the real payout split.
              const newEarned=await kvHincrby(pk,'earned',payout);
              await kvHincrby(pk,'wins',1);
              await kvZadd('lb:'+game+':earned',Number(newEarned)||0,playerAddress);
              await kvHincrby('ph:'+game+':global','totalEarned',payout);
              await pushEarningsPoint(game,playerAddress,newEarned);
            }catch(_){}
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
          // Awaited (not fire-and-forget) — see cashout block above for why.
          try{
            const pk='ph:'+game+':'+playerAddress;
            await kvHincrby(pk,'kills',1);
            // Gross reward (pre-fee), same reasoning as the cashout path above.
            const newEarned=await kvHincrby(pk,'earned',total||0);
            await kvZadd('lb:'+game+':earned',Number(newEarned)||0,playerAddress);
            await pushEarningsPoint(game,playerAddress,newEarned);
            // (Victim's death is now recorded by the victim's own 'stat-loss' call — the single
            // source of truth — so we deliberately DON'T bump it here anymore, to avoid counting
            // the same death twice.)
          }catch(_){}
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
        // Awaited (not fire-and-forget) — see cashout block above for why.
        try{ await kvDel('krl:'+playerAddress); await kvDel('kc:'+playerAddress); }catch(_){}
        try{
          await kvHincrby('ph:'+game+':'+playerAddress,'losses',1);
          await kvHincrby('ph:'+game+':'+playerAddress,'deaths',1);
        }catch(_){}
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
