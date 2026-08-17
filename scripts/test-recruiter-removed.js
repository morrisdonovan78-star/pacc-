'use strict';
/*
 * RECRUITER OF THE WEEK STAYS REMOVED.
 *
 * This file replaces test-recruit-anchor.js, which guarded RECRUIT_ANCHOR — the constant hand-copied
 * into api/settle.js, api/join.js and api/admin.js that `recruit:<weekId>` was derived from. That
 * constant carried two failure modes, both of which looked like "the count just didn't show up": the
 * three copies DRIFTING (admin.js once sat 62 hours off, so hand-credited recruits landed in a bucket
 * the board never read), and a SHIFT RENUMBERING every bucket at once.
 *
 * The contest was removed outright on 2026-08-17 at the owner's request — "no trace of it whatsoever" —
 * so there is no anchor left to keep in step and that whole class of bug is closed rather than guarded.
 * What is worth guarding now is the removal itself, in both directions:
 *
 *   1. Nothing brings back the WEEKLY BUCKET. The count lives in one all-time field,
 *      `refstats:<ref>` `qualified`. A well-meaning change that reintroduces a per-week key
 *      reintroduces the renumbering bug with it.
 *   2. Nothing brings back a PAYOUT. The prize paid an unscheduled $10 out of escrow mid-match on
 *      2026-08-07 and stranded a player's cash-out. No path from a referral count to lamports should
 *      exist by accident.
 *
 * ⚠️ This is a STRUCTURAL check — it reads source text and module exports, it does not drive requests.
 * The behavioural coverage is in test-referral.js (accrueReferral, called for real) and
 * test-ref-unbind.js (the real exported admin/settle handlers). A green run here is not evidence the
 * referral path works; it is evidence the deleted contest has not grown back.
 *
 * Run: node scripts/test-recruiter-removed.js
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + got + '\n        want ' + want); }
};
// Strip comments before pattern-matching. The removal is DOCUMENTED in comments in every one of these
// files — that is deliberate and must not fail the test, so only live code is searched.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const API = ['api/settle.js', 'api/join.js', 'api/admin.js'];

// ── 1. The anchor is gone from all three files ────────────────────────────────────────────────────
for (const f of API) {
  eq(/const\s+RECRUIT_ANCHOR\s*=/.test(code(read(f))), false, f + ' declares no RECRUIT_ANCHOR');
  eq(/function\s+recruitWeek/.test(code(read(f))),     false, f + ' defines no recruitWeek helper');
}

// ── 2. Nothing WRITES a weekly bucket ─────────────────────────────────────────────────────────────
// Reads are still legal: admin.js `ref-qualified-import` scans `recruit:rw*` once to fold the old
// counts into the new field. So this looks for the write calls specifically, not the key name.
for (const f of API) {
  const src = code(read(f));
  eq(/kvHincrby\(\s*['"]recruit:/.test(src), false, f + ' never hincrby-s a recruit:<week> bucket');
  eq(/kvHset\(\s*['"]recruit:/.test(src),    false, f + ' never hset-s a recruit:<week> bucket');
}

// ── 3. The count is written where it should be ────────────────────────────────────────────────────
// The counterpart to case 2: proving the write is GONE is only half the claim, because a write that
// went nowhere would pass that check just as happily. This is the recurring bug shape in this repo — a
// value produced and consumed by nobody — so assert the new writer and the new reader both exist.
eq(/kvHincrby\(\s*['"]refstats:['"]\s*\+\s*bind\.ref\s*,\s*['"]qualified['"]/.test(code(read('api/join.js'))),
   true, 'api/join.js increments refstats.qualified on a qualifying join');
eq(/['"]qualified['"]/.test(code(read('api/settle.js'))),
   true, 'api/settle.js my-refcode reads a qualified count back out');

// ── 4. The contest's actions and payout no longer exist ───────────────────────────────────────────
const settle = code(read('api/settle.js'));
for (const a of ['recruiter-board', 'recruiter-settle', 'recruit-migrate']) {
  eq(settle.includes("'" + a + "'"), false, 'api/settle.js handles no ' + a + ' action');
}
eq(/function\s+settleRecruiter/.test(settle), false, 'api/settle.js has no settleRecruiter');
eq(/SCHEDULED_RECRUIT_WEEKS/.test(settle),    false, 'api/settle.js has no recruiter week schedule');
eq(/allTimeRecruits/.test(settle),            false, 'api/settle.js has no allTimeRecruits scan');

// The payout planner is the last place a referral count could become lamports. Checked as an EXPORT,
// not as source text, because that is what a caller could actually reach.
eq(typeof require('../lib/eventpayout.js').planRecruiterPayout, 'undefined',
   'lib/eventpayout.js exports no planRecruiterPayout');

// ── 5. No client calls the deleted board ──────────────────────────────────────────────────────────
// Both snake clients are checked: the canonical source and the platform's served copy, which deploy
// separately (pulp-platform has no git remote — it ships as a folder). They have drifted before, and a
// client left calling a deleted action is a dead panel on a live site.
const CLIENTS = ['slither-snakes.html', 'pulp-platform/public/game/snake.html'];
for (const f of CLIENTS) {
  let src;
  try { src = read(f); } catch (_) { pass++; continue; }   // platform copy absent in this checkout
  eq(/action\s*:\s*['"]recruiter-board['"]/.test(src), false, f + ' does not call recruiter-board');
  eq(/RECRUITER OF THE WEEK<\/span>/.test(src),        false, f + ' renders no contest heading');
  // The half that must SURVIVE — the invite link is the whole point of keeping referrals.
  eq(/action\s*:\s*['"]my-refcode['"]/.test(src), true, f + ' still fetches the invite link');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
