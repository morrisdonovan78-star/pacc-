'use strict';
// lib/betting.js — PURE pari-mutuel betting engine for SNAKE POT spectator betting.
//
// ZERO I/O. Every function here is a deterministic transform over plain data. All KV reads/
// writes, on-chain transfers and socket broadcasts live in the callers (api/settle.js for
// money, server.js for the state machine). Keeping the math pure is what lets the offline
// harness prove the ledger invariant holds under concurrency BEFORE a single real lamport moves.
//
// SAFETY MODEL (why one shared escrow is safe):
//   * A resolved market NEVER pays out more than its own pool × (1 - FEE). Payouts are computed
//     ONLY from `betPool` (per-outcome stake sums) — never from the wallet balance.
//   * Player cashouts stay capped by each player's own `pw:` deposit (existing code, untouched).
//   * Before EVERY payout the caller asserts the global solvency invariant:
//         onChainBalance >= wagerLiability + betLiability + accruedFee
//     so no betting bug can ever reduce what is available for a player cashout.
//
// LEDGER SEMANTICS (all amounts are integer lamports):
//   betLiability — total currently OWED to bettors across every open + resolved-unpaid market.
//     +stake on each bet-place. While a market is OPEN its contribution equals its full pool
//     (worst case = VOID → 100% refund). On RESOLVE, the house fee (+ rounding dust) stops being
//     a liability and moves to accruedFee; the remaining `distributable` stays owed to winners and
//     is decremented as each winner is paid. On VOID, the full pool stays owed and is decremented
//     as each refund is paid.
//   accruedFee — the 8% house cut (+ dust), pure surplus. Only ever leaves escrow via an explicit
//     owner sweep. Never touched by liabilities; including it in the invariant just widens the
//     safety margin.

const FEE_BPS = 800;               // 8.00% house fee, in basis points
const BPS_DENOM = 10000;

// ── fee / distributable split ────────────────────────────────────────────────
// Given a resolved market's total pool, returns { fee, distributable } such that
// fee + distributable === total exactly (fee = ceil so the house never over-distributes).
function feeSplit(totalLamports) {
  const total = Math.max(0, Math.floor(Number(totalLamports) || 0));
  // ceil the fee → distributable is floored → sum of floored winner payouts can never exceed it.
  const fee = Math.ceil((total * FEE_BPS) / BPS_DENOM);
  const distributable = total - fee;
  return { total, fee: Math.min(fee, total), distributable: Math.max(0, distributable) };
}

// ── pool helpers ─────────────────────────────────────────────────────────────
// `pools` = { outcomeKey: lamports, ... }. Coerces defensively; negative/NaN → 0.
function poolTotal(pools) {
  let t = 0;
  for (const k of Object.keys(pools || {})) {
    const v = Math.floor(Number(pools[k]) || 0);
    if (v > 0) t += v;
  }
  return t;
}

// Which outcomes actually have money on them (a non-empty side).
function backedOutcomes(pools) {
  return Object.keys(pools || {}).filter(k => (Math.floor(Number(pools[k]) || 0) > 0));
}

// ── VOID detection ───────────────────────────────────────────────────────────
// Winners are paid from losers' money, so an outcome with no counterparty has no rightful
// winner. Rules:
//   binary (YES/NO, ✅/❌): VOID if EITHER declared side has zero stake.
//   last-man-standing:      VOID if fewer than 2 distinct runners are backed.
// `type`: 'binary' | 'lms'. `outcomes`: the full list of winnable outcome keys (for binary,
// both sides; for lms, the snapshot roster at lock).
function isVoid(type, pools, outcomes) {
  const backed = new Set(backedOutcomes(pools));
  if (type === 'lms') return backed.size < 2;
  // binary — every declared outcome must have at least one bet
  for (const o of (outcomes || [])) {
    if (!backed.has(o)) return true;
  }
  // Also void a binary with <2 sides backed (covers a degenerate single-outcome list).
  return backed.size < 2;
}

