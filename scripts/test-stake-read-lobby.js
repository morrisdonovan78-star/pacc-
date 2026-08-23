'use strict';
/*
 * Offline tests for the settle-side half of the 23 Aug 2026 cross-room stake leak.
 *
 * `pw:<wallet>` is keyed by wallet ALONE — one live wager entry per wallet across all five games —
 * so "what did this player deposit?" used to answer "whatever they last deposited ANYWHERE". A $1
 * Pac-Man entry the player never consumed answered for the $0.25 snake lobby they walked into next.
 * api/join.js now records `pwlob:<wallet>` = the room the deposit bought, and this is the reader
 * that makes that recording matter.
 *
 * NOTHING HERE IS RETYPED. The loop is sliced out of the real api/settle.js bytes and compiled with
 * stubbed kvGet/console/betAlert. Section 5 mutates a copy of that same source and asserts the leak
 * comes back, so a green run cannot mean "the test tests itself".
 */
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'api', 'settle.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + ' — got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
};

// ── Lift the real stake-read loop ────────────────────────────────────────────────────────────
function liftLoop(source) {
  const start = source.indexOf("      const askLobby = String(body.lobby || '');");
  if (start < 0) throw new Error('stake-read loop not found — has the fix been removed from settle.js?');
  const endMark = '\n      clearTimeout(guard); done = true;';
  const end = source.indexOf(endMark, start);
  if (end < 0) throw new Error('end of stake-read loop not found');
  return source.slice(start, end);
}

// Run the real loop against a KV of our choosing. Returns { stakes, warns, alerts }.
function run(source, { kv, addrs, lobby }) {
  const warns = [], alerts = [];
  const kvGet = async k => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null);
  const body = { lobby };
  const fn = new Function(
    'kvGet', 'console', 'betAlert', 'addrs', 'body',
    'return (async () => {\n' + liftLoop(source) + '\n  return stakes;\n})();',
  );
  return fn(kvGet, { warn: m => warns.push(String(m)) }, m => alerts.push(String(m)), addrs, body)
    .then(stakes => ({ stakes, warns, alerts }));
}

const W  = '7xKXtg2CW3f1oPqDbMvE9nRj4sHuYaLpQzT8dVcB6mNe';   // 44 chars, a real-shaped address
const W2 = '9aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AbCdEfG';
const PAC_$1    = 6_666_666;
const SNAKE_25c = 1_666_666;

async function main() {
  // ── 1. THE REPORTED BUG: a $1 Pac-Man deposit asked for by the 25c snake room ───────────────
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(PAC_$1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 0, 'a $1 Pac-Man deposit reads as 0 for the 25c snake room');
    eq(r.warns.some(w => w.indexOf('CROSS-LOBBY refused') >= 0), true, 'the refusal is logged');
    eq(r.alerts.length, 1, 'and raises an operator alert — this means money is sitting unconsumed');
    eq(r.alerts[0].indexOf('paid-lobby-1') >= 0, true, 'the alert names the room actually paid for');
  }

  // ── 2. HONEST PLAYER: same room, paid correctly ────────────────────────────────────────────
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c), ['pwlob:' + W]: 'ss-paid-lobby-0.25' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], SNAKE_25c, 'the deposit that bought THIS room is handed over in full');
    eq(r.warns.length, 0, 'nothing is logged for a normal read');
  }

  // ── 3. LEGACY ENTRIES ARE NOT STRANDED ─────────────────────────────────────────────────────
  /* Entries written before join.js recorded the room have no `pwlob:`. They drain within the 4h
   * `pw:` TTL. Refusing them would lock out players who paid correctly minutes before the deploy,
   * so a MISSING binding is permitted — only a DISAGREEING one is refused. */
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c) },            // no pwlob: at all
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], SNAKE_25c, 'a legacy entry with no room binding still reads through');
  }

  // ── 4. AN UNPATCHED GAME NODE IS UNAFFECTED ────────────────────────────────────────────────
  // A node that does not send `lobby` must get exactly the old answer, or deploying settle first
  // would break every live room.
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(PAC_$1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], PAC_$1, 'no lobby asked for = the old behaviour, unchanged');
  }

  // ── 5. MIXED BATCH — one refused, one paid ─────────────────────────────────────────────────
  {
    const r = await run(SRC, {
      kv: {
        ['pw:' + W]:  String(PAC_$1),    ['pwlob:' + W]:  'paid-lobby-1',
        ['pw:' + W2]: String(SNAKE_25c), ['pwlob:' + W2]: 'ss-paid-lobby-0.25',
      },
      addrs: [W, W2], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 0, 'the cross-room player gets nothing');
    eq(r.stakes[W2], SNAKE_25c, 'the player in the right room is unaffected by them');
  }

  // ── 6. NO DEPOSIT AT ALL ───────────────────────────────────────────────────────────────────
  {
    const r = await run(SRC, { kv: {}, addrs: [W], lobby: 'ss-paid-lobby-0.25' });
    eq(r.stakes[W], 0, 'no entry reads as 0');
    eq(r.warns.length, 0, 'and is not alerted on — this is just an unpaid or free player');
  }

  // ── 7. MUTATION PROOF ──────────────────────────────────────────────────────────────────────
  {
    const GUARD = "if (own && own !== askLobby) {";
    eq(SRC.indexOf(GUARD) >= 0, true, 'the room guard is present in the real settle.js');

    const mutated = SRC.replace(GUARD, 'if (false) {');
    const r = await run(mutated, {
      kv: { ['pw:' + W]: String(PAC_$1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], PAC_$1,
       'MUTANT: without the guard the $1 Pac-Man deposit is handed to the 25c room (the live bug)');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
