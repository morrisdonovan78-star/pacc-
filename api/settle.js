// api/settle.js — tweetnacl only, no @solana/web3.js (ESM/runtime issues)
'use strict';
const nacl    = require('tweetnacl');
const crypto  = require('crypto');
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const { kvPing, kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrem, kvZrevrange, kvHincrby,
        kvLpush, kvLtrim, kvLrange, kvHget, kvHgetall, kvIncrby, kvExpire, kvMget, kvScan } = require('../lib/kv');
// Pure pari-mutuel engine (spectator betting). All money math lives here so it is unit-tested
// offline; this file only does auth, KV, and the on-chain transfers. See lib/betting.js.
const BET = require('../lib/betting');
const PAYOUT = require('../lib/eventpayout');   // pure winner/amount planning (unit-tested offline)

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
// ── Scheduled kill-scoring events ("Bounty Hour"). Only kills landed inside one of these UTC
// windows, in a PAID lobby, accrue to the event board (evtk:<id> hash, field = killer wallet).
// Kills come only from the GAME_SECRET-authed elim-lock below, so the board can't be client-inflated.
// KEEP THE WINDOWS IN SYNC with the 'bounty' entries of window.SNAKE_EVENTS in slither-snakes.html.
const KILL_EVENTS = [
  { id: 'bounty-2026-07-25', start: Date.UTC(2026, 6, 25, 18, 0, 0), end: Date.UTC(2026, 6, 25, 20, 0, 0) }, // 2h: 2–4 PM ET
];
function activeKillEvent(now) { now = now || Date.now(); return KILL_EVENTS.find(e => now >= e.start && now < e.end) || null; }
// Free Entry Grind windows — mirror api/join.js GRIND_EVENTS. 10 paid $5 games in a window → 1 credit.
const GRIND_TARGET = 10;
const GRIND_EVENTS = [
  { id: 'grind-2026-07-25', start: Date.UTC(2026, 6, 25, 20, 0, 0), end: Date.UTC(2026, 6, 25, 21, 0, 0) }, // 4–5 PM ET, after Bounty
];
function activeGrindEvent(now) { now = now || Date.now(); return GRIND_EVENTS.find(e => now >= e.start && now < e.end) || null; }

// ── Recruiter of the Week — rolling 7-day contest. weekId buckets all recruit counts so a new week
// starts clean automatically. Anchor = Thu Jul 23 2026 00:00 America/Detroit (04:00 UTC, EDT).
// KEEP RECRUIT_ANCHOR in sync with join.js (qualification counting writes recruit:<weekId>).
const RECRUIT_ANCHOR  = Date.UTC(2026, 6, 23, 4, 0, 0);
const RECRUIT_WEEK_MS = 7 * 24 * 3600 * 1000;
function recruitWeek(now) { now = now || Date.now();
  const i = Math.floor((now - RECRUIT_ANCHOR) / RECRUIT_WEEK_MS);
  return { id: 'rw' + i, start: RECRUIT_ANCHOR + i * RECRUIT_WEEK_MS, end: RECRUIT_ANCHOR + (i + 1) * RECRUIT_WEEK_MS }; }
// Stable 6-char code from a wallet (no I/O/0/1 → unambiguous, human-typeable).
function refCodeFor(seed) {
  const h = crypto.createHash('sha256').update('refcode|' + seed).digest();
  const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 6; i++) c += AL[h[i] % 32];
  return c;
}
// Ensure a wallet has a registered referral code; returns it. Collision-safe (salts on clash).
async function ensureRefCode(wallet) {
  let code = await kvGet('wref:' + wallet).catch(() => null);
  if (code) return code;
  code = refCodeFor(wallet);
  let ok = await kvSetNX('refcode:' + code, wallet);
  let tries = 0;
  while (!ok && tries < 6) {
    const ex = await kvGet('refcode:' + code).catch(() => null);
    if (ex === wallet) { ok = true; break; }
    code = refCodeFor(wallet + ':' + (++tries));
    ok = await kvSetNX('refcode:' + code, wallet);
  }
  await kvSet('wref:' + wallet, code).catch(() => {});
  return code;
}

// Best-effort Discord announce of event winners via the existing wins webhook. @-pings any winner who
// has linked their Discord (discord:<wallet>). Never throws — a Discord hiccup must not fail a payout.
async function postEventWinners(title, winners) {
  const url = DISCORD_WINS_WEBHOOK; if (!url) return;
  const ids = [];
  const lines = await Promise.all(winners.map(async w => {
    const medal = ['🥇', '🥈', '🥉'][w.place - 1] || (w.place + '.');
    let who = w.name || (String(w.addr).slice(0, 4) + '…' + String(w.addr).slice(-4));
    try { const did = await kvGet('discord:' + w.addr); if (did) { who = '<@' + did + '>'; ids.push(String(did)); } } catch (_) {}
    return medal + ' ' + who + ' — **$' + w.usd + '**' + (w.ok === false ? ' _(payout pending)_' : '');
  }));
  const body = { content: title + '\n' + lines.join('\n') + '\n💰 Paid in SOL. GG! 🐍',
    allowed_mentions: { parse: [], users: ids.slice(0, 50) } };
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
}

// Settle a Bounty-Hour event. Prizes are paid via wgPayOne, whose assertSolvency guard means prize
// money can ONLY come from genuine escrow surplus (the owner-funded float) — never player/bettor
// funds. Per-place NX locks make each payout run at most once; a failed send releases its lock so a
// later trigger retries (e.g. once the float is funded). dryRun computes + returns the plan only.
async function settleBounty(ev, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const h = (await kvHgetall('evtk:' + ev.id).catch(() => null)) || {};
  const board = Object.keys(h).map(a => ({ addr: a, kills: parseInt(h[a]) || 0 }))
                      .filter(r => r.kills > 0).sort((a, b) => b.kills - a.kills);
  for (const r of board.slice(0, 2)) { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }
  const price = await solUsdQuick();
  let esc, bal = 0;
  try { esc = getEscrow(); const bh = await fetchBalAndHash(esc.pubkeyB58); bal = bh.bal; }
  catch (e) { return { ok: false, reason: 'escrow load: ' + (e && e.message) }; }
  const plan = PAYOUT.planBountyPayout({ board, solPriceUsd: price || 0, escrowLamports: bal,
    floorLamports: RENT_MIN, prizes: { first: 25, second: 15, bump: 35 }, bumpMinPlayers: 10 });
  // One-off (bounty-2026-07-25): the 1st-place finisher was the operator, who entered and won fairly
  // but DECLINED their own prize — pay ONLY 2nd place. Applied to plan.winners here so the dry-run
  // PREVIEW, the real payout, and the Discord results post are all consistent (only 2nd shown/paid).
  // Scoped by event id → every other/future bounty still pays 1st+2nd. 2nd's $15 is unchanged.
  if (ev.id === 'bounty-2026-07-25') {
    plan.winners = plan.winners.filter(w => w.place !== 1);
    // RE-VERIFY solvency for the reduced set. plan.ok/totalLamports/shortfall from planBountyPayout
    // reflect the FULL 1st+2nd sum, which the float may NOT cover even when it covers 2nd alone — so
    // without this the !plan.ok guard below would bail and pay NOBODY. Mirror finalizePlan exactly
    // (spendable = escrow − floor; no TX_FEE here, wgPayOne's assertSolvency does the on-chain check).
    plan.totalLamports = plan.winners.reduce((s, w) => s + w.lamports, 0);
    const _spendable = Math.max(0, bal - RENT_MIN);
    plan.ok = plan.totalLamports > 0 && plan.totalLamports <= _spendable;
    plan.reason = plan.ok ? 'ok' : (plan.totalLamports > 0 ? 'insufficient float' : 'zero payout');
    if (plan.ok) delete plan.shortfall; else plan.shortfall = plan.totalLamports - _spendable;
    // 2nd place ($15) was PAID MANUALLY (a direct SOL transfer outside the settle system) after the
    // event, so the per-place NX pay-lock was never taken. Now that EVENT_AUTOPAY is gone and any poll
    // triggers a real settle, the automated path would try to pay him AGAIN → double-pay. Short-circuit
    // the REAL settle for this one event to prevent it. The dry-run above still returns the info plan.
    if (!dryRun) return { ok: true, id: ev.id, reason: 'settled-manually (2nd paid out-of-band)', winners: [] };
  }
  if (dryRun) return { dryRun: true, id: ev.id, solPriceUsd: price || 0, escrowSol: bal / 1e9,
    players: board.length, plan };
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };   // no lock taken → retries later
  const paid = [];
  for (const w of plan.winners) {
    const lk = await kvSetNX('evtpaid:' + ev.id + ':' + w.place, String(Date.now()));
    if (!lk) { paid.push({ place: w.place, addr: w.addr, name: w.name, usd: w.usd, already: true }); continue; }
    const r = await wgPayOne(esc, w.addr, w.lamports, 'bounty:' + ev.id + ':' + w.place);
    if (!r.ok) { await kvDel('evtpaid:' + ev.id + ':' + w.place).catch(() => {});
      betAlert('bounty payout FAILED ' + ev.id + ' place ' + w.place + ' -> ' + String(w.addr).slice(0, 8) + ' : ' + (r.reason || '')); }
    paid.push({ place: w.place, addr: w.addr, name: w.name, usd: w.usd, lamports: w.lamports, ok: r.ok, sig: r.sig || null, reason: r.reason || null });
  }
  const result = { id: ev.id, ts: Date.now(), bumped: plan.bumped, winners: paid };
  await kvSetPerm('evtresult:' + ev.id, JSON.stringify(result)).catch(() => {});
  try { await postEventWinners('🏆 **BOUNTY HOUR RESULTS**', paid); } catch (_) {}
  return { ok: true, result };
}