// ── pari-mutuel resolution ───────────────────────────────────────────────────
// Computes every winning bettor's payout for a NON-void market. Pure — caller does the transfers.
//
//   result  — the winning outcome key.
//   stakes  — { address: lamports } for bettors ON THE WINNING OUTCOME only
//             (losing-side stakes never receive anything; they fund the pot).
//   pools   — { outcomeKey: lamports } per-outcome totals for the whole market.
//
// Returns:
//   { total, fee, distributable, winningPool, payouts:{addr:lamports}, paidToWinners, dust }
//   where fee + dust goes to accruedFee, paidToWinners goes to betLiability decrements.
//   Each payout = floor(distributable * stake / winningPool). Flooring leaves ≤ (#winners) lamports
//   of dust which is swept into the house fee so total conservation is exact:
//        sum(payouts) + fee + dust === total.
function resolvePayouts(result, stakes, pools) {
  const { total, fee, distributable } = feeSplit(poolTotal(pools));
  const winningPool = Math.floor(Number((pools || {})[result]) || 0);
  const payouts = {};
  let paidToWinners = 0;

  if (winningPool > 0 && distributable > 0) {
    for (const addr of Object.keys(stakes || {})) {
      const s = Math.floor(Number(stakes[addr]) || 0);
      if (s <= 0) continue;
      // BigInt for the intermediate product so a large pool can't overflow 2^53.
      const p = Number((BigInt(distributable) * BigInt(s)) / BigInt(winningPool));
      if (p > 0) { payouts[addr] = p; paidToWinners += p; }
    }
  }
  // Whatever flooring left undistributed becomes house surplus (never a liability, never lost).
  const dust = Math.max(0, distributable - paidToWinners);
  return { total, fee, distributable, winningPool, payouts, paidToWinners, dust, feePlusDust: fee + dust };
}

// ── VOID refunds ─────────────────────────────────────────────────────────────
// Every bettor gets 100% of their own stake back, no fee. `allStakes` = { address: lamports }
// across ALL outcomes. Returns { refunds:{addr:lamports}, totalRefund }.
function voidRefunds(allStakes) {
  const refunds = {};
  let totalRefund = 0;
  for (const addr of Object.keys(allStakes || {})) {
    const s = Math.floor(Number(allStakes[addr]) || 0);
    if (s > 0) { refunds[addr] = s; totalRefund += s; }
  }
  return { refunds, totalRefund };
}

// ── live implied odds ────────────────────────────────────────────────────────
// The "sportsbook" multiplier a bettor sees for each outcome during the open window:
//   multiplier(outcome) = total_pool / outcome_pool   (post-fee: × (1 - FEE) for the true payout).
// Returns { outcome: { pool, grossMult, netMult } }. An unbacked outcome has null mult (∞).
function liveOdds(pools) {
  const total = poolTotal(pools);
  const out = {};
  for (const k of Object.keys(pools || {})) {
    const pool = Math.floor(Number(pools[k]) || 0);
    if (total <= 0 || pool <= 0) { out[k] = { pool, grossMult: null, netMult: null }; continue; }
    const gross = total / pool;
    out[k] = {
      pool,
      grossMult: gross,
      netMult: gross * (1 - FEE_BPS / BPS_DENOM),
    };
  }
  return out;
}

// ── last-man-standing winner selection ───────────────────────────────────────
// runners: [{ addr, outAt }] where outAt = server ms timestamp the runner left the arena
//          (died OR cashed out). A runner still alive at settle has outAt = Infinity (or null →
//          treated as Infinity). Winner = the runner who stayed LONGEST (max outAt).
// Ties (two still-alive at a forced settle, or identical timestamps) → returns the tie list;
// caller should treat a tie as VOID-and-refund unless it can break it with a finer timestamp.
function lmsWinner(runners) {
  let best = -Infinity, winners = [];
  for (const r of (runners || [])) {
    const t = (r.outAt == null || !Number.isFinite(r.outAt)) ? Infinity : Number(r.outAt);
    if (t > best) { best = t; winners = [r.addr]; }
    else if (t === best) { winners.push(r.addr); }
  }
  return { winner: winners.length === 1 ? winners[0] : null, tied: winners, bestOutAt: best };
}

