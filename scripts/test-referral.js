'use strict';
// Unit test for the referral accrual logic (api/join.js accrueReferral). Mocks lib/kv with an
// in-memory store BEFORE requiring join.js, so it exercises the real shipped function — bind rules,
// self-referral block, the 3-month window, and per-join accrual — with no network or real KV.
const path = require('path');

// ── in-memory KV mock, injected into the module cache before join.js loads ──────────────────────
const store = new Map();
const kvMockPath = require.resolve('../lib/kv.js');
require.cache[kvMockPath] = { id: kvMockPath, filename: kvMockPath, loaded: true, exports: {
  kvGet:     async k => (store.has(k) ? store.get(k) : null),
  kvSet:     async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetNX:   async (k, v) => { if (store.has(k)) return null; store.set(k, String(v)); return 'OK'; },
  kvDel:     async k => { store.delete(k); return 1; },
  kvSetPerm: async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvZadd: async () => 1, kvZrem: async () => 1,
  kvHincrby: async (k, f, d) => { const h = store.get(k) || {}; h[f] = (Number(h[f]) || 0) + Number(d); store.set(k, h); return h[f]; },
  kvIncrby:  async (k, d) => { const n = (Number(store.get(k)) || 0) + Number(d); store.set(k, String(n)); return n; },
  kvHget: async () => null, kvHset: async () => 'OK',
}};

const join = require('../api/join.js');
const { REF_WINDOW_MS, REF_REWARD_LAMPORTS } = join._refConsts;
const R = 'RefWa11etAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const P = 'P1ayerWa11etBbBbBbBbBbBbBbBbBbBbBbBbBbBb';

let pass = 0, fail = 0;
const eq = (got, want, msg) => { if (got === want) { pass++; } else { fail++; console.error('  FAIL ' + msg + ' — got ' + got + ' want ' + want); } };
const bal = () => Number(store.get('refbal:' + R)) || 0;
const reset = () => store.clear();

(async () => {
  // 1. Unknown code → no bind, no accrual
  reset();
  await join.accrueReferral(P, 'NOPE');
  eq(store.has('refby:' + P), false, 'unknown code does not bind');
  eq(bal(), 0, 'unknown code pays nothing');

  /* THE MONEY SPLIT (2026-08-14). TRACKING is on so shared links show on the leaderboard again;
   * REWARDS stay off so no lamport is written and nothing can be withdrawn from escrow. These two
   * assertions are what stop the halves being flipped back together by accident — every reward
   * expectation below is derived from the shipped flag, not hardcoded. */
  const REWARDS  = join._refConsts.REFERRAL_REWARDS_ENABLED;
  const TRACKING = join._refConsts.REFERRAL_TRACKING_ENABLED;
  eq(REWARDS,  false, 'REFERRAL REWARDS ARE OFF — no SOL accrues on a paid join');
  eq(TRACKING, true,  'referral TRACKING is on — binds and recruit counts still happen');
  const reward = (n) => (REWARDS ? REF_REWARD_LAMPORTS * n : 0);

  // 2. Valid owner-minted code → binds first touch. Attribution happens with the payout switched off.
  reset();
  store.set('refcode:STREAM1', R);
  await join.accrueReferral(P, 'STREAM1');
  eq(!!store.get('refby:' + P), true, 'valid code binds');
  eq(bal(), reward(1), 'first paid join accrues the reward only when rewards are on');

  // 3. Subsequent joins are still counted for the streamer dashboard…
  await join.accrueReferral(P, null);
  await join.accrueReferral(P, null);
  eq(bal(), reward(3), 'later joins accrue only when rewards are on');
  eq(Number((store.get('refstats:' + R) || {}).joins) || 0, 3, 'joins are counted regardless of the reward flag');
  // …but `accrued` mirrors refbal, so it must never claim a balance the referrer does not hold.
  eq(Number((store.get('refstats:' + R) || {}).accrued) || 0, reward(3), 'accrued never overstates the real balance');

  // 4. First touch is sticky — a different code cannot re-bind an already-referred player
  reset();
  store.set('refcode:AAA', R);
  store.set('refcode:BBB', 'Other');
  await join.accrueReferral(P, 'AAA');
  await join.accrueReferral(P, 'BBB');
  eq(JSON.parse(store.get('refby:' + P)).ref, R, 'first referrer stays bound');
  eq(bal(), reward(2), 'both joins credit the ORIGINAL referrer');
  eq(Number(store.get('refbal:Other')) || 0, 0, 'the second code never gets a lamport');

  // 5. Self-referral is blocked (code resolves to the joining wallet itself)
  reset();
  store.set('refcode:SELF', P);
  await join.accrueReferral(P, 'SELF');
  eq(store.has('refby:' + P), false, 'self-referral does not bind');
  eq(Number(store.get('refbal:' + P)) || 0, 0, 'self-referral pays nothing');

  // 6. Window expiry — a join past 3 months from bind accrues nothing
  reset();
  store.set('refcode:OLD', R);
  store.set('refby:' + P, JSON.stringify({ code: 'OLD', ref: R, ts: Date.now() - (REF_WINDOW_MS + 1000) }));
  await join.accrueReferral(P, null);
  eq(bal(), 0, 'join after window pays nothing');

  // 7. Recruiter-of-the-Week qualification — a referee counts ONCE for the referrer past the threshold
  reset();
  store.set('refcode:REC', R);
  const { RECRUIT_QUALIFY_LAMPORTS, recruitWeekId } = join._refConsts;
  const half = Math.floor(RECRUIT_QUALIFY_LAMPORTS / 2) + 1;
  const rkey = 'recruit:' + recruitWeekId();
  await join.accrueReferral(P, 'REC', half);   // below threshold → not yet counted
  eq((store.get(rkey) || {})[R] || 0, 0, 'below-threshold recruit not counted');
  await join.accrueReferral(P, null, half);    // crosses threshold → counts once
  eq((store.get(rkey) || {})[R] || 0, 1, 'crossing threshold counts the recruit once');
  await join.accrueReferral(P, null, half);    // more joins must NOT double-count
  eq((store.get(rkey) || {})[R] || 0, 1, 'already-qualified recruit is not re-counted');

  console.log((fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