// Settle a Recruiter-of-the-Week: pay the single top referrer $10 from the float. Same solvency +
// once-only guarantees as settleBounty (one week-scoped NX lock; a failed send releases it to retry).
async function settleRecruiter(wk, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const h = (await kvHgetall('recruit:' + wk.id).catch(() => null)) || {};
  const board = Object.keys(h).map(a => ({ addr: a, recruits: parseInt(h[a]) || 0 }))
                      .filter(r => r.recruits > 0).sort((a, b) => b.recruits - a.recruits);
  for (const r of board.slice(0, 1)) { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }
  const price = await solUsdQuick();
  let esc, bal = 0;
  try { esc = getEscrow(); const bh = await fetchBalAndHash(esc.pubkeyB58); bal = bh.bal; }
  catch (e) { return { ok: false, reason: 'escrow load: ' + (e && e.message) }; }
  const plan = PAYOUT.planRecruiterPayout({ board, solPriceUsd: price || 0, escrowLamports: bal, floorLamports: RENT_MIN, prizeUsd: 10 });
  if (dryRun) return { dryRun: true, week: wk.id, solPriceUsd: price || 0, escrowSol: bal / 1e9, recruiters: board.length, plan };
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };
  const lk = await kvSetNX('recpaid:' + wk.id, String(Date.now()));
  if (!lk) { const prev = await kvGet('recresult:' + wk.id).catch(() => null); return { already: true, result: prev ? JSON.parse(prev) : null }; }
  const w = plan.winners[0];
  const r = await wgPayOne(esc, w.addr, w.lamports, 'recruiter:' + wk.id);
  if (!r.ok) { await kvDel('recpaid:' + wk.id).catch(() => {});
    betAlert('recruiter payout FAILED ' + wk.id + ' -> ' + String(w.addr).slice(0, 8) + ' : ' + (r.reason || '')); }
  const paid = [{ place: 1, addr: w.addr, name: w.name, usd: w.usd, lamports: w.lamports, ok: r.ok, sig: r.sig || null, reason: r.reason || null }];
  const result = { week: wk.id, ts: Date.now(), winners: paid };
  if (r.ok) await kvSetPerm('recresult:' + wk.id, JSON.stringify(result)).catch(() => {});
  try { await postEventWinners('🥇 **RECRUITER OF THE WEEK — WINNER**', paid); } catch (_) {}
  return { ok: r.ok, result };
}
// Minimum accrued referral balance a referrer can withdraw. Keeps a single payout worth many times
// its own ~5000-lamport network fee instead of dribbling out cent-sized transactions. ~0.002 SOL.
const REF_MIN_CLAIM   = 2_000_000;

// ── Discord "wall of winners" ─────────────────────────────────────────────────────────────────
// When a paid cashout confirms, we post a small embed to a Discord channel via an incoming webhook.
// It turns every real win into free, on-chain-proven social proof that recruits players. The
// webhook URL lives ONLY in this env var (never shipped to the client) so nobody can spam the
// channel. If the var is unset the whole feature is silently off — nothing changes. Set it in
// Vercel: DISCORD_WINS_WEBHOOK = the URL from Discord → channel → Integrations → Webhooks.
const DISCORD_WINS_WEBHOOK = (process.env.DISCORD_WINS_WEBHOOK || '').trim();
const DISCORD_BOT_TOKEN    = (process.env.DISCORD_BOT_TOKEN || '').trim();          // clip bot — reads link codes
const DISCORD_LINK_CHANNEL = (process.env.DISCORD_LINK_CHANNEL || '1523824631914696916').trim();
const WIN_POST_MIN_USD = 1.50;          // only announce cashouts worth at least this many dollars
const WIN_POST_MIN_SOL_FALLBACK = 0.02; // ~$1.50 at a typical SOL price — used only if the price
                                        // feed is momentarily unavailable, so a price hiccup neither
                                        // spams the channel nor silently suppresses every win

// Best-effort SOL/USD for the embed. Tries multiple sources in order (first success wins) so the
// USD figure reliably shows. ORDER MATTERS: Binance geo-blocks US IPs and Vercel functions run in
// the US, so Binance-first silently returned null and every post fell back to SOL-only — Coinbase
// and CoinGecko answer fine from US, so they go first. Short per-source timeout; null only if every
// source fails (embed then shows SOL). Never throws — a price hiccup must never touch the payout.
async function solUsdQuick() {
  const sources = [
    { url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot', pick: d => parseFloat(d && d.data && d.data.amount) },
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', pick: d => d && d.solana && d.solana.usd },
    { url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', pick: d => parseFloat(d && d.price) },
  ];
  for (const s of sources) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) continue;
      const p = s.pick(await r.json());
      if (p > 0) return p;
    } catch (_) { /* try next source */ }
  }
  return null;
}