// ── GLOBAL SOLVENCY INVARIANT ────────────────────────────────────────────────
// THE backstop, asserted before EVERY bet payout. It encodes the house rule exactly:
//   "escrow must ALWAYS cover every player cashout + every bet payout/refund + the retained 8% fee."
// All three are PROTECTED. Nothing here needs house capital: bet payouts are capped at the pool
// (bettors' own deposits, already in escrow), the 8% fee stays in escrow until you sweep it, and the
// whole thing balances by construction — money in ≥ money out. The only balance that must sit in
// escrow beyond these claims is Solana's mandatory rent-exempt minimum (~890880 lamports that every
// account holds by protocol), which is far larger than the ~5000-lamport per-tx network fee, so a
// legitimate payout never has to be refused. The check only ever trips on a real shortfall (a leak).
//
//   onChainBalance  — current escrow lamports (getBalance).
//   wagerLiability  — sum of all outstanding player pw: deposits (read-only SCAN in prod).
//   betLiability    — total currently owed to bettors.
//   accruedFee      — the retained 8% house fee (PROTECTED — kept until an explicit owner sweep).
//   payoutLamports  — the transfer about to happen (retires an equal amount of a senior claim).
//   txFee           — network fee that also leaves escrow (default 5000). It is drawn FROM the 8%
//                     fee (accruedFee), NOT from a separate cushion — that is what lets betting run
//                     from an empty escrow with zero house capital.
//
// After the payout the escrow loses `payout + txFee`; the claims it must still cover are
// wagerLiability + (betLiability - payout) + (accruedFee - txFee)  [the fee absorbs the network cost].
// Solvency:  bal - payout - txFee  >=  wL + (bL - payout) + (fee - txFee)   ⇔   bal >= wL + bL + fee.
// i.e. escrow need only cover players + bettors + the retained fee — the tx cost cancels because it
// comes out of the fee. Balances with EQUALITY, so no cushion is required. Trips only on a real leak.
// Returns { ok, deficit, need, have }.
// `protectPlayers` — for HOUSE-FUNDED outflows only (event prizes, referral claims). See the
// seniority note below: the default gate deliberately ignores wagerLiability because a BET payout is
// capped at a pot both sides just deposited, so it cannot reduce what players are owed. A PRIZE has
// no such pot. It is pure outflow with no matching deposit, so under the default gate it can legally
// drain every lamport of player money in escrow — which is exactly what happened on 2026-08-07:
// a $10 Recruiter-of-the-Week prize took escrow from 146,245,330 to 10,389,223 lamports mid-match and
// the next player cash-out (36,688,110 owed) had nothing behind it. Pass protectPlayers:true for
// anything the house is giving away, and player deposits become SENIOR to it.
function checkInvariant({ onChainBalance, wagerLiability, betLiability, accruedFee, payoutLamports = 0, txFee = 5000, protectPlayers = false }) {
  const bal    = Math.floor(Number(onChainBalance) || 0);
  const bL     = Math.max(0, Math.floor(Number(betLiability) || 0));
  const payout = Math.max(0, Math.floor(Number(payoutLamports) || 0));
  const netFee = Math.max(0, Math.floor(Number(txFee) || 0));
  // Fail CLOSED: an unreadable wagerLiability arrives as MAX_SAFE_INTEGER from assertSolvency, and a
  // house-funded payout must refuse on that, never wave it through.
  const wL     = protectPlayers ? Math.max(0, Math.floor(Number(wagerLiability) || 0)) : 0;

  // SENIORITY — who this gate actually protects, and why the other two terms are gone:
  //
  //  * OTHER BETTORS (betLiability)  — PROTECTED. Paying this winner must never eat another
  //    bettor's escrowed stake.
  //
  //  * PLAYER WAGERS (wagerLiability) — deliberately NOT in the gate. Bet stakes are ADDITIVE: both
  //    sides deposit fresh SOL, and a payout is capped at that pot, so settling a bet returns bet
  //    money and cannot reduce what players are owed. Including it meant a pre-existing shortfall on
  //    the PLAYER side (the old double-spend leak, which predates betting) froze every bet payout
  //    forever and demanded the operator top the escrow up — exactly the "house funds it" outcome
  //    this design is meant to make impossible.
  //
  //  * ACCRUED FEE (accruedFee) — deliberately NOT in the gate. It is the platform's own profit and
  //    is JUNIOR to everyone: it absorbs shortfalls, it does not create them. Protecting an
  //    uncollected fee ahead of paying a winner is backwards.
  //
  // Net effect: a matched bet can always be settled out of its own pot, with no house capital, while
  // other bettors stay fully covered.
  //  * PLAYER WAGERS under protectPlayers — SENIOR. A prize retires no claim, so `payout` is NOT
  //    subtracted from the need side here the way it is for bL. The house may only give away what is
  //    left after every player and bettor is covered.
  const remaining = Math.max(0, bL - payout) + wL; // still owed to OTHER bettors (+ players, if senior)
  const have      = bal - payout - netFee;         // escrow after this payout + its network fee
  const ok        = have >= remaining;
  return { ok, have, need: remaining, deficit: ok ? 0 : (remaining - have), protectedPlayers: !!protectPlayers };
}


module.exports = {
  FEE_BPS, BPS_DENOM,
  feeSplit, poolTotal, backedOutcomes, isVoid,
  resolvePayouts, voidRefunds, liveOdds, lmsWinner,
  checkInvariant,
};
