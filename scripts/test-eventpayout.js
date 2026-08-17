'use strict';
// Offline unit tests for lib/eventpayout.js — proves winner selection, the $35 turnout bump,
// USD→lamports conversion, and solvency/fail-closed behaviour with ZERO real SOL.
const P = require('../lib/eventpayout');

let pass = 0, fail = 0;
const eq = (got, want, msg) => { if (got === want) pass++; else { fail++; console.error('  FAIL ' + msg + ' — got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); } };

const SOL = 150;                              // $150/SOL for round-ish numbers
const L = usd => Math.floor((usd / SOL) * 1e9);
const board = n => Array.from({ length: n }, (_, i) => ({ addr: 'W' + i + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'P' + i, kills: n - i }));
const BIG = 100 * 1e9;                        // plenty of escrow

// 1. Normal 2-winner payout, no bump (fewer than 10 players)
let r = P.planBountyPayout({ board: board(5), solPriceUsd: SOL, escrowLamports: BIG, prizes: { first: 25, second: 15, bump: 35 } });
eq(r.ok, true, 'normal payout ok');
eq(r.bumped, false, 'no bump under 10 players');
eq(r.winners.length, 2, 'pays two winners');
eq(r.winners[0].usd, 25, '1st = $25 without bump');
eq(r.winners[0].addr, 'W0aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '1st is the top killer');
eq(r.winners[1].usd, 15, '2nd = $15');
eq(r.winners[0].lamports, L(25), '1st lamports correct');
eq(r.totalLamports, L(25) + L(15), 'total = 25+15');

// 2. Turnout bump — 10+ players each with a kill → 1st jumps to $35
r = P.planBountyPayout({ board: board(10), solPriceUsd: SOL, escrowLamports: BIG, prizes: { first: 25, second: 15, bump: 35 } });
eq(r.bumped, true, 'bump triggers at 10 players');
eq(r.winners[0].usd, 35, '1st = $35 when packed');
eq(r.winners[1].usd, 15, '2nd stays $15 when bumped');

// 3. Bump edge — exactly 9 players does NOT bump
r = P.planBountyPayout({ board: board(9), solPriceUsd: SOL, escrowLamports: BIG });
eq(r.bumped, false, '9 players does not bump');
eq(r.winners[0].usd, 25, '1st stays $25 at 9 players');

// 4. Only one player with a kill → single winner, no 2nd
r = P.planBountyPayout({ board: board(1), solPriceUsd: SOL, escrowLamports: BIG });
eq(r.ok, true, 'single-winner ok');
eq(r.winners.length, 1, 'one winner only');
eq(r.winners[0].usd, 25, 'lone winner gets 1st');

// 5. Players with zero kills are ignored (never win)
r = P.planBountyPayout({ board: [{ addr: 'Wzero', name: 'Z', kills: 0 }, { addr: 'Wone', name: 'O', kills: 1 }], solPriceUsd: SOL, escrowLamports: BIG });
eq(r.winners.length, 1, 'zero-kill players excluded');
eq(r.winners[0].addr, 'Wone', 'only the killer wins');

// 6. Empty board → no payout, fail-closed
r = P.planBountyPayout({ board: [], solPriceUsd: SOL, escrowLamports: BIG });
eq(r.ok, false, 'empty board pays nothing');

// 7. Insufficient float → refuse ENTIRELY (never partial-pay)
r = P.planBountyPayout({ board: board(5), solPriceUsd: SOL, escrowLamports: L(20), prizes: { first: 25, second: 15 } });
eq(r.ok, false, 'insufficient float refuses');
eq(r.reason, 'insufficient float', 'reports insufficient float');
eq(r.shortfall > 0, true, 'reports a shortfall amount');

// 8. Floor is respected — escrow above prizes but not above prizes+floor → refuse
r = P.planBountyPayout({ board: board(5), solPriceUsd: SOL, escrowLamports: L(40), floorLamports: L(10), prizes: { first: 25, second: 15 } });
eq(r.ok, false, 'floor reserve enforced');

// 9. No SOL price → cannot size the payout, fail-closed
r = P.planBountyPayout({ board: board(5), solPriceUsd: 0, escrowLamports: BIG });
eq(r.ok, false, 'no price fails closed');

// 10. There is NO recruiter payout planner any more. Cases 10 and 11 used to exercise
// planRecruiterPayout — the single-winner $10 Recruiter-of-the-Week prize — which was deleted along with
// the contest on 2026-08-17. Asserting its absence is worth a line: this is the only module that can
// turn a referral count into lamports, so if the function ever comes back, it comes back deliberately.
eq(typeof P.planRecruiterPayout, 'undefined', 'no recruiter payout planner is exported');

console.log((fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
