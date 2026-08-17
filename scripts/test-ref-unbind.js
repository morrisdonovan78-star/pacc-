'use strict';
/*
 * Unit tests for the hand-credit door and the count behind it:
 *
 *   1. api/admin.js  `ref-bind` / `ref-unbind` — crediting a referral by hand, and taking it back off
 *      the wrong wallet (added 2026-08-14).
 *   2. api/admin.js  `ref-qualified-import` — the one-shot fold of the old weekly buckets into the
 *      all-time counter (added 2026-08-17).
 *   3. api/settle.js `my-refcode` — a player's link and their all-time count.
 *
 * ⚠️ UPDATED 2026-08-17, when Recruiter of the Week was removed. The `recruiter-board` section is gone
 * with the action it tested, and every assertion that read `recruit:<weekId>` now reads the single
 * all-time field `refstats:<ref>` `qualified`. Nothing about the unbind's actual guarantees was
 * relaxed to make that happen — the floor, the dry run, the untouched refbal and the 404 are all still
 * here — and one of them got STRONGER: a credit banked before the week rolled over used to be refused
 * as unremovable, and is now simply removable (case 7).
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

// A WK constant used to live here, mirroring RECRUIT_ANCHOR so the test could name the week bucket a
// credit should land in. There is no week any more — see scripts/test-recruiter-removed.js.

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
  refby:     store.has('refby:' + PLAYER),
  refq:      store.has('refq:' + PLAYER),
  players:   Number((H('refstats:' + REF_WRONG) || {}).players) || 0,
  qualified: Number((H('refstats:' + REF_WRONG) || {}).qualified) || 0,
});
// The all-time qualified count for any referrer.
const qual = (ref) => Number((H('refstats:' + ref) || {}).qualified) || 0;

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
  eq(s.qualified, 1, 'ref-bind increments the all-time qualified count');

  // ── 2. dry run reports the truth and writes NOTHING ───────────────────────────────────────────
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.code, 200, 'ref-unbind dry succeeds');
  eq(r.body.plan.referrer, REF_WRONG, 'dry run names the wallet currently holding the credit');
  eq(r.body.plan.wasQualifiedRecruit, true, 'dry run sees the qualified flag');
  eq(r.body.plan.willRemoveRecruit, true, 'dry run knows the credit is removable');
  eq(r.body.plan.qualifiedBefore, 1, 'dry run reports the count it would decrement');
  eq(JSON.stringify(bindState()), JSON.stringify({ refby: true, refq: true, players: 1, qualified: 1 }),
     'DRY RUN CHANGES NOTHING');

  // ── 3. the real unbind reverses exactly those four writes ─────────────────────────────────────
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(r.code, 200, 'ref-unbind succeeds');
  eq(r.body.removedRecruit, true, 'ref-unbind reports the recruit removal');
  s = bindState();
  eq(s.refby, false, 'ref-unbind clears refby');
  eq(s.refq, false, 'ref-unbind clears refq');
  eq(s.players, 0, 'ref-unbind decrements refstats players');
  eq(s.qualified, 0, 'ref-unbind decrements the all-time qualified count');

  // ── 4. …and the referee can now be credited to the RIGHT person ───────────────────────────────
  r = await callAdmin({ action: 'ref-bind', referrer: REF_RIGHT, address: PLAYER, countRecruit: true }, TOKEN);
  eq(r.code, 200, 're-bind to the correct referrer succeeds (first touch was freed)');
  eq(r.body.countedRecruit, true, 're-bind counts the credit again');
  eq(qual(REF_RIGHT), 1, 'the correct referrer now holds the credit');
  eq(qual(REF_WRONG), 0, 'the wrong referrer holds none');

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

  // ── 7. AN OLD CREDIT IS NOW REMOVABLE — the limitation the removal actually fixed ──────────────
  //
  // This case used to assert the opposite: a credit banked before the week boundary was reported as
  // NOT removable and deliberately left alone, because the only bucket the unbind could reach was the
  // CURRENT week's, and decrementing that instead would have left the real count stuck AND put a
  // phantom -1 in a week nobody touched. An operator who noticed the mistake a week late had no undo.
  //
  // With one all-time counter there is no wrong bucket to reach for, so the age of the credit stops
  // mattering. The assertion is inverted on purpose — this is a behaviour change, not a rename.
  store.clear();
  store.set('refby:' + PLAYER, JSON.stringify({ code: 'MANUAL', ref: REF_WRONG, ts: Date.now() - 40 * 24 * 3600 * 1000 }));
  store.set('refq:' + PLAYER, String(Date.now()));
  store.set('refstats:' + REF_WRONG, { players: '1', qualified: '1' });   // credited over a month ago
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.body.plan.willRemoveRecruit, true, 'a month-old credit is removable now');
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(qual(REF_WRONG), 0, 'the old credit comes off however long ago it was made');

  // ── 7b. …but it still cannot go NEGATIVE. The floor is the half of case 7 that must not regress:
  // a qualified referee whose referrer has no count recorded leaves the counter at 0, not -1.
  store.clear();
  store.set('refby:' + PLAYER, JSON.stringify({ code: 'MANUAL', ref: REF_WRONG, ts: Date.now() }));
  store.set('refq:' + PLAYER, String(Date.now()));                        // qualified, but never counted
  r = await callAdmin({ action: 'ref-unbind', address: PLAYER, dry: true }, TOKEN);
  eq(r.body.plan.willRemoveRecruit, false, 'nothing to remove when the count is already 0');
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(qual(REF_WRONG), 0, 'qualified count floors at 0, never negative');

  // ── 8. a missing players stat can never be driven negative ────────────────────────────────────
  store.clear();
  store.set('refby:' + PLAYER, JSON.stringify({ code: 'MANUAL', ref: REF_WRONG, ts: Date.now() }));
  await callAdmin({ action: 'ref-unbind', address: PLAYER }, TOKEN);
  eq(Number((H('refstats:' + REF_WRONG) || {}).players) || 0, 0, 'players stat floors at 0, never negative');

  // ══ 9. ref-qualified-import: the old week buckets fold into the all-time counter ════════════════
  // This is the migration that stops every referrer's number restarting at zero on the deploy that
  // removed the contest. Counts spread across three week buckets, exactly as they sit in KV now.
  store.clear();
  store.set('recruit:rw0', { [REF_WRONG]: '3', [REF_RIGHT]: '1' });
  store.set('recruit:rw1', { [REF_RIGHT]: '2' });
  store.set('recruit:rw2', { [REF_RIGHT]: '1' });
  // A count already earned under the NEW field, i.e. someone qualified between deploy and import. The
  // import must ADD to this, never overwrite it — overwriting would throw the fresh one away.
  store.set('refstats:' + REF_RIGHT, { qualified: '5' });

  r = await callAdmin({ action: 'ref-qualified-import', dry: true }, TOKEN);
  eq(r.code, 200, 'import dry run succeeds');
  eq(r.body.totalAdded, 7, 'dry run totals every bucket (3 + 1+2+1)');
  eq(r.body.referrers, 2, 'dry run finds both referrers');
  eq(qual(REF_RIGHT), 5, 'DRY RUN CHANGES NOTHING');
  eq(qual(REF_WRONG), 0, 'dry run writes nothing for the other referrer either');

  r = await callAdmin({ action: 'ref-qualified-import' }, TOKEN);
  eq(r.code, 200, 'import succeeds');
  eq(qual(REF_RIGHT), 9, 'buckets are ADDED to the existing count, not overwritten (5 + 4)');
  eq(qual(REF_WRONG), 3, 'the other referrer gets their bucket total too');

  // Idempotent: running it again must not double anybody. This is the whole reason for the per-referrer
  // `refqi:` flag, and the failure it prevents is silently doubling every player's number.
  r = await callAdmin({ action: 'ref-qualified-import' }, TOKEN);
  eq(r.body.totalAdded, 0, 'a second run adds nothing');
  eq(r.body.skipped.length, 2, 'both referrers are reported as already imported');
  eq(qual(REF_RIGHT), 9, 'RE-RUNNING DOES NOT DOUBLE-COUNT');
  eq(qual(REF_WRONG), 3, 'nor for the second referrer');

  // A referrer added to a bucket AFTER a partial import still gets picked up — an interrupted run must
  // be completable by simply running it again, which a single global "done" flag would have blocked.
  const REF_THIRD = 'ThirdRefWa11etDdDdDdDdDdDdDdDdDdDdDdDdDd';
  store.set('recruit:rw3', { [REF_THIRD]: '4' });
  r = await callAdmin({ action: 'ref-qualified-import' }, TOKEN);
  eq(r.body.totalAdded, 4, 'a later run imports only what is still missing');
  eq(qual(REF_THIRD), 4, 'the newly-seen referrer is imported');
  eq(qual(REF_RIGHT), 9, 'and the already-imported ones are untouched');

  // ── 10. my-refcode serves the link and ONE all-time count ─────────────────────────────────────
  r = await callSettle({ action: 'my-refcode', playerAddress: REF_RIGHT });
  eq(r.code, 200, 'my-refcode succeeds');
  eq(typeof r.body.code, 'string', 'my-refcode returns a code');
  eq(r.body.link, 'https://snakepot.com/?ref=' + r.body.code, 'my-refcode returns the share link');
  eq(r.body.qualified, 9, 'my-refcode reports the all-time qualified count');
  eq(r.body.recruitsAllTime, 9, 'the old field name carries the same value for older clients');
  eq(r.body.scheduled, undefined, 'my-refcode no longer reports a prize week');
  eq(r.body.weekEnd, undefined, 'my-refcode no longer reports a week deadline');

  // ── 11. the deleted actions are really gone from the router ────────────────────────────────────
  // A removed action must not fall through to some other handler and answer 200 with a stray body.
  for (const action of ['recruiter-board', 'recruiter-settle', 'recruit-migrate']) {
    r = await callSettle({ action, playerAddress: REF_RIGHT });
    eq(r.code === 200 && r.body && (r.body.top || r.body.allTime || r.body.ok) ? 'answered' : 'not handled',
       'not handled', action + ' is no longer served');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