// Post a single win to the Discord channel. Fully best-effort: any failure is swallowed so it can
// NEVER affect the player's payout or the API response. `grossLamports` is what the player cashed
// out (wager + winnings) — the figure they actually saw, and the honest social-proof number.
async function postWinToDiscord(grossLamports, name, sig) {
  if (!DISCORD_WINS_WEBHOOK) return;
  const sol = grossLamports / 1e9;
  const price = await solUsdQuick();
  const usdVal = price ? sol * price : null;
  // USD gate: only announce cashouts >= $1.50. When the price feed is up we compare real dollars;
  // if it's momentarily down we fall back to an approximate SOL floor so a hiccup doesn't misbehave.
  if (usdVal != null) { if (usdVal < WIN_POST_MIN_USD) return; }
  else { if (sol < WIN_POST_MIN_SOL_FALLBACK) return; }
  try {
    const usd = usdVal != null ? '$' + usdVal.toFixed(2) : null;
    const who = (name && String(name).trim()) ? String(name).trim().slice(0, 20) : 'A player';
    const amount = usd ? (usd + '  (' + sol.toFixed(3) + ' SOL)') : (sol.toFixed(3) + ' SOL');
    const explorer = 'https://explorer.solana.com/tx/' + sig;
    const body = {
      username: 'SNAKE POT',
      embeds: [{
        title: '🐍 ' + who + ' just cashed out!',
        description: '**' + amount + '** paid straight to their wallet.\n\n' +
                     '[✅ View on-chain proof](' + explorer + ')  •  [🎮 Play now](https://snakepot.com/play)',
        color: 0x39FF14,
        timestamp: new Date().toISOString(),
      }],
    };
    await fetch(DISCORD_WINS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* social proof is best-effort; never let it matter */ }
}
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

// Like rpc(), but for LOOKUPS where a node legitimately answers "not found" (null). Racing and
// taking the fastest reply means one un-indexed node can report not-found while another already has
// the transaction — which made bet deposits fail verification and hang on "Escrowing bet...".
// Resolve on the first node that actually HAS it; only report not-found once every node has spoken.
async function rpcFound(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  return await new Promise(resolve => {
    let left = RPCS.length, settled = false;
    if (!left) return resolve(null);
    for (const url of RPCS) {
      one(url).then(res => {
        if (settled) return;
        if (res != null) { settled = true; return resolve(res); }
        if (--left === 0) { settled = true; resolve(null); }
      }).catch(() => { if (settled) return; if (--left === 0) { settled = true; resolve(null); } });
    }
  });
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
    try { tx = await rpcFound('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); }
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
// wgpaid: is an in-flight payment LOCK, not proof of payment. The authoritative "already paid"
// record is the wager's own status (settled/returned), which every payer checks FIRST. Giving this a
// 7-day TTL meant a single attempt that died between claiming it and paying (Vercel freeze, crash)
// blocked every future payout forever and stranded the stake. Short TTL = self-releasing.
const WG_PAY_LOCK_TTL = 180;

const WG_OPEN_WINDOW_MS = 60000; // how long a new wager stays takeable before it's returned unmatched
const WG_RESERVE_MS = 90000;   // an acceptor has 90s to land their deposit before the claim expires
// A matched wager that the game never resolved is VOIDED after this long and both stakes are
// returned in full with no fee. Owner's call at 1h: long enough that no real round is still running,
// short enough that nobody's money is held overnight. This is what stops a duel that never got its
// decisive kill (third-party kill, someone left, a settle POST that failed) from stranding funds.
const WG_VOID_AFTER_MS = 3600000;
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
  // ⚠️ The NAME IS NOT SIGNED (v2). This proof only has to establish "this pid is a live snake in
  // this arena" — the display name is cosmetic and MUTABLE. Binding it meant that the moment a
  // player renamed, or their name reset to the default "SNAKE" mid-session, every signature they
  // had stopped verifying: their snake silently failed validation, a duel's opponent never got
  // recorded, and the wager could never settle. Names change; wallet ids do not.
  //
  // v1 (name included) is still accepted so a game server that has not been redeployed yet keeps
  // working — remove that fallback once both nodes are on the nameless signature.
  const mk = c => crypto.createHmac('sha256', GAME_SECRET).update(c).digest('hex');
  const v2 = 'snake:' + region + ':' + lobby + ':' + pid + ':' + (ipHash || '') + ':' + expTs;
  const v1 = 'snake:' + region + ':' + lobby + ':' + pid + ':' + (name || '') + ':' + (ipHash || '') + ':' + expTs;
  const given = Buffer.from(String(sig));
  for (const canon of [v2, v1]) {
    try { if (crypto.timingSafeEqual(Buffer.from(mk(canon)), given)) return true; } catch (_) {}
  }
  return false;
}


// ── ANTI-SNIPE: the subject must still be IN THE ARENA at the moment you take the bet ──────────
// The game server only signs snakes that are currently alive (wgBettableSnakes filters on sn.alive)
// and re-signs the whole roster every 4s with a fresh expiry. So "holds a roster signature issued
// seconds ago" is a proof that the snake has not yet died or cashed out.
//
// Why this is needed: verifySnakeSig alone only asserts `exp > now`, and an entry stays valid for
// WG_ROSTER_TTL (180s) — while a wager is takeable for 60s. Nothing re-checked the subject after
// CREATE, so an already-decided wager could be taken for free:
//     Alice posts "VIPER cashes out — YES". VIPER dies 10s later. The wager is still open.
//     Bob takes the NO side and collects 1.84x at zero risk.
// That needs no collusion and no rigging, just watching — so it is enforced on RESERVE (the gate
// before any money moves), for every subject of every type.
//
// TTL_MIRROR must match WG_ROSTER_TTL in the game server. If they ever diverge this only becomes
// STRICTER (a smaller server TTL means fewer signatures qualify), never permissive, so a mismatch
// cannot open the hole back up — it would just reject takes until corrected.
const WG_ROSTER_TTL_MIRROR = 180000;
const WG_SIG_MAX_AGE_MS    = 25000;   // roster re-signs every ~4s, so 25s is generous slack
function isFreshSnakeSig(region, lobby, pid, name, ipHash, expTs, sig) {
  if (!verifySnakeSig(region, lobby, pid, name, ipHash, expTs, sig)) return false;
  const issuedAt = Number(expTs) - WG_ROSTER_TTL_MIRROR;
  return (Date.now() - issuedAt) <= WG_SIG_MAX_AGE_MS;
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

// ── RIG GUARD (directional) ───────────────────────────────────────────────────
// A player uses their ONE game wallet for everything and MAY back their own snake to succeed —
// they can't guarantee a win (anyone can kill them), and it only makes them play harder. What they
// may never do is take a side that pays out when a snake THEY CONTROL performs badly, because that
// is riggable: drive into a wall and collect. lib/p2pbet.js#riggableSubjects decides which snakes
// must fail for a side to win; we then check whether the bettor controls any of them, by:
//   1. Identity — a snake's pid IS its wallet address, so `subject === bettor` is exact.
//   2. Network — same hashed network as that snake ⇒ almost certainly the same person on an alt.
//      (This is also what stops "back A to outlast B" when B is your own sacrificial alt.)
// Returns an error string to reject with, or null to allow.
async function wgRigCheck({ bettor, typeId, side, subject, subject2, subjectIpHash, subject2IpHash, req }) {
  const mustFail = P2P.riggableSubjects(typeId, side, subject, subject2).filter(Boolean);
  if (!mustFail.length) return null;                 // backing a snake to SUCCEED — never riggable
  const ipOf = {};
  if (subject)  ipOf[subject]  = subjectIpHash  || '';
  if (subject2) ipOf[subject2] = subject2IpHash || '';
  const myIp = clientIpHash(req);
  for (const s of mustFail) {
    if (s === bettor) {
      return 'You can back your own snake to win, but not to lose — take the other side';
    }
    if (myIp && ipOf[s] && ipOf[s] === myIp) {
      // Count it so a pattern stays visible even if they later switch networks.
      try {
        const k = 'wgselfhit:' + bettor;
        await kvIncrby(k, 1); await kvExpire(k, 604800);
        betAlert('rig attempt blocked (same network) bettor=' + String(bettor).slice(0, 8) +
                 ' mustFail=' + String(s).slice(0, 8) + ' type=' + typeId + ' side=' + side);
      } catch (_) {}
      return 'You cannot bet on a snake from your own network losing';
    }
  }
  return null;
}

// Push a live update to everyone watching that arena, via the game server's websocket (no polling).
//
// ⚠️ MUST BE AWAITED. This was fire-and-forget and that is exactly why other players never saw a new
// bet appear: Vercel can freeze/kill the function the instant the response is sent, so an un-awaited
// fetch is a coin flip on whether it is even dispatched (api/join.js carries the same warning about
// un-awaited background writes). Awaiting costs a few hundred ms on the bettor's own request but is
// what makes the bet show up for everyone else immediately.
//
// The wager is already committed to KV before this runs, so a push that still fails (game server
// down/slow) only means a briefly stale list — the periodic roster digest re-syncs it within ~4s.
async function wgPush(region, lobby, event, wager) {
  if (!GAME_SECRET) return false;
  try {
    const ts = Date.now();
    const proof = crypto.createHmac('sha256', GAME_SECRET).update('wager-event:' + lobby + ':' + ts).digest('hex');
    const base = String(region).toUpperCase() === 'EU' ? 'https://eu.pac-arena.com' : 'https://us.pac-arena.com';
    const r = await fetch(base + '/wager-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
      body: JSON.stringify({ lobby, event, wager }),
      signal: AbortSignal.timeout(2500),   // bounded so a slow node can't stall the bettor's response
    });
    if (!r.ok) console.warn('[wg] push ' + event + ' -> HTTP ' + r.status);
    return r.ok;
  } catch (e) {
    console.warn('[wg] push ' + event + ' failed: ' + (e && e.message || e));
    return false;
  }
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

// Pay the winner AND send the platform's 8% to the fee wallet in ONE transaction.
// The fee does NOT sit in escrow. Escrow is the GAME wallet and should only ever hold what is
// actually owed to players and bettors; the platform cut belongs in the same fee wallet the 10%
// cashout fee goes to (CREATOR_WALLET). Doing both transfers in a single tx makes it atomic (the
// fee can never be stranded or double-swept) and costs one network fee instead of two.
async function wgPayWinnerAndFee(esc, winner, payout, fee, tag) {
  const win = Math.floor(Number(payout) || 0);
  const cut = Math.max(0, Math.floor(Number(fee) || 0));
  if (!(win > 0)) return { ok: false, reason: 'nothing to pay' };
  const inv = await assertSolvency(esc.pubkeyB58, win + cut);
  if (!inv.ok) {
    betAlert('invariant REFUSED ' + tag + ' to=' + String(winner).slice(0, 8) + ' win=' + win + ' fee=' + cut +
             ' bal=' + inv.onChainBalance + ' betLiab=' + inv.betLiability + ' deficit=' + (inv.deficit || 'n/a'));
    return { ok: false, reason: 'insolvent', inv };
  }
  try {
    const { bal, blockhash } = await fetchBalAndHash(esc.pubkeyB58);
    // ── KEEP ESCROW RENT-VALID, AND NOTHING MORE ────────────────────────────────────────────────
    // Solana requires a system account to hold >= RENT_MIN (890880 lamports) or be exactly 0 — land
    // it anywhere in between and the transfer is rejected outright (InsufficientFundsForRent). So
    // escrow must retain RENT_MIN plus this tx's 5000-lamport network fee. That is the ENTIRE
    // structural requirement; no buffer beyond it is kept.
    //
    // If the sweep would breach that floor, the FEE is trimmed — never the winner's payout. The
    // winner is owed their money; the platform cut is what should absorb the shortfall.
    const spendable = bal - RENT_MIN - TX_FEE;          // most we can move and stay rent-valid
    let feeCut = cut;
    if (win > spendable) {
      // Can't even cover the winner while staying rent-valid — refuse rather than send a doomed tx.
      return { ok: false, reason: 'insufficient escrow for a rent-valid payout' };
    }
    if (win + feeCut > spendable) {
      feeCut = Math.max(0, spendable - win);
      console.warn('[wg] ' + tag + ' fee trimmed ' + cut + ' -> ' + feeCut + ' to keep escrow rent-exempt');
    }
    const transfers = [{ to: b58Decode(winner), lamports: win }];
    if (feeCut > 0) transfers.push({ to: b58Decode(CREATOR_WALLET), lamports: feeCut });
    const tx = buildTx(esc, blockhash, transfers);
    const result = await sendAndConfirm(tx);
    return { ok: true, sig: result.sig, confirmed: result.confirmed, feeSent: feeCut };
  } catch (e) {
    console.error('[wg] ' + tag + ' payout failed — ' + (e && e.message || e));
    return { ok: false, reason: (e && e.message) || 'send failed' };
  }
}

// Public-safe projection of a wager (never leaks internal reservation details).
function wgPublic(w) {
  if (!w) return null;
  return {
    id: w.id, lobby: w.lobby, region: w.region, type: w.type, duel: !!w.duel,
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
        // Bounty Hour: if a scheduled kill-event is live right now, this paid kill also scores on the
        // event board. Same trust path as the all-time stat above (GAME_SECRET-authed, paid, non-bot).
        try { const _ev = activeKillEvent(); if (_ev) await kvHincrby('evtk:' + _ev.id, killerAddress, 1); } catch (_) {}
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
    }

    // ── event-board: live / just-ended Bounty-Hour kill standings (unsigned read — the numbers are
    // built only from GAME_SECRET-authed elim-lock kills, so exposing them read-only is safe). ──────
    if (action === 'event-board') {
      const now = Date.now();
      let ev = activeKillEvent(now), state = 'live';
      if (!ev) {                                    // no live event → show the last one's final board for 6h
        const past = KILL_EVENTS.filter(e => now >= e.end).sort((a, b) => b.end - a.end)[0];
        if (past && (now - past.end) < 6 * 3600 * 1000) { ev = past; state = 'ended'; }
      }
      // Auto-settle: once a bounty window has ended, pay the winners from the float — idempotent
      // (per-place NX locks) and solvency-guarded, so only the first post-event reader does the work
      // and it can never overpay or touch player funds. Always on (the EVENT_AUTOPAY kill-switch was
      // removed 2026-07-25 — it had been silently disabling every event payout).
      if (state === 'ended' && ev) { try { await settleBounty(ev, { dryRun: false }); } catch (_) {} }
      clearTimeout(guard); done = true;
      if (!ev) return res.status(200).json({ active: false });
      const h = (await kvHgetall('evtk:' + ev.id).catch(() => null)) || {};
      const rows = Object.keys(h).map(a => ({ addr: a, kills: parseInt(h[a]) || 0 }))
                         .filter(r => r.kills > 0).sort((a, b) => b.kills - a.kills);
      const you = String(body.playerAddress || '').trim();
      let youRank = 0, youKills = 0;
      for (let i = 0; i < rows.length; i++) { if (rows[i].addr === you) { youRank = i + 1; youKills = rows[i].kills; break; } }
      const top = rows.slice(0, 10);
      await Promise.all(top.map(async r => { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }));
      return res.status(200).json({
        active: true, state, id: ev.id, startsAt: ev.start, endsAt: ev.end,
        top: top.map(r => ({ name: r.name || (r.addr.slice(0, 4) + '…' + r.addr.slice(-4)), kills: r.kills })),
        you: { rank: youRank, kills: youKills, onBoard: youRank > 0 },
      });
    }

    // ── my-refcode: a player's own invite code/link + their qualified-recruit count this week ───────
    if (action === 'my-refcode') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const code = await ensureRefCode(w);
      const wk = recruitWeek();
      const mine = parseInt(await kvHget('recruit:' + wk.id, w).catch(() => 0)) || 0;
      return res.status(200).json({ code, link: 'https://snakepot.com/?ref=' + code,
        recruits: mine, weekStart: wk.start, weekEnd: wk.end });
    }

    // ── credit-status: a player's free-entry credit balance + Free Entry Grind progress ───────────
    if (action === 'credit-status') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const credit = parseInt(await kvGet('credit:' + w).catch(() => 0)) || 0;
      const gev = activeGrindEvent();
      const total = gev ? (parseInt(await kvGet('grind:' + gev.id + ':' + w).catch(() => 0)) || 0) : 0;
      return res.status(200).json({ credit, grindActive: !!gev, grindTarget: GRIND_TARGET,
        grindDone: total % GRIND_TARGET, grindTotal: total });
    }

    // ── discord-link-code: mint a short code the player posts in Discord to link their account ──────
    if (action === 'discord-link-code') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const existing = await kvGet('discord:' + w).catch(() => null);
      if (existing) return res.status(200).json({ linked: true });
      const code = refCodeFor(w + ':dl:' + Math.floor(Date.now() / 60000)); // rotates each minute
      await kvSet('dlink:' + code, w, 900);                                 // 15-minute window
      return res.status(200).json({ linked: false, code, channel: DISCORD_LINK_CHANNEL });
    }

    // ── discord-link-check: read the link channel, map any pending code's wallet to its poster ─────
    if (action === 'discord-link-check') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      if (await kvGet('discord:' + w).catch(() => null)) return res.status(200).json({ linked: true });
      if (!DISCORD_BOT_TOKEN) return res.status(200).json({ linked: false, notConfigured: true });
      let msgs = [];
      try {
        const r = await fetch('https://discord.com/api/v10/channels/' + DISCORD_LINK_CHANNEL + '/messages?limit=50',
          { headers: { 'Authorization': 'Bot ' + DISCORD_BOT_TOKEN } });
        if (r.ok) msgs = await r.json();
      } catch (_) {}
      let linked = false;
      for (const m of (Array.isArray(msgs) ? msgs : [])) {
        const mm = /^\s*LINK\s+([A-Za-z0-9]{6})\s*$/i.exec((m && m.content) || '');
        if (!mm) continue;
        const wallet = await kvGet('dlink:' + mm[1].toUpperCase()).catch(() => null);
        if (!wallet) continue;
        const did = m.author && m.author.id;
        if (!did) continue;
        if (!(await kvGet('dwallet:' + did).catch(() => null))) {   // one Discord per wallet, first wins
          await kvSetPerm('discord:' + wallet, did).catch(() => {});
          await kvSetPerm('dwallet:' + did, wallet).catch(() => {});
        }
        await kvDel('dlink:' + mm[1].toUpperCase()).catch(() => {});
        if (wallet === w) linked = true;
      }
      return res.status(200).json({ linked });
    }

    // ── recruiter-board: this week's Recruiter-of-the-Week standings (unsigned read) ──────────────
    if (action === 'recruiter-board') {
      const wk = recruitWeek();
      // Lazy auto-settle the PREVIOUS week once it has ended (idempotent, solvency-guarded).
      if (process.env.EVENT_AUTOPAY !== '0') {
        const prev = recruitWeek(wk.start - 1);
        if (Date.now() >= prev.end) { try { await settleRecruiter(prev, { dryRun: false }); } catch (_) {} }
      }
      clearTimeout(guard); done = true;
      const h = (await kvHgetall('recruit:' + wk.id).catch(() => null)) || {};
      const rows = Object.keys(h).map(a => ({ addr: a, n: parseInt(h[a]) || 0 }))
                         .filter(r => r.n > 0).sort((a, b) => b.n - a.n);
      const you = String(body.playerAddress || '').trim();
      let youRank = 0, youN = 0;
      for (let i = 0; i < rows.length; i++) { if (rows[i].addr === you) { youRank = i + 1; youN = rows[i].n; break; } }
      const top = rows.slice(0, 10);
      await Promise.all(top.map(async r => { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }));
      return res.status(200).json({
        weekStart: wk.start, weekEnd: wk.end, prize: 10,
        top: top.map(r => ({ name: r.name || (r.addr.slice(0, 4) + '…' + r.addr.slice(-4)), recruits: r.n })),
        you: { rank: youRank, recruits: youN, onBoard: youRank > 0 },
      });
    }

    // ── event-settle: compute (dryRun, anyone) or fire (real, admin-only) a Bounty-Hour payout ─────
    if (action === 'event-settle') {
      const now = Date.now();
      const ev = activeKillEvent(now) || KILL_EVENTS.filter(e => now >= e.end).sort((a, b) => b.end - a.end)[0];
      clearTimeout(guard); done = true;
      if (!ev) return res.status(200).json({ error: 'no event' });
      if (body.dryRun === false) {   // REAL payout — admin secret required
        const adminSec = (req.headers['x-admin-secret'] || '').trim(), serverSec = (process.env.ADMIN_SECRET || '').trim();
        if (!(adminSec && serverSec && adminSec === serverSec)) return res.status(403).json({ error: 'admin only' });
        return res.status(200).json(await settleBounty(ev, { dryRun: false }));
      }
      return res.status(200).json(await settleBounty(ev, { dryRun: true }));
    }

    // ── recruiter-settle: compute (dryRun, anyone) or fire (real, admin-only) the weekly $10 payout ─
    if (action === 'recruiter-settle') {
      const cur = recruitWeek();
      const wk = recruitWeek(cur.start - 1);   // the previous, fully-ended week is what gets paid
      clearTimeout(guard); done = true;
      if (body.dryRun === false) {
        const adminSec = (req.headers['x-admin-secret'] || '').trim(), serverSec = (process.env.ADMIN_SECRET || '').trim();
        if (!(adminSec && serverSec && adminSec === serverSec)) return res.status(403).json({ error: 'admin only' });
        return res.status(200).json(await settleRecruiter(wk, { dryRun: false }));
      }
      return res.status(200).json(await settleRecruiter(wk, { dryRun: true }));
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
      const open = [], live = [], stale = [];
      for (const id of ids.slice(0, 300)) {
        let w = await wgLoad(id); if (!w) continue;
        // SWEEP stale reservations. A reservation is a 90s claim taken BEFORE the taker deposits; if
        // their deposit never lands the wager must go back on the book, or it is stranded forever
        // (never matched, never returned, creator's stake stuck in escrow). This used to happen only
        // if another player coincidentally tried to reserve the same wager. wager-list is called by
        // every client AND by the game server's reconcile, so sweeping here makes it self-healing.
        if (w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0;
          w.reservedSubject2 = null; w.reservedSubject2Name = ''; w.reservedSubject2Ip = '';
          await wgSave(w);
          await kvZadd('wgopen:' + lk, w.createdTs, id).catch(() => {});
          stale.push(id);
        }
        if (w.status === P2P.STATUS.OPEN)      { if (now < Number(w.lockTs)) open.push(wgPublic(w)); }
        else if (w.status === P2P.STATUS.MATCHED) live.push(wgPublic(w));
        // A wager whose window has closed with no taker is reported so the game server returns it.
        else if (w.status === P2P.STATUS.RESERVED) { /* still validly claimed — leave it alone */ }
      }
      if (stale.length) console.log('[wg] swept ' + stale.length + ' stale reservation(s) back to open');
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, open, live, now, swept: stale.length });
    }

    // ── wager-sweep: RECOVER stranded wagers (GAME_SECRET-HMAC) ─────────────────────────────────
    // Safety net that runs independently of any live game. ssWagerTick only runs while an arena is
    // actually being simulated, so a wager left behind in an idle lobby had nothing to rescue it.
    // This scans every wager and:
    //   * reverts a lapsed 'reserved' claim back to 'open' (taker never funded it), and
    //   * RETURNS 100% (no fee) to the creator of any unmatched wager whose window has closed.
    // Idempotent and invariant-gated, exactly like wager-return.
    if (action === 'wager-sweep') {
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-sweep:' + gts)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      const now = Date.now();
      const keys = await kvScan('wg:*', 2000);
      let reverted = 0, returned = 0, voided = 0, checked = 0;
      const detail = [];   // read-only picture of what is actually in KV, so a stuck stake can be diagnosed
      const esc = getEscrow();
      for (const k of keys) {
        if (returned >= 10) break;                       // bound the work per sweep
        let w = null;
        try { const raw = await kvGet(k); if (raw) w = JSON.parse(raw); } catch (_) {}
        if (!w || !w.id) continue;
        checked++;
        // No addresses, no signatures — just enough to see WHY something is not settling.
        if (detail.length < 25) detail.push({ id: w.id, st: w.status, lob: w.lobby, reg: w.region,
          stake: w.stakeLamports, ageS: Math.round((now - Number(w.createdTs || 0)) / 1000),
          lockInS: Math.round((Number(w.lockTs || 0) - now) / 1000),
          resInS: w.reservedUntil ? Math.round((Number(w.reservedUntil) - now) / 1000) : null,
          matched: !!w.acceptor, paidLock: null });
        // 1) lapsed reservation → back on the book
        if (w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0;
          w.reservedSubject2 = null; w.reservedSubject2Name = ''; w.reservedSubject2Ip = '';
          await wgSave(w);
          await kvZadd('wgopen:' + wgLobbyKey(w.region, w.lobby), w.createdTs, w.id).catch(() => {});
          reverted++;
        }
        // 2) unmatched and closed → refund the creator in full
        if (w.status === P2P.STATUS.OPEN && now >= Number(w.lockTs || 0)) {
          const lock = await kvSetNX('lock:wg:' + w.id, '1', 45);
          if (!lock) continue;
          try {
            const cur = await wgLoad(w.id);
            if (!cur || cur.status !== P2P.STATUS.OPEN) continue;
            let claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);
            if (!claimed) {
              // We already proved above that this wager is still OPEN — i.e. no payout ever
              // completed. So a lock sitting here is a leftover from an attempt that died
              // mid-flight, and honouring it would strand the creator's stake forever. Clear it.
              await kvDel('wgpaid:' + w.id).catch(() => {});
              claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);
              if (!claimed) continue;
              console.warn('[wg] cleared a stale payment lock on ' + w.id);
            }
            const amt = P2P.returnAmount(cur.stakeLamports);
            const pay = await wgPayOne(esc, cur.creator, amt, 'wager-sweep-return');
            if (!pay.ok) { await kvDel('wgpaid:' + w.id).catch(() => {}); continue; }
            await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
            await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
            cur.status = P2P.STATUS.RETURNED; cur.payoutTx = pay.sig; cur.settledTs = Date.now(); cur.fee = 0;
            await wgSave(cur);
            await kvZrem('wgopen:' + wgLobbyKey(cur.region, cur.lobby), cur.id).catch(() => {});
            await wgPush(cur.region, cur.lobby, 'returned', wgPublic(cur));
            returned++;
            betAlert('swept stranded wager ' + cur.id + ' → returned ' + amt + ' to ' + String(cur.creator).slice(0, 8));
          } finally { await kvDel('lock:wg:' + w.id).catch(() => {}); }
        }
        // 3) MATCHED but still unsettled an hour later → VOID: both sides get 100% back, no fee.
        // A duel only settles when one duellist actually kills the other, so a duel where a third
        // party intervened (or someone never came back) would otherwise hold both stakes forever.
        // This is the release valve, and it is deliberately the LAST resort: it only fires long
        // after any real game has ended.
        //
        // "Make sure it wasn't already paid out or lost first" — three independent guards:
        //   a) re-load under a lock and require status === 'matched'. A wager that settled is
        //      'settled', so a decided bet can never be voided out from under its winner.
        //   b) claim 'wgpaid:<id>' with SETNX. Unlike case 2 we do NOT clear a lock we find held,
        //      because here a held lock may be a real payout in flight — we skip and retry later.
        //   c) pay each side under its own 'wgvoid:<id>:<side>' guard, so a void interrupted after
        //      the first transfer resumes without paying the same person twice.
        if (w.status === P2P.STATUS.MATCHED && w.acceptor &&
            now - Number(w.matchedTs || w.createdTs || 0) >= WG_VOID_AFTER_MS) {
          const lock = await kvSetNX('lock:wg:' + w.id, '1', 45);
          if (!lock) continue;
          try {
            const cur = await wgLoad(w.id);
            if (!cur || cur.status !== P2P.STATUS.MATCHED || !cur.acceptor) continue;   // (a)
            const claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);      // (b)
            if (!claimed) continue;
            const amt = P2P.returnAmount(cur.stakeLamports);
            let paidBoth = true, txs = [];
            for (const [who, side] of [[cur.creator, 'c'], [cur.acceptor, 'a']]) {       // (c)
              const g = await kvSetNX('wgvoid:' + w.id + ':' + side, '1', WG_PAY_LOCK_TTL);
              if (!g) continue;                       // already refunded on an earlier pass
              const pay = await wgPayOne(esc, who, amt, 'wager-void-refund');
              if (!pay.ok) { await kvDel('wgvoid:' + w.id + ':' + side).catch(() => {}); paidBoth = false; break; }
              txs.push(pay.sig);
              await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
              await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
            }
            if (!paidBoth) { await kvDel('wgpaid:' + w.id).catch(() => {}); continue; }  // retry next sweep
            cur.status = P2P.STATUS.RETURNED; cur.voided = true; cur.fee = 0;
            cur.payoutTx = txs[0] || null; cur.settledTs = Date.now();
            await wgSave(cur);
            await kvZrem('wglive:' + wgLobbyKey(cur.region, cur.lobby), cur.id).catch(() => {});
            await wgPush(cur.region, cur.lobby, 'returned', wgPublic(cur));
            voided++;
            betAlert('VOIDED unsettled wager ' + cur.id + ' after ' +
                     Math.round((now - Number(cur.matchedTs || cur.createdTs || 0)) / 60000) +
                     'min — refunded ' + amt + ' to BOTH sides');
          } finally { await kvDel('lock:wg:' + w.id).catch(() => {}); }
        }
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, checked, reverted, returned, voided, detail });
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
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_PAY_LOCK_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }

        const esc = getEscrow();
        // Winner is paid and the 8% is swept to the fee wallet in the SAME transaction.
        const pay = await wgPayWinnerAndFee(esc, r.winner, r.payout, r.fee, 'wager-settle');
        if (!pay.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});   // release so a funded retry can pay
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'payout held: ' + (pay.reason || 'unknown'), retry: true });
        }
        // The whole pot leaves bet liability. accruedFee is NOT incremented any more: the fee has
        // physically left escrow to the fee wallet, so tracking it as a balance still sitting here
        // would overstate what escrow holds and (as it did) block later legitimate payouts.
        await kvHincrby(BET_LEDGER, 'betLiability', -r.pot).catch(() => {});
        w.status = P2P.STATUS.SETTLED; w.winningSide = winningSide; w.winner = r.winner; w.loser = r.loser;
        w.payout = r.payout; w.fee = r.fee; w.payoutTx = pay.sig; w.settledTs = Date.now();
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wglive:' + lk, wid).catch(() => {});
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await wgPush(w.region, w.lobby, 'settled', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── COINFLIP "Tails Never Fails" money — cf-deposit registers a player's escrow deposit as bet
    // liability (so the shared-escrow solvency invariant accounts for it, exactly like wagers), and
    // cf-settle pays the winner (pot − 10%) or refunds both on a tie. Trustless: verifies the deposit
    // ON-CHAIN and recomputes the provably-fair flip; solvency-guarded + NX-locked so it can never
    // double-pay or overdraw the pool that funds the live snake/pac games. State lives in shared KV.
    if (action === 'cf-deposit') {
      const id = String(body.id || ''); const role = body.role === 'opponent' ? 'opponent' : 'creator';
      const addr = String(body.address || ''); const sig = String(body.sig || '');
      const lamports = Math.floor(Number(body.lamports) || 0);
      if (!id || !addr || !sig || !(lamports > 0)) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'id, address, sig, lamports required' }); }
      const key = 'cfdep:' + id + ':' + role;
      // Claim the deposit slot ONCE — a replay must not re-register liability.
      const claimed = await kvSetNX(key, JSON.stringify({ addr, sig, lamports }), 86400);
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        await verifyBetDepositTx(sig, addr, lamports, esc.pubkeyB58);        // must have really landed in escrow
        await kvHincrby(BET_LEDGER, 'betLiability', lamports).catch(() => {}); // account it in the invariant
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true });
      } catch (e) {
        await kvDel(key).catch(() => {});                                   // release so a real deposit can retry
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: (e && e.message) || 'deposit not verified', retry: true });
      }
    }

    if (action === 'cf-settle') {
      const m = body.match || {};
      const id = String(m.id || '');
      if (!id) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'match required' }); }
      const shaHex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
      // Per-round flip: each re-flip mixes the round index into the player seed, so a tie can roll
      // again from the SAME committed serverSeed (no new commit needed). 0=heads, 1=tails.
      const flipR = (ss, ps, r) => parseInt(shaHex(ss + ':' + ps + ':' + r).slice(0, 8), 16) % 2;
      if (!m.serverSeed || shaHex(m.serverSeed) !== m.serverSeedHash) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad server-seed commit' }); }
      // Trustless round proof: the winning round must be the FIRST decisive one — every earlier round
      // must recompute to a tie from the committed seeds, else the caller is cherry-picking a round.
      const round = Math.max(0, Math.min(300, Math.floor(Number(m.round) || 0)));
      for (let r = 0; r < round; r++) {
        if (flipR(m.serverSeed, m.creatorSeed, r) !== flipR(m.serverSeed, m.opponentSeed, r)) {
          clearTimeout(guard); done = true; return res.status(403).json({ error: 'round ' + r + ' was decisive, not a tie' });
        }
      }
      // Both deposits must be on record (registered + verified by cf-deposit).
      const [cd, od] = await Promise.all([kvGet('cfdep:' + id + ':creator'), kvGet('cfdep:' + id + ':opponent')]);
      if (!cd || !od) { clearTimeout(guard); done = true; return res.status(409).json({ error: 'both deposits not registered yet', retry: true }); }
      const cDep = JSON.parse(cd), oDep = JSON.parse(od);
      const dep = Math.min(cDep.lamports, oDep.lamports);   // pay on the smaller stake if they ever differ
      const cFlip = flipR(m.serverSeed, m.creatorSeed, round), oFlip = flipR(m.serverSeed, m.opponentSeed, round);
      const tie = cFlip === oFlip;
      const lock = await kvSetNX('lock:cf:' + id, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const esc = getEscrow();
        if (tie) {
          const out = {};
          for (const [tag, addr] of [['c', cDep.addr], ['o', oDep.addr]]) {
            const claimed = await kvSetNX('cfpaid:' + id + ':' + tag, '1', 86400);
            if (!claimed) { out[tag] = { already: true }; continue; }
            const r = await wgPayWinnerAndFee(esc, addr, dep, 0, 'cf-tie-' + tag);
            if (!r.ok) { await kvDel('cfpaid:' + id + ':' + tag).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'refund held: ' + (r.reason || ''), retry: true }); }
            await kvHincrby(BET_LEDGER, 'betLiability', -dep).catch(() => {});
            out[tag] = { sig: r.sig };
          }
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, tie: true, refunds: out });
        }
        const claimed = await kvSetNX('cfpaid:' + id, '1', 86400);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        const winnerAddr = cFlip === 1 ? cDep.addr : oDep.addr;   // TAILS(1) wins
        const pot = dep * 2;
        const fee = Math.floor(pot * CREATOR_FEE_PCT);            // 10% to CREATOR_WALLET
        const payout = pot - fee;
        const pay = await wgPayWinnerAndFee(esc, winnerAddr, payout, fee, 'cf-settle');
        if (!pay.ok) { await kvDel('cfpaid:' + id).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'payout held: ' + (pay.reason || ''), retry: true }); }
        await kvHincrby(BET_LEDGER, 'betLiability', -pot).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tie: false, winner: winnerAddr, payout, fee, tx: pay.sig });
      } finally { await kvDel('lock:cf:' + id).catch(() => {}); }
    }

    // cf-refund: a creator cancels their open flip before anyone joins → refund their deposit 100%, no
    // fee, and clear the liability. Idempotent; only refunds a registered-but-unsettled deposit.
    if (action === 'cf-refund') {
      const id = String(body.id || ''); const role = body.role === 'opponent' ? 'opponent' : 'creator';
      if (!id) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'id required' }); }
      const raw = await kvGet('cfdep:' + id + ':' + role);
      if (!raw) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'no deposit on record' }); }
      const d = JSON.parse(raw);
      const claimed = await kvSetNX('cfpaid:' + id + ':' + role + ':refund', '1', 86400);
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        const r = await wgPayWinnerAndFee(esc, d.addr, d.lamports, 0, 'cf-refund');
        if (!r.ok) { await kvDel('cfpaid:' + id + ':' + role + ':refund').catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'refund held: ' + (r.reason || ''), retry: true }); }
        await kvHincrby(BET_LEDGER, 'betLiability', -d.lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tx: r.sig });
      } catch (e) { await kvDel('cfpaid:' + id + ':' + role + ':refund').catch(() => {}); clearTimeout(guard); done = true; return res.status(500).json({ error: (e && e.message) || 'refund failed' }); }
    }

    // ── BLACKJACK PVP money — bj-deposit registers each seated player's ante (escrow deposit) as bet
    // liability (shared-escrow solvency accounts for it, exactly like coinflip/wagers). bj-settle pays
    // the winner(s) closest-to-21 — pot − 10% → CREATOR_WALLET, SPLIT equally on a tie — or refunds
    // every ante on a PUSH (all bust / whole-table tie, no fee). GAME_SECRET-HMAC authed: blackjack's
    // result depends on player hit/stand DECISIONS, so (unlike coinflip) it can't be re-derived from the
    // seed alone — the trusted game server attests it, same trust model as wager-settle. Pot is computed
    // from the REGISTERED on-chain antes (never the caller's claim). Solvency-guarded + NX-locked +
    // idempotent per payee so it can never double-pay or overdraw the pool. State in shared KV.
    if (action === 'bj-deposit') {
      const handId = String(body.handId || ''); const addr = String(body.address || '');
      const sig = String(body.sig || ''); const lamports = Math.floor(Number(body.lamports) || 0);
      if (!handId || !addr || !sig || !(lamports > 0)) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId, address, sig, lamports required' }); }
      const key = 'bjdep:' + handId + ':' + addr;
      const claimed = await kvSetNX(key, JSON.stringify({ addr, sig, lamports }), 86400);   // claim ONCE — replays must not re-register liability
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        await verifyBetDepositTx(sig, addr, lamports, esc.pubkeyB58);                        // must have really landed in escrow
        await kvHincrby(BET_LEDGER, 'betLiability', lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true });
      } catch (e) {
        await kvDel(key).catch(() => {});                                                    // release so a real deposit can retry
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: (e && e.message) || 'deposit not verified', retry: true });
      }
    }

    if (action === 'bj-settle') {
      const handId = String(body.handId || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!handId) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId required' }); }
      // Server-to-server only — the trusted game server signs the settlement.
      if (!verifyGameProof(req, 'bj-settle:' + handId + ':' + gts)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      // Provable-fairness record: the committed seed must match its hash (players verify the deal with it).
      if (body.serverSeed && body.serverSeedHash) {
        const h = crypto.createHash('sha256').update(String(body.serverSeed)).digest('hex');
        if (h !== body.serverSeedHash) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad server-seed commit' }); }
      }
      const seatAddrs = Array.isArray(body.seats) ? body.seats.map((s) => String((s && (s.address || s.addr)) || s || '')).filter(Boolean) : [];
      const winnersIn = Array.isArray(body.winners) ? body.winners.map((w) => String(w)).filter(Boolean) : [];
      if (seatAddrs.length < 1) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'no seats' }); }
      // Pot from the REGISTERED antes (bj-deposit) — never the caller's claimed amounts.
      const deps = {};
      for (const a of seatAddrs) { const raw = await kvGet('bjdep:' + handId + ':' + a); if (raw) deps[a] = JSON.parse(raw); }
      const anted = Object.keys(deps);
      if (anted.length < 1) { clearTimeout(guard); done = true; return res.status(409).json({ error: 'no antes registered yet', retry: true }); }
      const pot = anted.reduce((n, a) => n + Math.floor(deps[a].lamports || 0), 0);
      const lock = await kvSetNX('lock:bj:' + handId, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const esc = getEscrow();
        const winners = winnersIn.filter((w) => deps[w]);                    // only an anted seat can win
        const isPush = body.outcome === 'push' || winners.length === 0;
        if (isPush) {
          const out = {};                                                    // refund every ante 100%, no fee
          for (const a of anted) {
            const c = await kvSetNX('bjpaid:' + handId + ':' + a, '1', 86400);
            if (!c) { out[a] = { already: true }; continue; }
            const r = await wgPayWinnerAndFee(esc, a, deps[a].lamports, 0, 'bj-push');
            if (!r.ok) { await kvDel('bjpaid:' + handId + ':' + a).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'refund held: ' + (r.reason || ''), retry: true }); }
            await kvHincrby(BET_LEDGER, 'betLiability', -deps[a].lamports).catch(() => {});
            out[a] = { sig: r.sig };
          }
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, push: true, pot, refunds: out });
        }
        // Winner(s) split the prize; the 10% fee (plus rounding dust) → CREATOR_WALLET. Each winner's
        // share and the fee are paid + accounted INDEPENDENTLY (own NX claim), so a retry after a partial
        // payout never double-pays anyone or double-charges the fee. Liability nets to exactly `pot`.
        const W = winners.length;
        const fee0 = Math.floor(pot * CREATOR_FEE_PCT);
        const prize = pot - fee0;
        const share = Math.floor(prize / W);
        const feeTotal = fee0 + (prize - share * W);                          // rounding dust rides with the fee → escrow stays exact
        const out = {};
        for (const w of winners) {
          const c = await kvSetNX('bjpaid:' + handId + ':' + w, '1', 86400);
          if (!c) { out[w] = { already: true }; continue; }
          const r = await wgPayWinnerAndFee(esc, w, share, 0, 'bj-win');
          if (!r.ok) { await kvDel('bjpaid:' + handId + ':' + w).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'payout held: ' + (r.reason || ''), retry: true }); }
          await kvHincrby(BET_LEDGER, 'betLiability', -share).catch(() => {});
          out[w] = { sig: r.sig, share };
        }
        let feeSig = null;
        if (feeTotal > 0) {
          const fc = await kvSetNX('bjfee:' + handId, '1', 86400);
          if (fc) {
            const fr = await wgPayOne(esc, CREATOR_WALLET, feeTotal, 'bj-fee');
            if (!fr.ok) { await kvDel('bjfee:' + handId).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'fee held: ' + (fr.reason || ''), retry: true }); }
            await kvHincrby(BET_LEDGER, 'betLiability', -feeTotal).catch(() => {});
            feeSig = fr.sig;
          }
        }
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, push: false, pot, fee: feeTotal, share, winners, payouts: out, feeTx: feeSig });
      } finally { await kvDel('lock:bj:' + handId).catch(() => {}); }
    }

    // bj-refund: a seat's ante is returned 100% (no fee) — e.g. a table breaks up before the hand deals,
    // or a queued player never got dealt in. Idempotent; only refunds a registered, unsettled ante.
    if (action === 'bj-refund') {
      const handId = String(body.handId || ''); const addr = String(body.address || '');
      if (!handId || !addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId, address required' }); }
      const raw = await kvGet('bjdep:' + handId + ':' + addr);
      if (!raw) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'no deposit on record' }); }
      const d = JSON.parse(raw);
      const c = await kvSetNX('bjpaid:' + handId + ':' + addr, '1', 86400);
      if (!c) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        const r = await wgPayWinnerAndFee(esc, d.addr, d.lamports, 0, 'bj-refund');
        if (!r.ok) { await kvDel('bjpaid:' + handId + ':' + addr).catch(() => {}); clearTimeout(guard); done = true; return res.status(503).json({ error: 'refund held: ' + (r.reason || ''), retry: true }); }
        await kvHincrby(BET_LEDGER, 'betLiability', -d.lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tx: r.sig });
      } catch (e) { await kvDel('bjpaid:' + handId + ':' + addr).catch(() => {}); clearTimeout(guard); done = true; return res.status(500).json({ error: (e && e.message) || 'refund failed' }); }
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
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_PAY_LOCK_TTL);
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
        await wgPush(w.region, w.lobby, 'returned', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── Wallet signature auth — required for all fund-moving actions ─────────
    // The player signs the request with their Solana private key.
    // Only the real wallet owner can produce a valid signature.
    // 'solvency' joins 'balance' as unsigned: both are READ-ONLY views of public on-chain state
    // plus aggregate liability totals. No wallet is named, nothing is mutated, no funds move.
    // 'ref-balance' is unsigned too: a referrer's accrued balance + stats are not secret and nothing
    // moves — it's the read behind the streamer's earnings panel. The PAYOUT (ref-claim) is signed.
    if (action !== 'balance' && action !== 'solvency' && action !== 'ref-balance') {
      const sig = req.headers['x-settle-sig'] || '';
      const ts  = req.headers['x-settle-ts']  || '';
      if (!verifyPlayerSig(sig, ts, action, playerAddress || '', wagerLamportsRaw)) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Invalid wallet signature — cashout must originate from the game client' });
      }
    }

    // ── ref-balance: read-only view of a referrer's accrued earnings (unsigned) ───────────────────
    if (action === 'ref-balance') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const owed  = Math.floor(Number(await kvGet('refbal:' + playerAddress)) || 0);
      const stats = (await kvHgetall('refstats:' + playerAddress)) || {};
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, owedLamports: owed, minClaimLamports: REF_MIN_CLAIM,
        players: Number(stats.players) || 0, joins: Number(stats.joins) || 0,
        accruedLamports: Number(stats.accrued) || 0, paidLamports: Number(stats.paid) || 0 });
    }

    const esc = getEscrow();

    // ── ref-claim: a referrer withdraws their accrued referral rewards ───────────────────────────
    // The wallet signature above (action='ref-claim', playerAddress=referrer, wagerLamports=0) proves
    // the caller owns the referrer wallet. Payment goes through wgPayOne, which is gated by the global
    // solvency invariant — so a referral withdrawal can ONLY ever spend genuine surplus (unswept
    // platform fees sitting in escrow) and can NEVER touch a player deposit or a bettor's stake. If
    // there isn't enough surplus yet, the claim is refused and the balance stays intact to try later.
    if (action === 'ref-claim') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      // One claim at a time per wallet, so two concurrent claims can't both read the balance and pay.
      const rcLock = await kvSetNX('lock:rc:' + playerAddress, '1', 20);
      if (!rcLock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'Claim already in progress — try again shortly' }); }
      try {
        // GETDEL: read and zero the balance atomically, so a retry or a race can't double-pay.
        const owed = Math.floor(Number(await kvGetDel('refbal:' + playerAddress)) || 0);
        if (owed <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Nothing to claim yet' }); }
        // Don't send a payout worth less than a few network fees — leave it accruing until it's worth it.
        if (owed < REF_MIN_CLAIM) {
          await kvIncrby('refbal:' + playerAddress, owed).catch(() => {}); // put it back
          clearTimeout(guard); done = true;
          return res.status(400).json({ error: 'Below minimum claim (' + (REF_MIN_CLAIM / 1e9).toFixed(4) + ' SOL) — keep earning', owedLamports: owed, minLamports: REF_MIN_CLAIM });
        }
        const pay = await wgPayOne(esc, playerAddress, owed, 'ref-claim');
        if (!pay.ok) {
          // Payout didn't happen (insolvent surplus / send failure) — restore the balance, lose nothing.
          await kvIncrby('refbal:' + playerAddress, owed).catch(() => {});
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'Payout temporarily unavailable — your balance is safe, try again shortly', retry: true });
        }
        await kvHincrby('refstats:' + playerAddress, 'paid', owed).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, paidLamports: owed, sig: pay.sig, confirmed: pay.confirmed });
      } finally { await kvDel('lock:rc:' + playerAddress).catch(() => {}); }
    }

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

      const isDuel = body.duel === true || body.duel === 'true';
      const vErr = P2P.validateCreate({ typeId, side, stakeLamports: stake, lockTs, nowMs: now,
        // subject2 is passed through UNCHANGED even for a duel: the engine must REJECT a duel that
        // tries to name its opponent, not silently drop it. Nulling it here would have hidden the
        // rule and quietly created a different wager than the caller asked for.
        subject: body.subject, subject2: body.subject2,
        minStake: WG_MIN_STAKE, maxStake: WG_MAX_STAKE, creator, duel: isDuel });
      if (vErr) { clearTimeout(guard); done = true; return res.status(400).json({ error: vErr }); }

      // Subject snake(s) must carry the game server's signature for THIS arena.
      if (!verifySnakeSig(region, lobby, body.subject, body.subjectName, body.subjIpHash, body.subjExp, body.subjSig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired snake — refresh and try again' });
      }
      // A duel names BOTH snakes up front, same as any outlast — it differs only in how it settles.
      const needs2 = P2P.getBetType(typeId).needsSubject2;
      if (needs2 && !verifySnakeSig(region, lobby, body.subject2, body.subject2Name, body.subj2IpHash, body.subj2Exp, body.subj2Sig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired second snake' });
      }

      // Back your own snake to WIN: allowed. Take a side that pays when a snake you control
      // loses: refused (that's the riggable direction).
      const rigErr = await wgRigCheck({
        bettor: creator, typeId, side,
        subject: body.subject, subject2: needs2 ? body.subject2 : null,
        subjectIpHash: body.subjIpHash, subject2IpHash: needs2 ? body.subj2IpHash : null,
        req,
      });
      if (rigErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: rigErr }); }

      const txSig = body.txSig;
      if (!txSig) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'txSig required' }); }
      if (await kvGet('wgtx:' + txSig) !== null) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Deposit already used' }); }
      await verifyBetDepositTx(txSig, creator, stake, esc.pubkeyB58);
      await kvSet('wgtx:' + txSig, '1', WG_PAY_LOCK_TTL);

      const id = 'w' + now.toString(36) + Math.random().toString(36).slice(2, 8);
      const w = {
        id, region, lobby, type: typeId, side, duel: isDuel,
        subject: body.subject, subjectName: String(body.subjectName || '').slice(0, 20),
        subject2: body.subject2 || null,
        subject2Name: String(body.subject2Name || '').slice(0, 20),
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
      await wgPush(region, lobby, 'created', wgPublic(w));
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

        // ── ANTI-SNIPE — every subject must still be in the arena RIGHT NOW ──────────────────────
        // Without this, any wager whose outcome had already been decided during its open window was
        // free money for the taker (see isFreshSnakeSig). The taker proves liveness by presenting
        // the CURRENT signed roster entry for each subject; a snake that has died or cashed out is
        // no longer in the roster, so no such signature can exist.
        const freshSubj = isFreshSnakeSig(w.region, w.lobby, w.subject, w.subjectName, w.subjIpHash || '', body.subjExp, body.subjSig);
        if (!freshSubj) {
          clearTimeout(guard); done = true;
          return res.status(409).json({ error: 'That snake is no longer in the arena — this bet can no longer be taken' });
        }
        if (w.subject2) {
          const fresh2 = isFreshSnakeSig(w.region, w.lobby, w.subject2, w.subject2Name, w.subj2IpHash || '', body.subj2Exp, body.subj2Sig);
          if (!fresh2) {
            clearTimeout(guard); done = true;
            return res.status(409).json({ error: 'One of those snakes is no longer in the arena — this bet can no longer be taken' });
          }
        }

        // A duel names both snakes at creation now, so there is nothing extra to supply here — the
        // taker simply takes the other side, and the freshness check above already proved BOTH
        // snakes are still in the arena.
        // The acceptor takes the OPPOSITE side, so the rig check must run against THAT side — not
        // the creator's. Backing your own snake to win is fine; being handed the "this snake dies"
        // side of a wager on a snake you control is exactly the riggable case.
        const takerSide = P2P.opposingSide(w.type, w.side);
        const rigErr = await wgRigCheck({
          bettor: taker, typeId: w.type, side: takerSide,
          subject: w.subject, subject2: w.subject2,
          subjectIpHash: w.subjIpHash || '', subject2IpHash: w.subj2IpHash || '',
          req,
        });
        if (rigErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: rigErr }); }
        w.status = P2P.STATUS.RESERVED; w.reservedBy = taker; w.reservedUntil = now + WG_RESERVE_MS;
        await wgSave(w);
        // ⚠️ DO NOT remove it from the wgopen: index here. It used to be zrem'd "so it leaves the book
        // at once" — but wager-list reads ONLY wgopen:/wglive:, and a reserved wager is in neither
        // until the accept lands. That ORPHANED it: invisible to wager-list, so invisible to the game
        // server's reconcile, and ssWagerTick never handled 'reserved' either. If the accept never
        // completed, the wager sat in 'reserved' forever — never matched, never returned, the
        // creator's stake stuck in escrow. That is the "friend's money stuck pending" bug.
        // It still leaves the *takeable* book instantly because wager-list filters on status==='open'.
        await wgPush(w.region, w.lobby, 'reserved', wgPublic(w));
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
        await kvSet('wgtx:' + txSig, '1', WG_PAY_LOCK_TTL);

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
        await wgPush(w.region, w.lobby, 'matched', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w) });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // NOTE: there is deliberately NO wager-cancel action. Once a wager is placed it must run to a
    // conclusion — matched wagers SETTLE on game truth, and an unmatched one is RETURNED in full at
    // lock by wager-return. Removing the endpoint (not just the button) means a creator cannot pull a
    // wager back via the API either, which also closes the free-option abuse: post a wager, watch how
    // the snake starts doing, then yank it before anyone can take the other side.

    // ── wager-hide: clear finished tickets off YOUR OWN bet slip ────────────────────────────────
    // Deliberately does NOT delete the wager record. `wg:<id>` is financial history: the sweep, the
    // settle idempotency guards (wgpaid:/wgvoid:) and any dispute all read it. What gets removed is
    // the id from `wgu:<address>` — the caller's personal index — so the ticket disappears from
    // THEIR slip and nobody else's, and nothing about the money changes.
    //
    // Guards:
    //   * signature-gated (this block sits below the wallet-signature check), so you can only ever
    //     clear your own slip.
    //   * TERMINAL statuses only. An open/reserved/matched wager still has money riding on it, and
    //     hiding it would let someone lose track of a stake that is still owed to them.
    //   * you must actually be a party to it.
    // `all: true` clears every finished ticket in one go; otherwise pass a single wagerId.
    if (action === 'wager-hide') {
      const addr = playerAddress;
      if (!addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const TERMINAL = [P2P.STATUS.SETTLED, P2P.STATUS.RETURNED, P2P.STATUS.CANCELLED];
      const wantAll = body.all === true || body.all === 'true';
      let ids = [];
      if (wantAll) {
        const z = await kvZrevrange('wgu:' + addr, 0, 199);
        if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      } else {
        const one = String(body.wagerId || '');
        if (!one) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId or all required' }); }
        ids = [one];
      }
      let hidden = 0, skipped = 0;
      for (const id of ids) {
        const w = await wgLoad(id);
        if (!w) { await kvZrem('wgu:' + addr, id).catch(() => {}); hidden++; continue; }  // dangling id
        const mine = (w.creator === addr || w.acceptor === addr);
        const finished = TERMINAL.indexOf(w.status) >= 0;
        if (!mine || !finished) { skipped++; continue; }
        await kvZrem('wgu:' + addr, id).catch(() => {});
        hidden++;
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, hidden, skipped,
        note: skipped ? 'skipped bets that are still live or not yours' : undefined });
    }

    // ── solvency: READ-ONLY view of escrow vs every claim against it ──────────────────────────
    // There was no way to see this from outside, which is exactly why "it says he won but nobody
    // got the money" was a mystery: a payout is refused when
    //     escrow < playerDeposits + betLiability + accruedFee
    // so a perfectly small bet still fails if the escrow is short against TOTAL obligations. That
    // refusal is silent to the player. This exposes the same figures assertSolvency() uses, plus
    // what a hypothetical payout would do. Moves no money, mutates nothing, reveals no secrets —
    // the escrow balance is already public via action:'balance'.
    if (action === 'solvency') {
      const probe = Math.max(0, Math.floor(Number(body.payoutLamports) || 0));
      const inv = await assertSolvency(esc.pubkeyB58, probe);
      const sol = l => (Number(l) || 0) / 1e9;
      clearTimeout(guard); done = true;
      return res.status(200).json({
        ok: true,
        escrowPubkey: esc.pubkeyB58,
        lamports: {
          escrow: inv.onChainBalance,
          playerDeposits: inv.wagerLiability,
          betLiability: inv.betLiability,
          accruedFee: inv.accruedFee,
        },
        sol: {
          escrow: sol(inv.onChainBalance),
          playerDeposits: sol(inv.wagerLiability),
          betLiability: sol(inv.betLiability),
          accruedFee: sol(inv.accruedFee),
        },
        probePayoutLamports: probe,
        payoutsWouldSucceed: !!inv.ok,
        deficitLamports: inv.deficit || 0,
        deficitSol: sol(inv.deficit || 0),
        reason: inv.reason || null,
      });
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
        // A falsy NX result means EITHER the lock is genuinely held OR KV is unreachable — lib/kv.js
        // collapses every infrastructure failure into the same null. Those two need OPPOSITE
        // responses: one clears in a couple of seconds, the other is a total outage that no amount
        // of retrying will fix. Conflating them is what made a dead KV present to every single
        // player as "cashout already in progress", burning all four client retries and leaving them
        // on a screen that says the payout did not complete. Ping to tell them apart and say which.
        const kvUp = await kvPing();
        clearTimeout(guard); done = true;
        if (!kvUp) {
          console.error('[settle] CASHOUT BLOCKED — KV unreachable, wallet=' + playerAddress);
          return res.status(503).json({
            error: 'Payout system temporarily unavailable — your wager is safe and still on record. Try Cash Out again shortly.',
            kvDown: true, retry: true });
        }
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
            // Announce the win to Discord — awaited (Vercel can freeze the function the moment the
            // response is sent) but fully guarded, so it never affects the payout or the response.
            try{
              const _wname = await kvHget('ph:'+playerAddress,'name');
              await postWinToDiscord(payout, _wname, sig);
              // Public "Live Cashouts" feed — the platform home reads cashouts:recent (name + lamports + game).
              await kvLpush('cashouts:recent', JSON.stringify({ name:_wname||'player', lamports:payout, game, ts:Date.now() }));
              await kvLtrim('cashouts:recent', 0, 49);
              await kvExpire('cashouts:recent', 172800);
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

// Exported for unit testing the Discord win-post payload in isolation (scripts/test-winpost.js).
module.exports.postWinToDiscord = postWinToDiscord;
