'use strict';
// Records a player's wager server-side after they deposit on-chain.
// 1. Verifies their wallet signature (proves they own the wallet).
// 2. Verifies the on-chain tx (proves they actually paid).
// 3. Stores wallet → wagerLamports in KV (settle.js reads this at cashout time).

const nacl   = require('tweetnacl');
const crypto = require('crypto');
const { kvGet, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrem, kvHincrby, kvIncrby, kvHget, kvHset, kvLpush, kvLtrim } = require('../lib/kv');

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

/*
 * -- THE PLATFORM-WIDE $0.25 PAID FLOOR ---------------------------------------------------------
 * FREE lobbies are untouched and always will be. Every PAID room, in every game, starts at a
 * quarter: under that the 10% fee is worth about a cent while the round still costs a full set of
 * function invocations, RPC calls and an on-chain payout, so the platform pays to run it.
 *
 * For snake and Pac-Man THE LOBBY ID IS THE STAKE (see api/admin.js) -- `ss-paid-lobby-0.25` is a
 * quarter-dollar snake arena -- so the floor is a property of the room name and needs no price
 * lookup, no chain read and no KV read to enforce. Kart and Battle Royale carry cents on the lobby
 * object instead and clamp the same way in their own normStake().
 *
 * Returns null for anything that is not a paid room id -- a free lobby, a spectate id, junk -- so
 * a caller can tell "free" apart from "paid, and this cheap".
 */
const MIN_PAID_USD = 0.25;
function paidStakeUsdOf(lobbyId) {
  const m = /^(?:ss-(?:og-)?)?paid-lobby-(\d{1,6}(?:\.\d{1,2})?)$/.exec(String(lobbyId || ''));
  return m ? Number(m[1]) : null;
}
function belowPaidFloor(lobbyId) {
  const usd = paidStakeUsdOf(lobbyId);
  return usd !== null && usd > 0 && usd < MIN_PAID_USD;
}

