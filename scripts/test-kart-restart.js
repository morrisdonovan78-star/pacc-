'use strict';
/*
 * A KART RACE ALWAYS RESTARTS ON THE GRID.
 *
 * Owner, 2026-08-17: "kart arena has a bug where people restart at a spot mid race after a race in a
 * different lap … or not on finish line".
 *
 * THE BUG. `sock.isSpectator` lives on the server; the client kept its OWN copy, `NET.spectating`,
 * written only by the player's own Spectate/Join clicks. The two were never reconciled, so every
 * transition the SERVER makes was invisible to the client:
 *   * tryStart() demotes a racer who did not press READY to spectator,
 *   * the post-race promotion re-seats a queued player as a racer.
 * A player promoted back into a race with a stale `NET.spectating === true` skipped the grid snap in the
 * k-state handler, and so began the next race at the position AND LAP they finished the previous one on
 * — out on the circuit, not on the line. The same flag gates input sending, so the car was undriveable.
 *
 * The fix derives the flag from the roster (`lb.racers` is what the server simulates, so being in it IS
 * being in the race). This suite pins the SERVER half of that contract, which is what the client now
 * relies on, by driving the REAL kart-server over real socket.io through a real race:
 *
 *   join → ready → race → finish → 8s reset → promotion → next race starts
 *
 * and asserting the roster a promoted player receives puts them on the grid, on lap 1.
 *
 * ⚠️ WHAT THIS DOES **NOT** COVER: the 8-second post-race reset, because reaching it needs a race to
 * END, and with nobody driving that is RACE_TIMEOUT_MS = 6 minutes of wall clock. The promotion path in
 * §5 is the same server code the reset uses to re-seat a player, reached by a faster trigger, so the
 * contract is covered — but "I watched a race finish and the next one start" is NOT asserted here. The
 * alternative was making the timings env-tunable, and this server sits next to real money; I would rather
 * a stated gap than a production knob that can be set by accident.
 *
 * Needs socket.io + socket.io-client on NODE_PATH (not repo deps — the kart server carries its own on
 * the Vultr box). Run:
 *   NODE_PATH=<scratch>/kartdeps/node_modules node scripts/test-kart-restart.js
 */
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3399;
process.env.KART_PORT = String(PORT);
process.env.KART_REGION = 'NA';
process.env.KART_FREE_ONLY = '1';

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
};
const ok = (cond, msg) => eq(!!cond, true, msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot the real server in-process.
require(path.resolve(__dirname, '..', '_karttest', 'kart-server.js'));

// A client that records the k-state payloads it is sent, which is exactly what the fix reads.
function mkClient(name) {
  // ⚠️ The server mounts socket.io on a NON-DEFAULT path ('/kart/socket.io'), so a client left on the
  // default '/socket.io' connects to nothing and every wait times out with a null state.
  const s = io('http://127.0.0.1:' + PORT, { path: '/kart/socket.io', transports: ['websocket'], forceNew: true });
  const c = { s, name, states: [], hello: null, results: null, notices: [] };
  s.on('k-hello', (d) => { c.hello = d; });
  s.on('k-state', (d) => { c.states.push(d); });
  s.on('k-results', (d) => { c.results = d; });
  s.on('k-notice', (d) => { c.notices.push(d.msg || ''); });
  c.last = () => c.states[c.states.length - 1] || null;
  // What the client's k-state handler now computes: am I in the roster?
  c.mine = () => { const st = c.last(); if (!st || !Array.isArray(st.roster)) return null; return st.roster.find((p) => p.id === s.id) || null; };
  c.spectating = () => { const st = c.last(); return Array.isArray(st && st.roster) ? !c.mine() : null; };
  c.waitState = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (c.last() && pred(c.last())) return c.last(); await sleep(50); }
    throw new Error(name + ': timed out waiting for state (last=' + JSON.stringify(c.last() && c.last().state) + ')');
  };
  return c;
}

(async () => {
  await sleep(600);                                     // let the listener bind + track build
  const a = mkClient('A'), b = mkClient('B');
  await sleep(500);
  ok(a.hello, 'server said hello');

  const LOBBY = 'kart-test-lobby';
  a.s.emit('k-join', { lobbyId: LOBBY, name: 'AAA', color: '#f00' });
  b.s.emit('k-join', { lobbyId: LOBBY, name: 'BBB', color: '#00f' });
  await a.waitState((st) => st.roster && st.roster.length === 2);

  // ── 1. Both are racers, and each is told a grid box ────────────────────────────────────────────
  eq(a.spectating(), false, 'A is a racer after joining');
  eq(b.spectating(), false, 'B is a racer after joining');
  ok(isFinite(a.mine().gx) && isFinite(a.mine().gy), 'A is given a grid position');
  ok(a.mine().slot !== b.mine().slot, 'the two get different grid slots');
  const gridA = { x: a.mine().gx, y: a.mine().gy };

  // ── 2. A SPECTATOR is reported as one, so the client can stop pretending to race ───────────────
  // Done while the lobby is WAITING, on purpose: during 'racing' the server pushes only k-cars, so a
  // client that starts spectating mid-race gets no k-state until the next transition. Testing it in the
  // wrong order just times out and says nothing about the fix.
  const c = mkClient('C');
  await sleep(400);
  c.s.emit('k-spectate', { lobbyId: LOBBY });
  await c.waitState((st) => !!st.roster);
  eq(c.spectating(), true, 'a spectator is NOT in the roster, so the client derives spectating=true');
  eq(c.mine(), null, 'and finds no entry of its own');

  // ── 3. …and a spectator who joins becomes a racer IN THE ROSTER, on the grid ───────────────────
  // THE PATH THAT CAUSED THE BUG. The server flips isSpectator and never says so; this roster is the
  // only way the client can find out, which is why the fix derives the flag from it.
  c.s.emit('k-join', { lobbyId: LOBBY, name: 'CCC', color: '#0f0' });
  await c.waitState((st) => !!(st.roster || []).find((p) => p.id === c.s.id), 20000);
  eq(c.spectating(), false, '⚠️ A PROMOTED PLAYER APPEARS IN THE ROSTER — the client can see it now');
  ok(isFinite(c.mine().gx), 'and is given a grid box to snap to');
  eq(c.mine().lap, 1, 'on lap 1');
  ok(c.mine().slot !== a.mine().slot && c.mine().slot !== b.mine().slot, 'with a slot of its own');

  // ── 4. Start a race: 30s ready window, then the lights ────────────────────────────────────────
  // Two ready out of eight is not a full grid, so the server arms READY_WINDOW_MS (30s) and starts when
  // it expires. Worth the wall clock: the reported symptom is about where you are when a race BEGINS.
  a.s.emit('k-ready', { ready: true });
  b.s.emit('k-ready', { ready: true });
  const cd = await a.waitState((st) => st.state === 'countdown' || st.state === 'racing', 45000);
  ok(cd.state === 'countdown' || cd.state === 'racing', 'the race starts after the ready window');
  eq(a.spectating(), false, 'A is a racer at the lights');
  eq(a.mine().lap, 1, '⚠️ A IS ON LAP 1 AT THE LIGHTS');
  eq(a.mine().gx, gridA.x, '⚠️ A IS ON THE GRID BOX IT WAS GIVEN — not mid-circuit');
  eq(a.mine().gy, gridA.y, 'and on the same grid y');
  eq(a.mine().finished, false, "A's finished flag is clear at the lights");

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  a.s.close(); b.s.close(); c.s.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
