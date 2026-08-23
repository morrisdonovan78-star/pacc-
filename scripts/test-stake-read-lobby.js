'use strict';
/*
 * Offline tests for the settle-side defence against the CROSS-ROOM STAKE LEAK reported live on
 * 23 Aug 2026: a player joined Pac-Man for $1, left without dying or cashing out, then joined a
 * $0.25 snake lobby — and played it as a $1 snake. On death he shed $1 of gold and the wallet that
 * ate it cashed out $1 of other players' escrow.
 *
 * `pw:<wallet>` is keyed by wallet ALONE — one live wager entry per wallet across all five games —
 * so "what did this player deposit?" used to answer "whatever they last deposited ANYWHERE".
 * api/join.js now records `pwlob:<wallet>` = the room the deposit bought, and this is the reader
 * that makes that recording matter. Two guards, for two different states of the game node:
 *
 *   1. the node names the room it is asking for  -> exact match, anything else reads as 0.
 *   2. the node is UNPATCHED and names nothing   -> a Pac-Man deposit still reads as 0, because the
 *      snake ledger is the only consumer of this endpoint and a Pac-Man deposit can only poison it.
 *
 * NOTHING HERE IS RETYPED. The loop is sliced out of the real api/settle.js bytes and compiled with
 * stubbed kvGet/console/betAlert. Both guards end in a MUTATION PROOF that strips them and asserts
 * the leak comes back, so a green run cannot mean "the test tests itself".
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
  const end = source.indexOf('\n      clearTimeout(guard); done = true;', start);
  if (end < 0) throw new Error('end of stake-read loop not found');
  return source.slice(start, end);
}

// Run the real loop against a KV of our choosing. Returns { stakes, warns, alerts }.
function run(source, { kv, addrs, lobby }) {
  const warns = [], alerts = [];
  const kvGet = async k => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null);
  const fn = new Function(
    'kvGet', 'console', 'betAlert', 'addrs', 'body',
    'return (async () => {\n' + liftLoop(source) + '\n  return stakes;\n})();',
  );
  return fn(kvGet, { warn: m => warns.push(String(m)) }, m => alerts.push(String(m)), addrs, { lobby })
    .then(stakes => ({ stakes, warns, alerts }));
}

const W  = '7xKXtg2CW3f1oPqDbMvE9nRj4sHuYaLpQzT8dVcB6mNe';   // 44 chars, a real-shaped address
const W2 = '9aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AbCdEfG';
const PAC_1  = 6_666_666;   // $1 at ~$150/SOL
const SNAKE_25c = 1_666_666;   // $0.25 at the same price

const GUARD_EXACT = "if (lam > 0 && askLobby && own && own !== askLobby) {";
const GUARD_PACMAN = "if (lam > 0 && own && own.indexOf('ss-') !== 0) {";

async function main() {
  // ── 1. THE REPORTED BUG, PATCHED NODE: the 25c room asks, the deposit bought Pac-Man ────────
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(PAC_1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 0, 'a $1 Pac-Man deposit reads as 0 for the 25c snake room');
    eq(r.warns.some(w => w.indexOf('CROSS-LOBBY refused') >= 0), true, 'the refusal is logged');
    eq(r.alerts.length, 1, 'and raises an operator alert — money is sitting unconsumed');
    eq(r.alerts[0].indexOf('paid-lobby-1') >= 0, true, 'the alert names the room actually paid for');
  }

  // ── 2. TWO SNAKE ROOMS — the exact-match guard, not just a game check ───────────────────────
  /* The $5 room's deposit must not answer for the 25c room either. This is the case the Pac-Man
   * guard alone would miss, and it is why the exact match has to exist as well. */
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(6_666_666), ['pwlob:' + W]: 'ss-paid-lobby-5' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 0, 'a $5 snake deposit reads as 0 for the 25c snake room');
  }

  // ── 3. HONEST PLAYER: same room, paid correctly ────────────────────────────────────────────
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c), ['pwlob:' + W]: 'ss-paid-lobby-0.25' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], SNAKE_25c, 'the deposit that bought THIS room is handed over in full');
    eq(r.warns.length, 0, 'nothing is logged for a normal read');
  }

  // ── 4. THE UNPATCHABLE-NODE CASE — a Pac-Man deposit is withheld anyway ─────────────────────
  /* This is the reported bug as it reaches a node that has NOT taken the fix: the node sends no
   * `lobby`, so the exact-match guard cannot fire. The deposit is still knowably a Pac-Man one, and
   * the snake ledger is the only thing that ever reads this answer, so 0 is the only honest reply.
   * It protects an unpatched node because the node stores only positive answers
   * (`if (lam > 0) { _stakeLam.set(...) }`) — a 0 leaves its ledger untouched rather than poisoned. */
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(PAC_1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], 0, 'a Pac-Man deposit is withheld even when the node names no room');
    eq(r.warns.some(w => w.indexOf('Pac-Man deposit') >= 0), true, 'and says so in the log');
  }

  // ── 4b. A SNAKE DEPOSIT FROM AN UNPATCHED NODE IS STILL ANSWERED ────────────────────────────
  // Deploying settle ahead of the nodes must not break the rooms that are working.
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c), ['pwlob:' + W]: 'ss-paid-lobby-0.25' },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], SNAKE_25c, 'a snake deposit still reads through for an unpatched node');
  }

  // ── 4c. THE OG SNAKE ROOMS COUNT AS SNAKE ───────────────────────────────────────────────────
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c), ['pwlob:' + W]: 'ss-og-paid-lobby-1' },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], SNAKE_25c, 'ss-og-paid-lobby-* is a snake room, not withheld');
  }

  // ── 5. LEGACY ENTRIES ARE NOT STRANDED ─────────────────────────────────────────────────────
  /* Entries written before join.js recorded the room have no `pwlob:`. They drain within the 4h
   * `pw:` TTL. Refusing them would lock out players who paid correctly minutes before the deploy,
   * so a MISSING binding is permitted — only a KNOWN-WRONG one is refused. */
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c) },            // no pwlob: at all
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], SNAKE_25c, 'a legacy entry with no room binding still reads through');
  }
  {
    const r = await run(SRC, {
      kv: { ['pw:' + W]: String(SNAKE_25c) },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], SNAKE_25c, 'legacy + unpatched node is left alone too');
  }

  // ── 6. MIXED BATCH — one refused, one paid ─────────────────────────────────────────────────
  {
    const r = await run(SRC, {
      kv: {
        ['pw:' + W]:  String(PAC_1),     ['pwlob:' + W]:  'paid-lobby-1',
        ['pw:' + W2]: String(SNAKE_25c), ['pwlob:' + W2]: 'ss-paid-lobby-0.25',
      },
      addrs: [W, W2], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 0, 'the cross-room player gets nothing');
    eq(r.stakes[W2], SNAKE_25c, 'the player in the right room is unaffected by them');
  }

  // ── 7. NO DEPOSIT AT ALL ───────────────────────────────────────────────────────────────────
  {
    const r = await run(SRC, { kv: {}, addrs: [W], lobby: 'ss-paid-lobby-0.25' });
    eq(r.stakes[W], 0, 'no entry reads as 0');
    eq(r.warns.length, 0, 'and is not alerted on — this is just an unpaid or free player');
  }

  // ── 8. MUTATION PROOF — the exact-match guard ──────────────────────────────────────────────
  {
    eq(SRC.indexOf(GUARD_EXACT) >= 0, true, 'the exact-match guard is present in the real settle.js');
    const r = await run(SRC.replace(GUARD_EXACT, 'if (false) {'), {
      kv: { ['pw:' + W]: String(6_666_666), ['pwlob:' + W]: 'ss-paid-lobby-5' },
      addrs: [W], lobby: 'ss-paid-lobby-0.25',
    });
    eq(r.stakes[W], 6_666_666,
       'MUTANT: without it the $5 snake deposit is handed to the 25c room');
  }

  // ── 9. MUTATION PROOF — the Pac-Man guard ──────────────────────────────────────────────────
  {
    eq(SRC.indexOf(GUARD_PACMAN) >= 0, true, 'the Pac-Man guard is present in the real settle.js');
    const r = await run(SRC.replace(GUARD_PACMAN, 'if (false) {'), {
      kv: { ['pw:' + W]: String(PAC_1), ['pwlob:' + W]: 'paid-lobby-1' },
      addrs: [W], lobby: undefined,
    });
    eq(r.stakes[W], PAC_1,
       'MUTANT: without it the $1 Pac-Man deposit reaches an unpatched node and poisons its ledger');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