// Mint the entry credentials for a paid room. The game token is a deterministic HMAC of
// (lobbyId, wallet) — it carries no per-tx state — so it can be re-issued at any time for a
// wallet that has already paid. That property is what makes the join endpoint safely idempotent
// (see the replay-guard block below). Returns { gameToken, entryToken } — both null for a lobby
// id we don't recognise.
function mintTokensFor(walletAddress, lobbyId) {
  // ss-paid-* are the snake game's paid rooms (authoritative sim); paid-lobby-* are legacy Pac-Man
  // rooms. Snake paid lobbies can be ANY stake — the room id is just a label; the money is the
  // on-chain deposit this endpoint verified, and the game server creates the arena on demand
  // (getOrCreateRoom) validating only the token, not a fixed allowlist.
  // `ss-og-` is the ORIGINAL game mode's twin of an ss- room (ss-og-paid-lobby-5). Same stake, same
  // escrow, same token shape — only the arena rules differ — so it mints exactly like its Zone Wars
  // counterpart. Without it here every paid ORIGINAL join gets a null token and is refused at the
  // door AFTER the deposit has already gone through.
  const VALID_LOBBIES = new Set(['ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);
  const isValidLobby = VALID_LOBBIES.has(lobbyId) || /^(ss-(?:og-)?)?paid-lobby-(\d{1,6})(\.\d{1,2})?$/.test(lobbyId || '');
  return {
    gameToken:  isValidLobby ? makeGameToken(walletAddress, lobbyId)  : null,
    entryToken: isValidLobby ? makeEntryToken(walletAddress, lobbyId) : null,
  };
}

const ESCROW_PUBKEY = '2SYFfCsSmKr8qwK1AfWd36JtAc1BCaRaSSxyECKUJjBb';

// ── HOW LONG A DEPOSIT MAY BE RE-PRESENTED ──────────────────────────────────────────────────────
// A resume lets somebody into a paid room WITHOUT a fresh payment, so the only case it may ever
// cover is the one it was written for: THIS join attempt asking again because its own HTTP reply
// was lost. The client's retry budget is two calls of ~50s plus backoff (~105s worst case), so a
// genuine same-attempt retry always lands inside three minutes.
//
// Anything older is a different situation entirely: the join FAILED, the player was refunded by
// hand, and the pw: entry outlived the refund because a wallet-to-wallet transfer cannot know to
// remove it. Letting that back in is the operator paying twice for one deposit. So the window is
// short and the deposit must also be the very one that opened the entry — see the guard below.
const RESUME_WINDOW_MS = 180_000;

// ── Referral program ────────────────────────────────────────────────────────────────────────────
// Invite-only: a referrer earns a tiny reward EACH time a player they referred completes a real
// (paid) join, for REF_WINDOW_MS after that player was first referred. Only owner-minted codes
// (refcode:<CODE> in KV) work — there is no public sign-up. The reward is a flat lamport amount,
// NOT a live-priced cent, so the hot join path never has to fetch a price; retune the constant if
// the SOL price drifts far or streamers want more. It is a promise-to-pay counter only — no SOL
// moves here; the referrer withdraws an accrued balance later through the solvency-gated ref-claim
// action in settle.js, which can only ever spend surplus platform fees, never player deposits.
const REF_WINDOW_MS       = 90 * 24 * 60 * 60 * 1000; // 3 months from first referral
const REF_BIND_TTL_SEC    = 100 * 24 * 60 * 60;       // refby lives a bit past the window, then self-cleans
const REF_REWARD_LAMPORTS = 66667;                    // ~1¢ at ~$150 SOL — tune freely, it's a bonus
const normalizeCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);

// ── Qualified invites — a referred player only COUNTS for their referrer once their cumulative PAID
// wager crosses this threshold (real money at risk = the anti-alt wall). One all-time total per
// referrer, in `refstats:<ref>` field `qualified`.
//
// This used to be bucketed per rolling 7-day week (`recruit:<weekId>`) because it fed the weekly
// Recruiter-of-the-Week contest, which is GONE — removed 2026-08-17 at the owner's request, prize,
// leaderboard, schedule and week arithmetic all together. With no contest there is no week, so there
// is nothing to bucket by and nothing that can renumber: a referrer's total only ever goes up.
const REF_QUALIFY_LAMPORTS = 60000000;                // ~0.06 SOL (~$9-10) of real wagering

// ── Free Entry Grind — play GRIND_TARGET paid $5 games inside a grind window → earn one free $5
// credit (credit:<wallet>). KEEP these windows in sync with the 'grind' entries in the client
// SNAKE_EVENTS + api/settle.js. $5 lobby id is ss-paid-lobby-5.
// Saturday 4–5 PM ET, the hour straight after Bounty Hour — but ONLY on the Saturdays listed in
// SCHEDULED_SATURDAYS. This must stay identical to SCHEDULED_SATURDAYS in api/settle.js: the grind
// hands out a free $5 entry, so a window opening on a week the operator never scheduled gives away
// real money. Occurrence ids are unchanged ('grind-YYYY-MM-DD') because they key the per-window
// progress counters.
const GRIND_TARGET = 10;
const SCHEDULED_SATURDAYS = ['2026-07-25'];                // ← keep in sync with api/settle.js
const SATURDAY_ANCHOR = Date.UTC(2026, 6, 25, 18, 0, 0);   // Sat Jul 25 2026 14:00 ET
const GRIND_WEEK_MS   = 7 * 24 * 3600 * 1000;
function activeGrindEvent(now) {
  now = now || Date.now();
  const i = Math.floor((now - SATURDAY_ANCHOR) / GRIND_WEEK_MS);
  const sat = SATURDAY_ANCHOR + i * GRIND_WEEK_MS;
  const day = new Date(sat).toISOString().slice(0, 10);
  if (SCHEDULED_SATURDAYS.indexOf(day) < 0) return null;   // no event scheduled that week
  const start = sat + 2 * 3600 * 1000;                     // Bounty is 2–4, grind is 4–5
  const e = { id: 'grind-' + day, start, end: start + 3600 * 1000 };
  return (now >= e.start && now < e.end) ? e : null;
}

/* ⚠️ REFERRAL REWARDS ARE OFF. Owner's decision, 2026-08-07 — no payout leaves escrow that the owner
 * did not schedule, and this one accrued forever on every paid join without ever being scheduled.
 *
 * It was the last automatic giveaway left after the Recruiter-of-the-Week drain (that contest, and
 * with it the unscheduled prize that caused the drain, was deleted outright on 2026-08-17):
 * REF_REWARD_LAMPORTS banked to a referrer on EVERY paid
 * join, withdrawable from the SAME escrow account that holds live players' stakes. Switched off with
 * every outstanding `refbal:` balance verified at ZERO across all known referrers, so nothing is
 * stranded and nobody is owed anything.
 *
 * ⚠️ KEEP IN SYNC with REFERRAL_REWARDS_ENABLED in api/settle.js — that one refuses the ref-claim
 * withdrawal. Both must be true for money to move at all; leaving either half on is what would let
 * escrow keep draining after the owner switched it off. Nothing is deleted: existing keys are left
 * untouched, so flipping both back on resumes exactly where it stopped. */
const REFERRAL_REWARDS_ENABLED = false;

/* ⚠️ TRACKING IS A SEPARATE SWITCH, AND IT IS ON. 2026-08-14, owner's call.
 *
 * The one flag above used to gate this whole function with a `return` on line 1, which stopped three
 * different things at once: the money (`refbal:` accrual), the first-touch BIND, and the qualified-
 * recruit COUNT that feeds the leaderboard. Only the first of those is a payout. Killing the other
 * two meant that from 2026-08-07 nobody who shared an invite link was recorded anywhere — no bind, no
 * count — so the Recruiter board could only ever show people the operator hand-credited through the
 * admin panel, and every real referral silently went nowhere. Reported as "when people are sending
 * referral link it should show on leaderboard even when the event isn't running or a payment is not
 * scheduled for it".
 *
 * Splitting them restores attribution WITHOUT reopening the payout: binding and counting are pure
 * bookkeeping in KV, and no lamport is written or withdrawable while REFERRAL_REWARDS_ENABLED stays
 * false.
 *
 * (The leaderboard that split was made for — Recruiter of the Week — was removed entirely on
 * 2026-08-17. Tracking outlived it deliberately: the invite link is still on the profile page and in
 * the game, and a player is still shown how many friends they brought. It just no longer feeds a
 * weekly contest, and there is no longer any path by which counting one can pay anybody.) */
const REFERRAL_TRACKING_ENABLED = true;

// First-touch bind + per-join accrual. Fully wrapped by the caller's try/catch AND its own — the
// referral program must NEVER be able to fail a legitimate paid join.
async function accrueReferral(playerWallet, refCodeRaw, wagerLamports) {
  if (!REFERRAL_TRACKING_ENABLED) return;
  // Resolve who (if anyone) this player is referred by. First touch wins and is permanent.
  let bind = null;
  try { const raw = await kvGet('refby:' + playerWallet); if (raw) bind = JSON.parse(raw); } catch (_) {}

  if (!bind) {
    const code = normalizeCode(refCodeRaw);
    // LOG THE MISSES. Each of these used to be a silent `return`, so a referral that never bound looked
    // exactly like one nobody ever tried — there was no way to answer "my friend used my link and it
    // still says 0". The player wallet is truncated; the code is not secret (it is in the share link).
    if (!code) {
      console.log('[ref] no code on join', { wallet: String(playerWallet).slice(0, 8) });
      return;                                            // never referred, or the link was never clicked
    }
    const referrer = await kvGet('refcode:' + code);     // owner-minted code → referrer wallet
    if (!referrer) {
      console.warn('[ref] UNKNOWN CODE — no bind', { code, wallet: String(playerWallet).slice(0, 8) });
      return;
    }
    if (referrer === playerWallet) {
      console.warn('[ref] self-referral refused', { code });
      return;
    }
    bind = { code, ref: referrer, ts: Date.now() };
    // NX so two concurrent first-joins can't double-bind; if we lost the race, reload the winner.
    // TTL outlives the reward window by a margin, then self-cleans (an expired bind can never
    // over-pay anyway — the window is re-checked against bind.ts below on every accrual).
    const set = await kvSetNX('refby:' + playerWallet, JSON.stringify(bind), REF_BIND_TTL_SEC);
    if (!set) { try { bind = JSON.parse(await kvGet('refby:' + playerWallet)); } catch (_) { return; } }
    else {
      await kvHincrby('refstats:' + bind.ref, 'players', 1).catch(() => {});
      console.log('[ref] BOUND', { code, referrer: String(referrer).slice(0, 8), player: String(playerWallet).slice(0, 8) });
    }
  }

  if (!bind || !bind.ref) return;
  if (Date.now() - Number(bind.ts || 0) > REF_WINDOW_MS) return; // 3-month window elapsed

  // Accrue the reward. refbal is the WITHDRAWABLE balance — the only thing in this function that is
  // money, and the only thing the rewards flag has to stop. `joins` is a counter for the streamer's
  // dashboard and stays live so attribution is still visible with the payout switched off; `accrued`
  // mirrors refbal, so it must move with it or the dashboard would claim a balance nobody holds.
  if (REFERRAL_REWARDS_ENABLED) {
    await kvIncrby('refbal:' + bind.ref, REF_REWARD_LAMPORTS).catch(() => {});
    await kvHincrby('refstats:' + bind.ref, 'accrued', REF_REWARD_LAMPORTS).catch(() => {});
  }
  await kvHincrby('refstats:' + bind.ref, 'joins', 1).catch(() => {});

  // Count this referee ONCE for their referrer, the first time their cumulative paid wager crosses
  // the qualify threshold. The `refq:` NX flag makes it exactly-once even under concurrent joins, and
  // it is the SAME flag as before the contest was removed — never rename or clear it, or every
  // already-qualified referee would be counted a second time. (Same-wallet self-referral is already
  // impossible — blocked at bind above.)
  try {
    if (!(await kvGet('refq:' + playerWallet))) {
      const tot = await kvIncrby('refwag:' + playerWallet, Number(wagerLamports) || 0);
      if (tot >= REF_QUALIFY_LAMPORTS && await kvSetNX('refq:' + playerWallet, String(Date.now()))) {
        await kvHincrby('refstats:' + bind.ref, 'qualified', 1).catch(() => {});
        console.log('[ref] QUALIFIED INVITE', { referrer: String(bind.ref).slice(0, 8), player: String(playerWallet).slice(0, 8), wageredLamports: tot });
      } else {
        // The commonest honest answer to "why is it still 0": they are attributed, just short of the bar.
        console.log('[ref] qualify progress', { referrer: String(bind.ref).slice(0, 8), wageredLamports: tot, needLamports: REF_QUALIFY_LAMPORTS });
      }
    }
  } catch (_) {}
}

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
/*
 * ⚠️ THE DEPOSIT SEARCH IS ONLY AS GOOD AS THIS LIST, and half of it was dead.
 *
 * Measured 2026-08-01:
 *   try-rpc.mainnet-beta.solana.com  -> DNS does not resolve at all (getaddrinfo failed)
 *   solana.public-rpc.com            -> TLS certificate verification fails
 * settle.js and rpc.js were repaired when that was found; join.js was missed, so the one path that
 * decides whether a player who has ALREADY PAID gets into the game was still asking four nodes of
 * which only two could answer. rpcCallFound concludes "not found" once every node has answered, so
 * fewer live nodes means a deposit that one of them simply has not indexed yet reads as missing —
 * and the player watches "Still verifying deposit… (2/2)" and then gets nothing.
 *
 * Same list as settle.js. Keep them in step.
 */
const RPCS = [
  process.env.HELIUS_RPC_URL,                        // PRIMARY: set in Vercel env vars
  process.env.SOLANA_RPC_URL,                        // optional second private endpoint
  'https://solana-rpc.publicnode.com',               // free, no key, verified healthy (121ms)
  'https://api.mainnet-beta.solana.com',             // Solana official (rate-limited under load)
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
  /*
   * BUDGET, not a fixed attempt count. The player's money is already gone by the time we are called,
   * so giving up early does not protect anyone — it just produces "charged and not let in".
   *
   * Six attempts spanned about ten seconds against a 20s function ceiling, so two thirds of the
   * available time went unused while a lagging public RPC was still catching up. The ceiling is now
   * 60s and this searches for up to ~40 of them, leaving comfortable headroom for the rest of the
   * handler. Short waits first, because a healthy tx is usually indexed within a second or two.
   */
  const deadline = Date.now() + 40000;
  for (let attempt = 0; attempt < 24 && Date.now() < deadline; attempt++) {
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

    const { walletAddress, wagerLamports, txSig, lobbyId, playerName, refCode } = body;

    /*
     * ── PREFLIGHT: "can this endpoint let anyone in right now?" ────────────────────────────────────
     * Asked by the client BEFORE it signs and broadcasts the deposit, and answered without touching
     * the chain, KV, or any signature — so it costs almost nothing and cannot itself be the thing
     * that fails.
     *
     * The point is ORDERING. The deposit is irreversible and instant; the part that lets the player
     * into the room is this function. Doing them in that order means every outage here — the project
     * over its plan's compute allowance and being throttled, a bad deploy, a missing GAME_SECRET —
     * lands as "charged and not let in", which is the worst outcome this game can produce and the one
     * people report. If the endpoint is unreachable the fetch below simply fails and the client stops
     * before spending anything, so a broken join costs the player nothing but a retry.
     *
     * `ready` is false rather than absent when the secret is missing, because a token minted without
     * GAME_SECRET is null and the game server rejects it — paying first and finding that out after is
     * the same trap by another route.
     */
    if (body.preflight) {
      const secret = (process.env.GAME_SECRET || '').trim();
      /*
       * The floor is answered HERE, in the preflight, because this is the one moment it can be
       * answered for free. By the time the real call arrives the deposit is already on chain and
       * irreversible, and every refusal down there lands as "charged and not let in" -- the worst
       * outcome this endpoint can produce. ready:false makes the client stop before it signs, so a
       * player aimed at a sub-floor room is turned away having spent nothing.
       */
      const tooCheap = belowPaidFloor(lobbyId);
      return res.status(200).json({
        ok: true,
        ready: !!secret && !tooCheap,
        reason: tooCheap ? 'stake-below-minimum' : (secret ? null : 'server-misconfigured'),
        minPaidUsd: MIN_PAID_USD,
        lobbyId: lobbyId || null,
      });
    }
    const sig = req.headers['x-settle-sig'] || '';
    const ts  = req.headers['x-settle-ts']  || '';
    const lamps = Number(wagerLamports) || 0;

    if (!walletAddress)  return res.status(400).json({ error: 'walletAddress required' });
    if (lamps <= 0)      return res.status(400).json({ error: 'wagerLamports must be positive' });
    if (!txSig)          return res.status(400).json({ error: 'txSig required' });
    /*
     * Below the floor, refused before the replay guard, the wager record or anything else is
     * written, so this request leaves nothing behind it. The shipped clients cannot produce such a
     * request: the games floor the stake at the top of joinLobby, the platform pages floor the
     * Custom box, and the preflight above already answered ready:false. Reaching here means a call
     * hand-made to skip all three, so it is refused rather than minted -- otherwise the floor is a
     * UI suggestion rather than a rule. A deposit such a caller chose to broadcast anyway is not
     * consumed here; it stays theirs to claim, exactly as any other rejected join.
     */
    if (belowPaidFloor(lobbyId)) {
      return res.status(400).json({
        error: 'Paid lobbies start at $' + MIN_PAID_USD.toFixed(2) + '. Pick a lobby at or above that, or play free.',
        minPaidUsd: MIN_PAID_USD,
      });
    }

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
      // This txSig is already on record. Two very different situations both land here:
      //
      //  1. LEGIT LOST-RESPONSE RETRY (the common case, and the bug this guards against too
      //     eagerly): the FIRST /api/join for this deposit already succeeded server-side — it
      //     wrote this replay guard, wrote the pw: wager, and minted a token — but its HTTP
      //     response never reached the client. Vercel froze/killed the function the instant the
      //     KV writes finished, or the network dropped the reply, or the client's _redeemDeposit
      //     retry loop fired again after a slow first call. The player DID pay, and their wager is
      //     still on record and unconsumed. Rejecting here is exactly the "it charged me a dollar
      //     then sent me home saying transaction already registered" report — the money left their
      //     wallet and they got nothing. Because the game token is a deterministic HMAC of
      //     (wallet, lobby), we can re-issue the SAME credentials and let them into the room they
      //     already paid for. No new charge, no new pw:, no double-counted stats.
      //
      //  2. TRUE REPLAY (the attack the guard exists for): an OLD txSig re-submitted AFTER the
      //     wager was consumed. Cashout, being killed, and losing all kvDel the pw: entry, so a
      //     spent deposit has no active wager to re-enter. Keep rejecting.
      //
      // pw: present ⇔ an active, unconsumed paid wager ⇔ case 1. pw: absent ⇔ case 2.
      // What we recorded when this deposit was first accepted. Older records were the string '1' and
      // carry no wallet or timestamp — they are, by definition, from a previous session, so they fall
      // through to the refusal below exactly as an expired record would.
      let rec = null;
      try { const p = JSON.parse(alreadyUsed); if (p && typeof p === 'object') rec = p; } catch (_) {}

      // Somebody else's deposit. Never mint credentials off it, whatever state their entry is in.
      if (rec && rec.w && rec.w !== walletAddress) {
        return res.status(400).json({ error: 'That deposit belongs to a different wallet' });
      }

      const existingWager = await kvGet('pw:' + walletAddress);
      const openedBy      = await kvGet('pwtx:' + walletAddress);
      const ageMs         = rec && rec.t ? Date.now() - Number(rec.t) : Infinity;

      /*
       * RESUME ONLY THE ATTEMPT THAT IS STILL HAPPENING.
       *
       * All three conditions describe one situation and nothing else: this exact deposit opened the
       * entry, the entry is still unconsumed, and it happened seconds ago — i.e. the first /api/join
       * succeeded and only its reply was lost, and the client in front of us is the same one retrying.
       * Letting that through is what stops "it charged me and said transaction already registered".
       *
       * Every other path lands on the refusal. In particular a join that FAILED and was refunded by
       * hand: its pw: entry survives the refund (nothing on-chain can clear it), and re-presenting the
       * old deposit used to walk straight back in — the operator's money out twice for one payment.
       * A stale entry is never a ticket. The player makes a new deposit; they already have their SOL back.
       */
      const sameAttempt = existingWager !== null && openedBy === txSig && ageMs <= RESUME_WINDOW_MS;

      if (sameAttempt) {
        console.warn('[join] RESUMED in-flight join (lost response)', {
          wallet: String(walletAddress).slice(0, 8), lobbyId, ageMs,
          lamports: Number(existingWager) || lamps, txSig: String(txSig).slice(0, 12),
        });
        const { gameToken, entryToken } = mintTokensFor(walletAddress, lobbyId);
        // A resumed join is still a REAL paid join for referral purposes. This path returned before
        // accrueReferral ever ran, so a referee whose first join happened to be a lost-response retry
        // was silently never attributed — one of the ways "my friend used my link and it says 0"
        // happens with everything else configured correctly.
        try { await accrueReferral(walletAddress, refCode, Number(existingWager) || lamps); } catch (_) {}
        /* ⚠️⚠️ CLEAR THE DEAD FLAG AND THE CASH-OUT LOCK HERE TOO.
         *
         * The fresh-join path below does this ~35 lines further down, and THIS path returns before ever
         * reaching it. So a player who died and then rejoined inside the resume window kept a live
         * `dead:<wallet>` — which has a 600s TTL — and every cash-out for the next TEN MINUTES was refused
         * with "Cannot cashout — you were eliminated" while they were alive and playing. Reported from a
         * $1 lobby with the player very much not dead, repeatedly, on stream.
         *
         * Safe for exactly the same reason it is safe below: reaching here means the resume was accepted,
         * which required the SAME deposit that opened this entry. A new paid entry means the previous
         * round's death is over, so its flag must not outlive it. Same for `lock:co:`, which would
         * otherwise answer "cashout already in progress" from a session that has ended. */
        kvDel('dead:' + walletAddress).catch(() => {});
        kvDel('lock:co:' + walletAddress).catch(() => {});
        return res.status(200).json({ ok: true, recorded: Number(existingWager) || lamps, gameToken, entryToken, resumed: true });
      }

      // Refused. Log LOUDLY when an unconsumed entry was still sitting there — that entry is money the
      // player paid and did not get to play, so it wants refunding and clearing (settle:'wager-orphans'
      // lists them, settle:'clear-entry' clears them once the SOL is back).
      if (existingWager !== null) {
        console.warn('[join] REFUSED stale entry — deposit re-presented after the attempt ended', {
          wallet: String(walletAddress).slice(0, 8), lobbyId, ageMs,
          lamports: Number(existingWager), txSig: String(txSig).slice(0, 12),
          openedBy: openedBy ? String(openedBy).slice(0, 12) : null,
          note: 'refund this wallet if it never played, then clear-entry',
        });
      }
      return res.status(400).json({
        error: 'That deposit has already been used. If a join failed you were refunded — start a new game.',
        stale: true,
      });
    }

    // On-chain tx proves they actually paid
    await verifyWagerTx(txSig, walletAddress, lamps);

    // Store replay guard (24h) before the wager entry so even a partial failure blocks replay.
    // It records WHO paid and WHEN, because the re-presentation branch above has to tell an
    // in-flight retry apart from an old deposit being offered again — it cannot do that from a bare '1'.
    await kvSet(txKey, JSON.stringify({ w: walletAddress, l: lamps, t: Date.now() }), 86400);

    /* A deposit belongs to the ROOM it bought, and until now nothing recorded which room that was.
     * `pw:` is keyed by wallet alone, so one wallet has exactly one live wager entry across all five
     * games — and a $1 Pac-Man entry that was never consumed reads back, byte for byte, as the stake
     * for the $0.25 snake lobby that wallet joins next. That is not hypothetical: it is the
     * 23-Aug-2026 report, where a player carried a $1 base into a 25c room, dropped $1 of gold on
     * death, and the wallet that ate it cashed out $1 of other people's escrow.
     *
     * The lobby id IS the stake here (`ss-paid-lobby-0.25` is a quarter-dollar snake arena — see
     * api/admin.js), so binding the entry to its lobby id is enough to make every downstream reader
     * able to tell "this player's stake" from "some stake this player once had". Same TTL as `pw:`
     * so the two expire together and can never be found disagreeing.
     *
     * Read by: settle's `stake-read` (refuses to hand the game server a stake from another room) and
     * the cash-out proof check (refuses a proof signed for a room this deposit did not buy). */
    const priorLobby = await kvGet('pwlob:' + walletAddress).catch(() => null);
    const priorWager = await kvGet('pw:' + walletAddress).catch(() => null);
    if (priorWager !== null && priorLobby && priorLobby !== lobbyId) {
      /* The player is paying into a new room while an unconsumed entry from a different room is still
       * standing. The write below replaces it, and that older deposit is then money in escrow that no
       * cash-out can ever draw — `wager-orphans` lists it, `clear-entry` clears it once refunded. It
       * is not silently correctable here: the SOL is on-chain and only the operator can send it back. */
      console.warn('[join] CROSS-LOBBY entry replaced — earlier deposit is now stranded in escrow', {
        wallet: String(walletAddress).slice(0, 8),
        priorLobby, priorLamports: Number(priorWager) || 0,
        newLobby: lobbyId, newLamports: lamps,
        note: 'refund the prior deposit if it never played (settle: wager-orphans / clear-entry)',
      });
    }

    // Store for 4 hours — more than enough for any game session
    await kvSet('pw:' + walletAddress, lamps, 14400);
    // Which ROOM this deposit bought. Written after `pw:` deliberately: a reader that finds `pw:` but
    // not `pwlob:` treats the entry as legacy and lets it through (see stake-read), so the worst case
    // of a half-completed write is the old, permissive behaviour — never a player locked out of a
    // room they actually paid for.
    await kvSet('pwlob:' + walletAddress, lobbyId, 14400);
    // Which deposit opened this entry. Same TTL as the entry, so the two can never disagree, and it is
    // what lets a resume require the SAME payment rather than any payment this wallet ever made.
    await kvSet('pwtx:' + walletAddress, txSig, 14400);
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
    let nameTaken=null;   // set when a requested display name is already held by another wallet
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
            /*
             * A NAME BELONGS TO THE WALLET THAT CLAIMED IT FIRST.
             *
             * This used to overwrite nameReg:<NAME> unconditionally, so ANY account could take a name
             * already in use simply by setting it and doing a paid join. That is not a cosmetic
             * problem: `nameReg` is what "Find a player" and the Recipient ID box resolve a name to,
             * so taking someone's name redirects money people meant to send THEM. A player lost $3.80
             * to an impersonator of GODBLESSED42 this way.
             *
             * First claim wins and is permanent. A name in use by another wallet is refused outright
             * and the claimer simply keeps whatever name they had - nothing is overwritten, so the
             * mapping money is resolved through can never silently move to a different person.
             */
            const heldBy = await kvGet('nameReg:'+clean).catch(()=>null);
            if(heldBy && heldBy !== walletAddress){
              console.warn('[name] REFUSED - already claimed', { name: clean,
                heldBy: String(heldBy).slice(0,8), attemptedBy: String(walletAddress).slice(0,8) });
              nameTaken = clean;
            } else {
              if(current) { await kvDel('nameReg:'+current).catch(()=>{}); await kvZrem('nameIndex',current).catch(()=>{}); }
              await kvHset(namePk,'name',clean);
              await kvSetPerm('nameReg:'+clean, walletAddress);
              await kvZadd('nameIndex', 0, clean);
            }
          }
        }
      }
      const wagTot=await kvHincrby(statsPk,'wagered',lamps);
      await kvHincrby(statsPk,'games',1);
      // Keep sorted set score in sync (score = current earned lamports)
      const earned=await kvHget(statsPk,'earned');
      await kvZadd('lb:'+game+':earned',Number(earned)||0,walletAddress);
      /*
       * PROFIT-CHART POINT FOR THE ENTRY ITSELF — this is the half that was missing.
       *
       * Only payouts were ever recorded, so the profile sparkline could physically only slope up:
       * money going OUT of the player's pocket produced no point at all. Recording the entry (with
       * cumulative wagered) is what lets the chart dip when they pay in and rise when they cash out,
       * which is what makes it a real net-profit line rather than a gross-payouts line.
       *
       * A death needs no point of its own: the dip already happened here, at the entry, and never
       * being followed by a cashout IS the loss. That also avoids trusting a client-reported loss
       * amount, which is not verifiable server-side.
       */
      try{
        const hk='ph:'+game+':hist:'+walletAddress;
        const _rec={t:Date.now(),e:Number(earned)||0,w:Number(wagTot)||0,ty:'join',a:lamps};
        await kvLpush(hk,JSON.stringify(_rec));
        // 2000, not 200: every entry, cash-out and kill writes a point, so 200 is one busy evening and
        // the chart's 1M/6M/1Y views all showed the same few hours. KEEP IN SYNC with HIST_MAX in
        // api/settle.js, along with the per-day rollup below.
        await kvLtrim(hk,0,1999);
        // One field per UTC day, overwritten through the day, so the long timeframes have something to
        // draw once the raw window has rolled past. Same cumulative e/w, so the two series share an axis.
        try{ await kvHset('phd:'+game+':'+walletAddress,new Date(_rec.t).toISOString().slice(0,10),JSON.stringify(_rec)); }catch(_){}
      }catch(_){}
      // Global counters
      await kvHincrby('ph:'+game+':global','totalWagered',lamps);
      await kvHincrby('ph:'+game+':global','gamesPlayed',1);
    }catch(_){}

    // Referral accrual — never allowed to fail the join (own try/catch + best-effort writes inside).
    try{ await accrueReferral(walletAddress, refCode, lamps); }catch(_){}

    // Free Entry Grind — count paid $5 games in the window; every GRIND_TARGET grants one free $5 credit.
    try{
      const gev = activeGrindEvent();
      if(gev && lobbyId === 'ss-paid-lobby-5'){
        const n = await kvIncrby('grind:' + gev.id + ':' + walletAddress, 1);
        if(n % GRIND_TARGET === 0){ await kvIncrby('credit:' + walletAddress, 1).catch(()=>{}); }
      }
    }catch(_){}

    // Issue a game token — HMAC-signed proof of payment for the Socket.io server.
    // The Socket.io server validates this on connection; without it paid lobbies are rejected.
    // (Same mint is re-used by the idempotent lost-response retry path above.)
    const { gameToken, entryToken } = mintTokensFor(walletAddress, lobbyId);

    return res.status(200).json({ ok: true, recorded: lamps, gameToken, entryToken, nameTaken });
  } catch (e) {
    console.error('[join]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exported for unit testing the referral accrual logic in isolation (see scripts/test-referral.js).
module.exports.accrueReferral = accrueReferral;
// The two flags are exported so the suite asserts the SHIPPED values, not a copy of them. A test that
// hardcodes "rewards are off" passes just as happily when somebody flips the constant back on.
module.exports._refConsts = { REF_WINDOW_MS, REF_REWARD_LAMPORTS, REF_QUALIFY_LAMPORTS,
                              REFERRAL_REWARDS_ENABLED, REFERRAL_TRACKING_ENABLED };
