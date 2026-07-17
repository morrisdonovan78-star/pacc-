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
// THE backstop. Asserted before EVERY payout (bet OR wager). If paying `payoutLamports` now
// would leave escrow unable to cover all remaining liabilities, REFUSE.
//
//   onChainBalance     — current escrow lamports (from getBalance).
//   wagerLiability     — sum of all outstanding player `pw:` deposits (read-only SCAN in prod).
//   betLiability       — the ledger above.
//   accruedFee         — the fee ledger above.
//   payoutLamports     — the transfer about to happen (0 for a pure check).
//   txFee              — network fee that will also leave escrow (default 5000).
//
// Requirement AFTER this payout leaves escrow:
//   onChainBalance - payoutLamports - txFee  >=  (remaining liabilities not covered by this payout)
// The payout itself retires an equal amount of liability (a bet payout decrements betLiability; a
// wager cashout decrements that player's pw:), so the check reduces to:
//   onChainBalance - txFee  >=  wagerLiability + betLiability + accruedFee
// i.e. the escrow must already fully back every liability plus the fee surplus, with room for the
// network fee. Returns { ok, deficit, need, have }.
function checkInvariant({ onChainBalance, wagerLiability, betLiability, accruedFee, payoutLamports = 0, txFee = 5000 }) {
  const bal   = Math.floor(Number(onChainBalance) || 0);
  const wL    = Math.max(0, Math.floor(Number(wagerLiability) || 0));
  const bL    = Math.max(0, Math.floor(Number(betLiability) || 0));
  const fee   = Math.max(0, Math.floor(Number(accruedFee) || 0));
  const payout = Math.max(0, Math.floor(Number(payoutLamports) || 0));
  const netFee = Math.max(0, Math.floor(Number(txFee) || 0));
  // Liabilities that must remain covered AFTER this payout retires `payout` worth of them.
  const remainingLiability = wL + bL + fee - payout;
  const have = bal - payout - netFee;         // what stays in escrow after the payout + network fee
  const ok = have >= Math.max(0, remainingLiability);
  return {
    ok,
    have,
    need: Math.max(0, remainingLiability),
    deficit: ok ? 0 : (Math.max(0, remainingLiability) - have),
  };
}

module.exports = {
  FEE_BPS, BPS_DENOM,
  feeSplit, poolTotal, backedOutcomes, isVoid,
  resolvePayouts, voidRefunds, liveOdds, lmsWinner,
  checkInvariant,
};
