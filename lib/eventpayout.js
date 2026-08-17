'use strict';
// lib/eventpayout.js — PURE payout-planning for scheduled events. No KV, no network, no on-chain:
// given a board + escrow balance + SOL price, it decides WHO gets paid and HOW MUCH. All the risky
// logic (winner selection, the $35 turnout bump, solvency, never-overspend) lives here so it is
// unit-tested offline (see scripts/test-eventpayout.js). settle.js does only auth, KV, and the
// actual transfer (reusing the proven cash-out path).

const LAMPORTS_PER_SOL = 1e9;

// USD → lamports at a given SOL price. Floors to whole lamports.
function usdToLamports(usd, solPriceUsd) {
  if (!(solPriceUsd > 0) || !(usd > 0)) return 0;
  return Math.floor((usd / solPriceUsd) * LAMPORTS_PER_SOL);
}

// Bounty Hour: 1st + 2nd from the kill board, with a turnout bump.
//   board: [{ addr, name, kills }] (already sorted desc; we re-sort defensively)
//   prizes: { first, second, bump } in USD (defaults 25 / 15 / 35)
//   bumpMinPlayers: distinct players with >=1 kill needed to trigger the bump (default 10)
//   escrowLamports: current escrow balance; floorLamports: never spend below this (float/rent safety)
// Returns { winners:[{addr,name,place,usd,lamports}], totalLamports, bumped, ok, reason }.
function planBountyPayout(opts) {
  const {
    board = [], solPriceUsd = 0, escrowLamports = 0, floorLamports = 0,
    prizes = {}, bumpMinPlayers = 10,
  } = opts || {};
  const first = prizes.first != null ? prizes.first : 25;
  const second = prizes.second != null ? prizes.second : 15;
  const bumpFirst = prizes.bump != null ? prizes.bump : 35;

  const rows = board
    .map(r => ({ addr: String(r.addr || ''), name: r.name || '', kills: Number(r.kills) || 0 }))
    .filter(r => r.addr && r.kills > 0)
    .sort((a, b) => b.kills - a.kills);

  if (rows.length === 0) return { winners: [], totalLamports: 0, bumped: false, ok: false, reason: 'no qualifying players' };
  if (!(solPriceUsd > 0)) return { winners: [], totalLamports: 0, bumped: false, ok: false, reason: 'no SOL price' };

  // Turnout bump: enough distinct players each landed at least one kill → 1st place is richer.
  const bumped = rows.length >= bumpMinPlayers;
  const firstUsd = bumped ? bumpFirst : first;

  const winners = [];
  winners.push({ addr: rows[0].addr, name: rows[0].name, place: 1, usd: firstUsd, lamports: usdToLamports(firstUsd, solPriceUsd) });
  if (rows.length >= 2 && second > 0) {
    winners.push({ addr: rows[1].addr, name: rows[1].name, place: 2, usd: second, lamports: usdToLamports(second, solPriceUsd) });
  }

  return finalizePlan(winners, escrowLamports, floorLamports, bumped);
}

// planRecruiterPayout lived here — the single-winner $10 Recruiter-of-the-Week prize. Removed with the
// rest of that contest on 2026-08-17. Nothing turns a referral count into lamports any more, which is
// the point: this file is now only reachable from the Bounty Hour, which is schedule-gated by hand.

// Shared: verify the plan fits inside spendable escrow. NEVER partial-pay a subset — if the whole
// plan doesn't fit, refuse entirely so a human can top up the float (fail-closed, no half payouts).
function finalizePlan(winners, escrowLamports, floorLamports, bumped) {
  winners = winners.filter(w => w.lamports > 0);
  const totalLamports = winners.reduce((s, w) => s + w.lamports, 0);
  const spendable = Math.max(0, Number(escrowLamports) - Number(floorLamports || 0));
  if (totalLamports <= 0) return { winners: [], totalLamports: 0, bumped, ok: false, reason: 'zero payout' };
  if (totalLamports > spendable) {
    return { winners, totalLamports, bumped, ok: false, reason: 'insufficient float', shortfall: totalLamports - spendable };
  }
  return { winners, totalLamports, bumped, ok: true, reason: 'ok' };
}

module.exports = { planBountyPayout, usdToLamports, LAMPORTS_PER_SOL };
