'use strict';
/*
 * Unit tests for the two things that changed on 2026-08-14:
 *
 *   1. api/admin.js  `ref-unbind` — taking a hand-credited referral back off the wrong wallet.
 *   2. api/settle.js `recruiter-board` / `my-refcode` — all-time recruit totals, so the leaderboard
 *      no longer empties itself every Saturday on weeks that pay nothing.
 *
 * These drive the REAL exported handlers through a mocked lib/kv, not a reimplementation of their
 * logic. A suite that only tests a copy of the rules is how `rotEditFrame` stayed missing from an
 * export list while 28/28 went green: if the shipped code calls it, the test has to call it too.
 *
 * Run: node scripts/test-ref-unbind.js
 */

// ── in-memory KV mock, injected before either handler loads ─────────────────────────────────────
const store = new Map();                       // string keys → string | plain-object (hashes)
const kvMockPath = require.resolve('../lib/kv.js');
const H = (k) => { const h = store.get(k); return (h && typeof h === 'object') ? h : null; };
require.cache[kvMockPath] = { id: kvMockPath, filename: kvMockPath, loaded: true, exports: {
  kvPing:     async () => true,
  kvGet:      async (k) => (store.has(k) && typeof store.get(k) !== 'object' ? store.get(k) : null),
  kvGetDel:   async (k) => { const v = store.get(k) ?? null; store.delete(k); return v; },
  kvSet:      async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetPerm:  async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetNX:    async (k, v) => { if (store.has(k)) return null; store.set(k, String(v)); return 'OK'; },
  kvDel:      async (k) => { store.delete(k); return 1; },
  kvIncrby:   async (k, d) => { const n = (Number(store.get(k)) || 0) + Number(d); store.set(k, String(n)); return n; },
  kvExpire:   async () => 1,
  kvZadd:     async () => 1,
  kvZrem:     async () => 1,
  kvZrevrange: async () => [],
  kvHincrby:  async (k, f, d) => { const h = H(k) || {}; h[f] = String((Number(h[f]) || 0) + Number(d)); store.set(k, h); return Number(h[f]); },
  kvHget:     async (k, f) => { const h = H(k); return h && h[f] !== undefined ? h[f] : null; },
  kvHset:     async (k, f, v) => { const h = H(k) || {}; h[f] = String(v); store.set(k, h); return 1; },
  kvHsetnx:   async () => 1,
  kvHgetall:  async (k) => { const h = H(k); return h ? { ...h } : null; },
  kvLpush:    async () => 1,
  kvLtrim:    async () => 'OK',
  kvLrange:   async () => [],
  kvMget:     async (keys) => keys.map(() => null),
  // Glob → RegExp, enough for the `recruit:rw*` / `refcode:*` patterns this codebase actually uses.
  kvScan:     async (pattern) => {
    const rx = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...store.keys()].filter((k) => rx.test(k));
  },
}};

process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_SECRET   = 'test-secret-0123456789';

const admin  = require('../api/admin.js');
const settle = require('../api/settle.js');

const REF_WRONG = 'WrongRefWa11etAaAaAaAaAaAaAaAaAaAaAaAaAa';
const REF_RIGHT = 'RightRefWa11etCcCcCcCcCcCcCcCcCcCcCcCcCc';
const PLAYER    = 'RefereeWa11etBbBbBbBbBbBbBbBbBbBbBbBbBb';

// Must match RECRUIT_ANCHOR in api/admin.js, api/settle.js and api/join.js — see the note in any of
// the three. If they ever drift again this constant is what makes the test say so.
const WK = 'rw' + Math.floor((Date.now() - Date.UTC(2026, 6, 25, 18, 0, 0)) / (7 * 24 * 60 * 60 * 1000));

// ── tiny harness ────────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
};

