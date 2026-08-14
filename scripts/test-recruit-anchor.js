'use strict';
/*
 * RECRUIT_ANCHOR guard.
 *
 * The anchor is hand-copied into THREE files — api/settle.js (reads the board), api/join.js (counts a
 * qualified recruit) and api/admin.js (hand-credits one). `recruit:<weekId>` is pure arithmetic off
 * it, so the constant carries two failure modes that both look like "the count just didn't show up":
 *
 *   1. THE COPIES DRIFT. admin.js once carried an anchor 62 hours earlier than the other two, so every
 *      hand-credited recruit landed in `recruit:rw<n+1>` while the board read `recruit:rw<n>`. The
 *      operator saw "credited" and the player's number never moved.
 *
 *   2. A SHIFT RENUMBERS THE BUCKETS. Moving the anchor by an amount that changes
 *      floor((t - anchor) / 7d) silently relabels every week: the current week's counts vanish from
 *      the leaderboard and some other week's reappear in their place. Nothing errors; the data is
 *      just filed under a name nobody reads any more.
 *
 * So this asserts the three copies are byte-identical AND pins known timestamps to known week ids.
 * A future anchor move that fails the pins is not necessarily wrong — but it needs the existing
 * `recruit:rw*` counts MIGRATED before it ships, and this test is what forces that decision to be
 * made deliberately instead of discovered by a player asking where their recruits went.
 *
 * Run: node scripts/test-recruit-anchor.js
 */
const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..');
const FILES = ['api/settle.js', 'api/join.js', 'api/admin.js'];
const WEEK  = 7 * 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + got + '\n        want ' + want); }
};

// Read the literal out of the source rather than importing it — the bug being guarded against is a
// SOURCE-level divergence between three separate `const` declarations, and only one of them is even
// exported. Comparing the raw text is what actually catches it.
const anchors = FILES.map((f) => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const m = src.match(/const\s+RECRUIT_ANCHOR\s*=\s*(Date\.UTC\([^)]*\))/);
  if (!m) { fail++; console.error('  FAIL ' + f + ' — no RECRUIT_ANCHOR declaration found'); return null; }
  // eslint-disable-next-line no-eval
  return { file: f, text: m[1].replace(/\s+/g, ''), value: eval(m[1]) };
}).filter(Boolean);

eq(anchors.length, FILES.length, 'all three files declare RECRUIT_ANCHOR');

// 1. The three copies must be identical, as text and as a value.
const first = anchors[0];
for (const a of anchors.slice(1)) {
  eq(a.text,  first.text,  a.file + ' anchor text matches ' + first.file);
  eq(a.value, first.value, a.file + ' anchor value matches ' + first.file);
}

const ANCHOR = first.value;
const weekId = (t) => 'rw' + Math.floor((t - ANCHOR) / WEEK);

// 2. Weeks must end on a MONDAY at 18:00 UTC (14:00 ET while EDT). Owner's call, 2026-08-14.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
eq(DAYS[new Date(ANCHOR).getUTCDay()], 'Mon', 'the anchor falls on a Monday');
eq(new Date(ANCHOR).getUTCHours(), 18, 'the anchor is at 18:00 UTC (2pm ET during EDT)');
eq(DAYS[new Date(ANCHOR + WEEK).getUTCDay()], 'Mon', 'every week therefore ends on a Monday');

// 3. Pinned buckets. These are the weeks that already hold real counts in KV; if a future anchor
//    change moves any of them, those counts need migrating before it ships.
const PINS = [
  ['2026-07-28T12:00:00Z', 'rw0'],
  ['2026-08-05T12:00:00Z', 'rw1'],
  ['2026-08-14T12:00:00Z', 'rw2'],
];
for (const [iso, want] of PINS) eq(weekId(Date.parse(iso)), want, iso + ' is still in ' + want);

// 4. The boundary itself: the instant a week ends belongs to the NEXT week, not the one closing.
eq(weekId(ANCHOR + WEEK - 1), 'rw0', 'the last millisecond of rw0 is still rw0');
eq(weekId(ANCHOR + WEEK),     'rw1', 'the first millisecond after is rw1');

// 5. The move that was actually made: Saturday Jul 25 → Monday Jul 27 must NOT have renumbered
//    anything, which is the only reason it shipped without a migration.
const OLD_ANCHOR = Date.UTC(2026, 6, 25, 18, 0, 0);
const oldId = (t) => 'rw' + Math.floor((t - OLD_ANCHOR) / WEEK);
for (const [iso, want] of PINS) eq(oldId(Date.parse(iso)), want, iso + ' had the same id under the old Saturday anchor');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