function mockRes() {
  const r = { code: 200, body: null };
  r.setHeader = () => {};
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const callAdmin = async (body, token) => {
  const res = mockRes();
  await admin({ method: 'POST', query: {}, headers: { 'x-admin-token': token }, body }, res);
  return res;
};
const callSettle = async (body) => {
  const res = mockRes();
  await settle({ method: 'POST', query: {}, headers: {}, body }, res);
  return res;
};

const bindState = () => ({
  refby:   store.has('refby:' + PLAYER),
  refq:    store.has('refq:' + PLAYER),
  players: Number((H('refstats:' + REF_WRONG) || {}).players) || 0,
  recruit: Number((H('recruit:' + WK) || {})[REF_WRONG]) || 0,
});

(async () => {
  // Log in once through the real auth route — the mod actions are gated on a real signed token.
  const authRes = mockRes();
  await admin({ method: 'POST', query: { do: 'auth' }, headers: {}, body: { password: 'test-password' } }, authRes);
  eq(authRes.code, 200, 'auth returns 200');
  const TOKEN = (authRes.body || {}).token;
  eq(typeof TOKEN, 'string', 'auth mints a session token');

  // ── 1. ref-bind lays down all four writes ─────────────────────────────────────────────────────
  store.clear();
  let r = await callAdmin({ action: 'ref-bind', referrer: REF_WRONG, address: PLAYER, countRecruit: true }, TOKEN);
  eq(r.code, 200, 'ref-bind succeeds');
  eq(r.body.countedRecruit, true, 'ref-bind counts the qualified recruit');
  let s = bindState();
  eq(s.refby, true, 'ref-bind writes refby');
  eq(s.refq, true, 'ref-bind writes refq');
  eq(s.players, 1, 'ref-bind increments refstats players');
  eq(s.recruit, 1, 'ref-bind increments the CURRENT week bucket (' + WK + ')');

  // ── 2. dry run reports the truth and writes NOTHING ───────────────────────────────────────────
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.code, 200, 'ref-unbind dry succeeds');
  eq(r.body.plan.referrer, REF_WRONG, 'dry run names the wallet currently holding the credit');
  eq(r.body.plan.wasQualifiedRecruit, true, 'dry run sees the qualified flag');
  eq(r.body.plan.willRemoveRecruit, true, 'dry run knows the recruit is removable');
  eq(r.body.plan.week, WK, 'dry run targets the current week bucket');
  eq(JSON.stringify(bindState()), JSON.stringify({ refby: true, refq: true, players: 1, recruit: 1 }),
     'DRY RUN CHANGES NOTHING');

  // ── 3. the real unbind reverses exactly those four writes ─────────────────────────────────────
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(r.code, 200, 'ref-unbind succeeds');
  eq(r.body.removedRecruit, true, 'ref-unbind reports the recruit removal');
  s = bindState();
  eq(s.refby, false, 'ref-unbind clears refby');
  eq(s.refq, false, 'ref-unbind clears refq');
  eq(s.players, 0, 'ref-unbind decrements refstats players');
  eq(s.recruit, 0, 'ref-unbind decrements the week bucket');

  // ── 4. …and the referee can now be credited to the RIGHT person ───────────────────────────────
  r = await callAdmin({ action: 'ref-bind', referrer: REF_RIGHT, address: PLAYER, countRecruit: true }, TOKEN);
  eq(r.code, 200, 're-bind to the correct referrer succeeds (first touch was freed)');
  eq(r.body.countedRecruit, true, 're-bind counts the recruit again');
  eq(Number((H('recruit:' + WK) || {})[REF_RIGHT]) || 0, 1, 'the correct referrer now holds the recruit');
  eq(Number((H('recruit:' + WK) || {})[REF_WRONG]) || 0, 0, 'the wrong referrer holds none');

  // ── 5. unbinding a wallet nobody referred is a 404, not a silent no-op ────────────────────────
  store.clear();
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(r.code, 404, 'unbinding an unbound wallet 404s');

  // ── 6. accrued referral SOL is REPORTED but never touched ─────────────────────────────────────
  store.clear();
  await callAdmin({ action: 'ref-bind', referrer: REF_WRONG, address: PLAYER, countRecruit: true }, TOKEN);
  store.set('refbal:' + REF_WRONG, '133334');                       // two paid joins' worth
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.body.plan.referrerRefbalLamports, 133334, 'dry run reports the accrued lamports');
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(store.get('refbal:' + REF_WRONG), '133334', 'ref-unbind does NOT move accrued SOL');

  // ── 7. a credit sitting in an OLDER week is never taken out of an unrelated one ────────────────
  store.clear();
  store.set('refby:' + PLAYER, JSON.stringify({ code: 'MANUAL', ref: REF_WRONG, ts: Date.now() }));
  store.set('refq:' + PLAYER, String(Date.now()));
  store.set('recruit:rw0', { [REF_WRONG]: '1' });                   // banked in a past week
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.body.plan.willRemoveRecruit, false, 'a past-week credit is reported as NOT removable');
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(Number((H('recruit:' + WK) || {})[REF_WRONG]) || 0, 0, 'no phantom -1 in the current week');
  eq(Number((H('recruit:rw0') || {})[REF_WRONG]) || 0, 1, 'the past week is left alone');

  // ── 8. a missing players stat can never be driven negative ────────────────────────────────────
  store.clear();
  store.set('refby:' + PLAYER, JSON.stringify({ code: 'MANUAL', ref: REF_WRONG, ts: Date.now() }));
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(Number((H('refstats:' + REF_WRONG) || {}).players) || 0, 0, 'players stat floors at 0, never negative');

  // ══ recruiter-board: all-time totals survive the weekly reset ══════════════════════════════════
  // Counts spread across three week buckets, only one of which is the current week.
  store.clear();
  store.set('recruit:rw0', { [REF_WRONG]: '3', [REF_RIGHT]: '1' });
  store.set('recruit:rw1', { [REF_RIGHT]: '2' });
  store.set('recruit:' + WK, { [REF_RIGHT]: '1' });

  r = await callSettle({ action: 'recruiter-board', playerAddress: REF_RIGHT });
  eq(r.code, 200, 'recruiter-board succeeds');
  eq(r.body.scheduled, false, 'the current week is NOT a scheduled prize week');
  eq(r.body.prize, 0, 'an unscheduled week advertises no prize');
  eq(r.body.top.length, 1, 'the weekly board still shows only this week');
  eq(r.body.allTime.length, 2, 'the all-time board shows everyone who ever qualified');
  eq(r.body.allTime[0].recruits, 4, 'all-time leader total is summed across every week (1+2+1)');
  eq(r.body.youAllTime.recruits, 4, 'the caller sees their own all-time total');
  eq(r.body.youAllTime.rank, 1, 'the caller is ranked all-time');
  eq(r.body.you.recruits, 1, 'the weekly figure is still reported alongside it');

  // The 60s cache must not be able to serve a stale board after a correction.
  store.set('recruit:' + WK, { [REF_RIGHT]: '9' });
  await require('../lib/kv').kvDel('recruitall:cache');
  r = await callSettle({ action: 'recruiter-board', playerAddress: REF_RIGHT });
  eq(r.body.youAllTime.recruits, 12, 'dropping the cache reflects a correction immediately (3+9)');

  // ── my-refcode carries the all-time number too ────────────────────────────────────────────────
  r = await callSettle({ action: 'my-refcode', playerAddress: REF_RIGHT });
  eq(r.code, 200, 'my-refcode succeeds');
  eq(r.body.recruitsAllTime, 12, 'my-refcode reports the all-time total');
  eq(r.body.recruits, 9, 'my-refcode still reports the weekly total');
  eq(r.body.scheduled, false, 'my-refcode reports whether a prize week is running');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
