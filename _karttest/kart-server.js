/*
 * KART ARENA — multiplayer game server (NA Chicago + EU Frankfurt)
 * ---------------------------------------------------------------------------
 * Runs as its OWN pm2 process on :3002, deliberately NOT inside the pac-arena
 * process on :3001. Snake and PAC ARENA share that one because they are proven;
 * this is new code, so a crash here must not be able to touch the games that
 * take money. Nothing in this file may ever require the :3001 process.
 *
 * Socket path is /kart/socket.io so nginx can route it on the existing
 * us./eu.pac-arena.com certificates without a new subdomain or cert.
 *
 * SERVER-AUTHORITATIVE PHYSICS. Clients send INPUTS — throttle, brake, steer,
 * drift, boost — and this process runs the simulation and broadcasts the
 * result. Nothing a client says about where its car is, is believed.
 *
 * It did not start that way. The first build was relay-first like snake: each
 * client simulated its own kart and reported a position, and the server owned
 * only the lobby, clock, lap validation and finish order. That is fine while
 * nothing is at stake, because a cheat wins a free race and no money moves. It
 * is NOT enough for a paid lobby, and lap validation does not close the hole:
 * sector-order checks stop teleporting to the line and cutting the infield, but
 * a client edited to drive faster still visits every sector in order, so it
 * would win every paid race and look perfectly legitimate doing it.
 *
 * The simulation in physics.js is GENERATED from the client by
 * build_physics_module.py, for the same reason track.js is: a hand-copied
 * constant that differs by one percent produces no error anywhere — just cars
 * twitching under correction, and players paid on results their own screen
 * disagreed with. Verified bit-identical, not assumed: 900 scripted input steps
 * run in the browser and in node agree on x/y/angle/speed to six decimals.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const PHYS = require('./physics.js');   // GENERATED from the client — see build_physics_module.py

const PORT = process.env.KART_PORT || 3002;
const REGION = process.env.KART_REGION || 'NA';

// ═══════════════════════════════════════════════════════════════════════════
// TRACK — NOT reimplemented here. `track.js` is GENERATED from kart.html by
// build_track_module.py, so the client is the single source of truth for the
// circuit and the server is a derivative of it.
//
// This used to be a hand-copy, and the hand-copy was wrong: PLAYERS, LANE_W, the
// RB formula and the amplitude normalisation all differed, putting the server's
// centre at 2048 against the client's 1792 and generating a different shape
// entirely. Both sides still reported the same track ID, because the ID comes
// from the DATE and not the geometry — so nothing looked broken until a car was
// spawned onto a grid a long way off the circuit. Geometry needed by two
// machines does not get maintained in two places.
// ═══════════════════════════════════════════════════════════════════════════
const T = require('./track.js');
const { ROAD_W, TEX, CX, CY, RB, SPD_SC, radiusAt, pointAt, headingAt, buildCircuit, dailySeed } = T;

let TRACK_SEED = dailySeed();
let TRK = T.TRK;
let TRACK_ID = TRACK_SEED.toString(36).toUpperCase().slice(-5);

// Roll the circuit over at midnight UTC without a restart.
function refreshTrack() {
  const s = dailySeed();
  if (s === TRACK_SEED) return false;
  TRACK_SEED = s; TRK = buildCircuit(s); T.setTRK(TRK);
  TRACK_ID = s.toString(36).toUpperCase().slice(-5);
  return true;
}

/*
 * SURFACE is NOT reimplemented here either. It used to be: this file carried its own radiusSlope /
 * offsetFromLine / surfaceAt, hand-copied from the client, and they had already drifted — the copy's
 * SURF had no BOOST member at all, so as far as the server was concerned the circuit's three boost
 * pads did not exist. Nothing errored; the server simply disagreed with the game about the track.
 * It comes from physics.js now, generated from the client, along with everything else the simulation
 * touches.
 */

// ═══════════════════════════════════════════════════════════════════════════
// LOBBIES
// ═══════════════════════════════════════════════════════════════════════════
const LAPS = 3;
const MAX_RACERS = 8;
const COUNTDOWN_MS = 4000;
const MIN_TO_START = 2;          // a race needs a rival; solo players wait
const START_GRACE_MS = 12000;    // ...but not forever, if someone is alone and ready
const READY_WINDOW_MS = 30000;   // 30s between races to ready up and pay, per the owner's rule
const RACE_TIMEOUT_MS = 6 * 60 * 1000;
const EMPTY_LOBBY_TTL = 60 * 1000;

/** @type {Map<string, Lobby>} */
const lobbies = new Map();
let nextLobbyNum = 1;

/*
 * STAKES. Any amount, including under a dollar — the tiers on the page are shortcuts, not the set of
 * legal values, so a lobby for $0.25 is as valid as one for $50. Stored in CENTS so a stake can never
 * pick up a floating-point tail on its way through JSON and settle for a fraction of a cent off.
 */
/*
 * The master switch for real money. OFF until an on-chain entry deposit is verified at the charge
 * point in k-ready. With it off, a paid lobby can be created and listed but refuses to take anyone's
 * ready — which is the safe failure: nobody pays, nobody races, and no pot can ever pay out money that
 * was never collected. Turning this on without wiring the deposit would do exactly that.
 */
// Real money is ON once the server can verify a ticket. GAME_SECRET must be in this process's env
// (pm2 --update-env) or ticket verification fails closed and paid races simply refuse to start, which
// is the correct failure: nobody pays and nobody races.
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const SETTLE_URL  = process.env.SETTLE_URL || 'https://snakepot.com/api/settle';
const ENTRY_FEES_ENABLED = !!GAME_SECRET;

/*
 * A ticket is proof, issued by the money backend, that this player has paid for this lobby. The kart
 * server has no wallet, no RPC and no escrow key — deliberately, since it also runs untrusted game
 * code — so it must never decide for itself that someone paid. It only checks a signature it cannot
 * forge. Shape: "lobbyId|address|cents|lamports|ts".
 */
/*
 * ONE TICKET, ONE RACE.
 *
 * A ticket is an HMAC over (lobby, address, cents, lamports, ts) and stays valid for 30 minutes.
 * lb.paid is cleared at the start of every race, so a client that kept its ticket simply re-presented
 * it on the next READY and raced again WITHOUT PAYING - one entry fee bought unlimited races for half
 * an hour. The pot was funded by whoever paid most recently and everyone else rode along free.
 *
 * A ticket is now retired the moment its race actually starts, and also when its entry is refunded
 * (the money went back, so the ticket must not buy anything). It is deliberately NOT retired at
 * k-ready: a reconnect before the lights arrives on a new socket id, finds no lb.paid entry for
 * itself, and has to be able to re-present the same ticket to reclaim the seat it already bought.
 */
const _spentTickets = new Map();   // ticket string -> retired-at ms
function retireTicket(t) { if (t) _spentTickets.set(String(t), Date.now()); }
function ticketSpent(t) { return t != null && _spentTickets.has(String(t)); }
setInterval(() => {                // tickets die after 30 min anyway; keep the ledger from growing
  const cut = Date.now() - 45 * 60 * 1000;
  for (const [k, v] of _spentTickets) if (v < cut) _spentTickets.delete(k);
}, 5 * 60 * 1000).unref?.();

function verifyTicket(lobbyId, ticket, tsig) {
  if (!GAME_SECRET || !ticket || !tsig) return null;
  const expect = crypto.createHmac('sha256', GAME_SECRET).update('kart-entry:' + ticket).digest('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(tsig))); } catch (_) { return null; }
  if (!ok) return null;
  const [lid, address, cents, lamports, ts] = String(ticket).split('|');
  if (lid !== lobbyId) return null;                       // a ticket for one room cannot enter another
  if (Date.now() - Number(ts) > 30 * 60 * 1000) return null;   // stale
  return { address, cents: Number(cents), lamports: Number(lamports) };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE MONEY QUEUE — every payout and every refund is written down BEFORE it is attempted.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every money call out of this process used to be one bare `fetch` inside a `try/catch` that did
 * nothing but `console.error`. One POST, one attempt, no retry. A network blip, a Vercel cold start
 * or a single 503 and the payout or the refund was simply GONE — no record on this side, nothing to
 * revisit, and the player just never got paid. Worse, `refundOne`/`refundUnstarted` deleted the entry
 * from `lb.paid` BEFORE the call and never looked at the response, so a failed refund destroyed the
 * only evidence that it was owed.
 *
 * This is the same hole that was closed in blackjack, closed the same way:
 *   1. the obligation is persisted BEFORE anything is attempted,
 *   2. a timer drains it with backoff, for as long as it takes,
 *   3. the record is only forgotten when the far end CONFIRMS (200 with no error body — which
 *      includes `{already:true}`, the idempotent "this was already paid" answer),
 *   4. after that it is dead-lettered LOUDLY rather than dropped silently.
 *
 * On disk, not in KV: this process deliberately has no KV client, no wallet and no RPC (it also runs
 * untrusted physics), and the obligations are region-local anyway — an NA payout is never EU's to
 * settle. One file per region, written whole via tmp+rename so a crash mid-write cannot leave a
 * half-parsed queue.
 *
 * Retrying is SAFE because the far end is idempotent: `kartpaid:<raceId>` / `kartrefund:<refundId>`
 * are NX flags, so a repeat is a no-op that answers `{already:true}`. And since 2026-07-31 those
 * flags are CLEARED when not one lamport actually moved, which is what makes a retry meaningful
 * rather than a guaranteed `{already:true}` over a race nobody was ever paid for.
 */
const QUEUE_FILE = process.env.KART_QUEUE_FILE || path.join(__dirname, 'kart-queue-' + REGION + '.json');
const QUEUE_DEAD_FILE = QUEUE_FILE.replace(/\.json$/, '-dead.json');
const JOB_MAX_TRIES = 500;          // ~a day of retries, not ~2 minutes. A backend outage must not
                                    // burn through the retries — that is how blackjack lost 3 pots.
const JOB_BACKOFF_MAX_MS = 120000;
const DRAIN_MS = 5000;

/** @type {Map<string, object>} jobId -> job. One job is one signed POST that must eventually land. */
const _jobs = new Map();
/**
 * Races that are RUNNING RIGHT NOW with real money in the pot. The pot only ever existed in this
 * process's memory (`lb.entriesThisRace`), so a pm2 restart mid-race took it with it: no payout, no
 * refund, the entries simply stranded in escrow. Recorded here at lights-out and swapped for the
 * settle job at the flag, both inside ONE file write — so a crash can leave the refund owed, but can
 * never leave both a refund and a payout owed for the same race.
 * @type {Map<string, object>} raceId -> { raceId, entries, potLamports, at }
 */
const _inflight = new Map();

function saveQueue() {
  try {
    const data = JSON.stringify({ v: 1, region: REGION, jobs: [..._jobs.values()], inflight: [..._inflight.values()] });
    fs.writeFileSync(QUEUE_FILE + '.tmp', data);
    fs.renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE);   // atomic swap — a torn file is never readable
  } catch (e) {
    // Nothing else can be done here, but it must be impossible to miss: an unwritable queue means
    // money is being handled with no safety net at all.
    console.error('[kart] ⚠️ QUEUE SAVE FAILED — payouts are NOT durable right now:', e && e.message);
  }
}

function loadQueue() {
  let raw = null;
  try { raw = fs.readFileSync(QUEUE_FILE, 'utf8'); } catch (_) { return; }
  try {
    const d = JSON.parse(raw) || {};
    for (const j of d.jobs || []) if (j && j.id) { j.dueAt = 0; _jobs.set(j.id, j); }   // everything is due at boot
    for (const r of d.inflight || []) if (r && r.raceId) _inflight.set(r.raceId, r);
    if (_jobs.size || _inflight.size) console.log('[kart] queue restored: ' + _jobs.size + ' unpaid job(s), ' + _inflight.size + ' race(s) in flight');
  } catch (e) { console.error('[kart] ⚠️ QUEUE FILE UNREADABLE', e && e.message); }
}

// A dead-lettered obligation is real money that was never moved. It has to be shoutable, not just a
// line in a log nobody reads. KART_ALERT_URL is a Discord webhook when one is configured; the
// console.error is unconditional so the alert can never be the only copy.
function moneyAlert(msg) {
  console.error('[kart] ⚠️ MONEY ALERT: ' + msg);
  const url = (process.env.KART_ALERT_URL || '').trim();
  if (!url) return;
  try {
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '⚠️ KART ' + REGION + ': ' + msg }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch (_) {}
}

/*
 * Enqueue one signed POST. `proofBase` is everything the far end HMACs except the timestamp, because
 * verifyGameProof rejects a proof older than five minutes — a job that waits an hour in the queue has
 * to be re-signed at every attempt, not replay an expired signature it was born with.
 *
 * The id de-duplicates: enqueueing the same obligation twice is one job, not two payments.
 * NOTE: the caller must NOT call saveQueue() for it — it persists together with whatever else the
 * caller is changing in the same synchronous block, which is what makes the swaps atomic.
 */
function enqueueJob(kind, id, proofBase, body, extra) {
  if (_jobs.has(id)) return _jobs.get(id);
  const job = Object.assign(
    { id, kind, proofBase, body, tries: 0, dueAt: 0, createdAt: Date.now(), lastErr: null },
    extra || {});
  _jobs.set(id, job);
  return job;
}

/*
 * Is this answer a NO that will still be a no on the five hundredth attempt?
 *
 * 400 always is — a malformed request does not become well-formed by waiting. Everything else is
 * transient until proven otherwise: 403 (a GAME_SECRET mismatch is fixable and the queue survives the
 * fix), 429, 5xx, a timeout, and the deliberate 503 `retry:true` that says "nothing moved, come back".
 *
 * The wager endpoints add two of their own. `404 wager not found` is genuinely final. `held:true` is
 * the backend saying a payout failed in a way it CANNOT safely repeat — the owner settles that one by
 * hand — so hammering it for a day would be both useless and wrong. Neither of those meanings exists
 * on kart-settle/kart-refund, where a 404 would mean the API route itself is missing; retrying that
 * is exactly right, so this stays per-kind rather than global.
 */
function jobIsTerminal(job, res) {
  if (!res) return false;
  if (res.status === 400) return true;
  const isWager = job.kind === 'wagerset' || job.kind === 'wagerret';
  if (isWager && (res.status === 404 || (res.body && res.body.held))) return true;
  return false;
}

async function attemptJob(job) {
  const ts = Date.now();
  const proof = crypto.createHmac('sha256', GAME_SECRET).update(job.proofBase + ':' + ts).digest('hex');
  const r = await fetch(SETTLE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify(job.body),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  // CONFIRMED means the far end said so. `{already:true}` counts — it is the idempotent flag telling
  // us this exact obligation has already been honoured. An HTTP 200 carrying an `error` body does NOT.
  return { status: r.status, ok: !!(r.ok && j && !j.error), body: j };
}

function deadLetter(job, why) {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(QUEUE_DEAD_FILE, 'utf8')) || []; } catch (_) { arr = []; }
    arr.push(Object.assign({}, job, { deadAt: Date.now(), why }));
    fs.writeFileSync(QUEUE_DEAD_FILE, JSON.stringify(arr));
  } catch (e) { console.error('[kart] dead-letter write failed', e && e.message); }
  _jobs.delete(job.id);
  moneyAlert(job.kind + ' DEAD-LETTERED ' + job.id + ' after ' + job.tries + ' tries (' + why + ') — last: ' +
    (job.lastErr || '?') + '. Settle this by hand; the payload is in ' + QUEUE_DEAD_FILE);
}

let _draining = false;
async function drainQueue(limit = 6) {
  if (_draining || !_jobs.size || !GAME_SECRET) return;
  _draining = true;
  try {
    const now = Date.now();
    const due = [..._jobs.values()].filter((j) => (j.dueAt || 0) <= now).slice(0, limit);
    for (const job of due) {
      if (!_jobs.has(job.id)) continue;                    // settled by a concurrent path
      let res = null;
      try { res = job.kind === 'wagersweep' ? await attemptWagerSweep(job) : await attemptJob(job); }
      catch (e) { job.lastErr = 'network: ' + ((e && e.message) || 'failed'); }
      if (res && res.ok) {
        _jobs.delete(job.id);
        console.log('[kart] ' + job.kind + ' CONFIRMED ' + job.id + ' ' + res.status + ' ' +
          JSON.stringify(res.body).slice(0, 200));
        saveQueue();
        continue;
      }
      job.tries = (job.tries || 0) + 1;
      if (res) job.lastErr = res.status + ' ' + JSON.stringify(res.body).slice(0, 160);
      if (jobIsTerminal(job, res)) { deadLetter(job, 'refused permanently'); saveQueue(); continue; }
      if (job.tries >= JOB_MAX_TRIES) { deadLetter(job, 'retries exhausted'); saveQueue(); continue; }
      job.dueAt = now + Math.min(JOB_BACKOFF_MAX_MS, 2000 * job.tries);
      console.error('[kart] ' + job.kind + ' RETRY ' + job.id + ' try=' + job.tries + ' in ' +
        Math.round((job.dueAt - now) / 1000) + 's :: ' + job.lastErr);
      saveQueue();
    }
  } finally { _draining = false; }
}

/*
 * Give a whole race's pot back to the people who funded it. For a race that CANNOT resolve — the
 * process stopped while it was running (every socket died with it and the finish order lived only in
 * memory), or it ended with a pot and nobody payable. Nobody finished, so the entries go back, which
 * is exactly what endRace already does for a race nobody completes. 100%, no rake: there was no
 * contest to take a cut of.
 *
 * `unresolved:` prefixes the refundId so it can never collide with a per-entry refund from the same
 * room, and so these stand out in the log and in escrow.
 */
function refundInFlightRace(raceId, why) {
  const rec = _inflight.get(raceId);
  if (!rec) return false;
  const entries = (rec.entries || []).filter((e) => e && e.address && e.lamports > 0).slice(0, 8);
  _inflight.delete(raceId);
  if (!entries.length) { saveQueue(); return false; }
  const refundId = ('unresolved:' + raceId).slice(0, 90);
  enqueueJob('refund', 'refund:' + refundId, 'kart-refund:' + refundId,
    { action: 'kart-refund', refundId, entries });
  saveQueue();
  moneyAlert('race ' + raceId + ' ' + why + ' — refunding ' + entries.length +
    ' entr' + (entries.length === 1 ? 'y' : 'ies') + ' (' + rec.potLamports + ' lamports)');
  drainQueue();
  return true;
}

function recoverInFlight() {
  for (const raceId of [..._inflight.keys()]) refundInFlightRace(raceId, 'was INTERRUPTED BY A RESTART');
}

/*
 * Hand back every unspent entry in a lobby, in full. Called whenever paid entries exist for a race
 * that is NOT going to run: the last person leaves, or the room is reaped. Money taken for a race
 * that never happened has to go back — otherwise the first player into an empty paid room is simply
 * out of pocket for being early, which is the fastest way to make people stop opening rooms.
 */
/*
 * Refund ONE player's entry, in full, for a race that has not started. Un-readying or leaving before
 * the lights means you are not in this race — so you are not paying for it. Without this the only
 * refund was "the whole room emptied", which left anyone who simply changed their mind paying for a
 * race they then watched somebody else run.
 */
/*
 * ⚠️ THE ORDER OF THE THREE LINES IN HERE IS THE WHOLE POINT.
 *
 * The obligation is QUEUED FIRST, then the entry is removed. Both are plain synchronous statements
 * with no `await` between them, so no other handler can interleave: the double-refund guard (the
 * entry is gone, so a second trigger finds nothing) still holds exactly as before, but the money is
 * written down before the evidence of it is thrown away. It used to be the other way round — delete,
 * then one unchecked fetch — so a refund that failed took its own record with it.
 *
 * The refundId is derived from WHEN THE ENTRY WAS PAID, not from `Date.now()` at refund time. That
 * makes it stable: refunding the same entry twice produces the same id, and the far end's
 * `kartrefund:<refundId>` NX flag turns the second one into a no-op. A timestamp taken at refund
 * time would mint a fresh id every call and every one of them would pay out.
 */
function refundOne(lb, sid, why) {
  if (!GAME_SECRET || !lb || !lb.paid) return;
  const pd = lb.paid.get(sid);
  if (!pd || !pd.address || !(pd.lamports > 0)) return;
  const refundId = (lb.id + ':' + sid + ':' + (pd.at || 0)).slice(0, 90);
  enqueueJob('refund', 'refund:' + refundId, 'kart-refund:' + refundId, {
    action: 'kart-refund', refundId,
    entries: [{ address: pd.address, lamports: Math.floor(pd.lamports) }],
  });
  lb.paid.delete(sid);                          // now it cannot be refunded a second time
  retireTicket(pd.ticket);                      // and the ticket that bought it cannot buy another
  saveQueue();
  console.log('[kart] refund QUEUED', refundId, why);
  drainQueue();                                 // try immediately; the queue is the net, not the path
}

// Every unspent entry in the room, one durable job each. Deliberately per-entry rather than one
// batched call: each keeps its own stable id, so one player's refund failing cannot hold up or
// duplicate anybody else's.
function refundUnstarted(lb, why) {
  if (!GAME_SECRET || !lb || !lb.paid || !lb.paid.size) return;
  for (const sid of [...lb.paid.keys()]) refundOne(lb, sid, why);
}

/*
 * ── BETTING: who is bettable, and the proof that says so ────────────────────────────────────────
 *
 * Spectators bet on RACERS, and a bet has to be settled by someone who cannot lie about the result.
 * The kart server already computes finish order from sector crossings it validated itself, so it is
 * the right authority — but api/settle must be able to tell a real roster entry from an invented one,
 * or anybody could open a market on a driver who is not in the race.
 *
 * Hence the same signed-roster scheme snake uses, with the SAME canon, so settle.js verifies it with
 * the code it already has: 'snake:<region>:<lobby>:<pid>:<ipHash>:<exp>'. The 'snake:' prefix is a
 * namespace, not a claim about the game — reusing it means one verifier, not two that can drift.
 *
 * The name is deliberately NOT signed. It is cosmetic and mutable, and binding it means a player
 * renaming mid-session invalidates every signature they hold — which in snake silently broke duels
 * that could then never settle.
 */
const WG_ROSTER_TTL = 5 * 60 * 1000;
function kartRosterEntry(lb, r, exp) {
  return {
    pid: r.sid, name: r.name || 'RACER', color: r.color || '#39d353',
    lap: r.lap, place: r.place || 0, exp,
    sig: crypto.createHmac('sha256', GAME_SECRET)
      .update('snake:' + REGION + ':' + lb.id + ':' + r.sid + '::' + exp).digest('hex'),
  };
}
function broadcastKartRoster(lb) {
  if (!GAME_SECRET || !lb) return;
  const exp = Date.now() + WG_ROSTER_TTL;
  const racers = [...lb.racers.values()].filter((r) => !r.finished).map((r) => kartRosterEntry(lb, r, exp));
  try {
    io.to(lb.id).emit('k-wager-roster', {
      region: REGION, lobby: lb.id, racers,
      // A market only makes sense on a race that is actually going to run.
      bettable: lb.state === 'countdown' || lb.state === 'racing',
    });
  } catch (_) {}
}

/*
 * Settle every 'beat' market on this race from the finish order.
 *
 * "Ahead of" is decided in one place, here, so a bet cannot be resolved by a different rule than the
 * one the race was scored by:
 *   1. A racer who FINISHED beats one who did not — completing the race always wins.
 *   2. Both finished  -> the earlier finishing position is ahead.
 *   3. Neither finished -> whoever covered more of the race (lap, then sector) is ahead.
 *   4. Genuinely level -> VOID. Both stakes are returned rather than a winner being invented; a bet
 *      nobody can be said to have won is not a bet the house should be picking a side of.
 */
/*
 * The result is SNAPSHOTTED rather than read live, because settling a market is now retryable and the
 * lobby is not. Eight seconds after a race ends the room resets — ready flags cleared, finished flags
 * cleared, the queue promoted — and `lb.finishOrder` plus every racer's lap/sector count are exactly
 * the state 'ahead of' is judged from. A retry an hour later has to reach the SAME verdict as the
 * first attempt, so it reads a frozen copy taken while the race was still fresh, not a lobby that has
 * since run two more races.
 */
function raceSnapshot(lb) {
  const prog = {};
  for (const [pid, r] of lb.racers) prog[pid] = (r.lap || 0) * 1000 + (r.sectors ? r.sectors.size : 0);
  return { lobby: lb.id, order: lb.finishOrder.map((f) => f.id), prog };
}

function kartAhead(snap, pidA, pidB) {
  const place = (pid) => {
    const i = snap.order.indexOf(pid);
    return i >= 0 ? i + 1 : 0;                       // 0 == did not finish
  };
  const pa = place(pidA), pb = place(pidB);
  if (pa && pb) return pa < pb ? 'A' : 'B';
  if (pa) return 'A';
  if (pb) return 'B';
  const prog = (pid) => (snap.prog[pid] != null ? snap.prog[pid] : -1);
  const ga = prog(pidA), gb = prog(pidB);
  if (ga === gb) return null;                        // dead level -> void, both stakes back
  return ga > gb ? 'A' : 'B';
}

/*
 * Reading the book was the single most fragile money call in this file: ONE unretried fetch, and a
 * `return` in its catch. If wager-list failed — a cold start, a blip, a 503 — not one market on the
 * race was settled, and because the lobby resets seconds later there was nothing left to judge them
 * from even if something had come back to look. Every spectator's matched stake stayed in escrow.
 *
 * It is a queued job now, with the verdict inputs frozen onto it, and the individual settlements it
 * discovers become queued jobs of their own — so a market can survive the sweep succeeding and its
 * own payout failing, which are genuinely different failures.
 */
function settleKartWagers(lb) {
  if (!GAME_SECRET || !lb) return;
  const id = 'wagersweep:' + lb.id + ':' + (lb.tStart || Date.now());
  enqueueJob('wagersweep', id, 'wager-list:' + REGION + ':' + lb.id,
    { action: 'wager-list', region: REGION, lobby: lb.id },
    { snap: raceSnapshot(lb) });
  saveQueue();
  drainQueue();
}

async function attemptWagerSweep(job) {
  const res = await attemptJob(job);
  if (!res.ok) return res;
  const book = [].concat(res.body.live || [], res.body.open || []);
  let queued = 0;
  for (const w of book) {
    if (!w || w.type !== 'beat') continue;
    // An OPEN (unmatched) wager has no opponent and is returned in full, not settled.
    if (w.status !== 'matched') continue;
    const side = kartAhead(job.snap, w.subject, w.subject2);
    if (side === null) {
      enqueueJob('wagerret', 'wagerret:' + w.id, 'wager-return:' + w.id,
        { action: 'wager-return', wagerId: w.id });
    } else {
      enqueueJob('wagerset', 'wagerset:' + w.id, 'wager-settle:' + w.id + ':' + side,
        { action: 'wager-settle', wagerId: w.id, winningSide: side });
    }
    queued++;
  }
  console.log('[kart] wager sweep ' + job.snap.lobby + ' -> ' + queued + ' market(s) queued');
  return res;
}

/*
 * Pay out a finished paid race. Winner takes the pot minus 10%; ties split. Idempotent by raceId at
 * the far end, so a retry after a network blip cannot pay twice.
 *
 * This does not pay anybody — it RECORDS that somebody must be paid, and hands the actual POST to the
 * queue. It used to be one unretried fetch, which meant a single 503 on the one attempt lost a real
 * pot with nothing left on this side to notice.
 *
 * The in-flight record for this race is dropped in the SAME file write that adds the job: from here
 * the debt is the payout, not a refund, and there is no instant in which both are owed.
 */
function settleRace(raceId, winners, potLamports) {
  if (!GAME_SECRET || !potLamports || !winners.length) return;
  enqueueJob('settle', 'settle:' + raceId, 'kart-settle:' + raceId + ':' + potLamports,
    { action: 'kart-settle', raceId, winners, potLamports });
  _inflight.delete(raceId);
  saveQueue();
  console.log('[kart] settle QUEUED', raceId, potLamports + ' lamports to ' + winners.length + ' winner(s)');
  drainQueue();
}

/*
 * The pot is real money that exists ONLY in this process's memory until the race ends. Write down who
 * funded it the moment the lights go out, so a restart mid-race is recoverable instead of silently
 * eating every entry (see recoverInFlight).
 */
function markRaceInFlight(lb) {
  if (!GAME_SECRET || !lb || !(lb.potLamports > 0) || !lb.entriesThisRace) return;
  const entries = [];
  for (const pd of lb.entriesThisRace.values()) {
    if (pd && pd.address && pd.lamports > 0) entries.push({ address: pd.address, lamports: Math.floor(pd.lamports) });
  }
  if (!entries.length) return;
  const raceId = lb.id + ':' + (lb.tStart || Date.now());
  _inflight.set(raceId, { raceId, entries, potLamports: lb.potLamports, at: Date.now() });
  saveQueue();
}

const MIN_STAKE_C = 10;        // $0.10 floor — below this the network fee dominates the pot
const MAX_STAKE_C = 50000;     // $500 ceiling
function normStake(v) {
  const c = Math.round((Number(v) || 0) * 100);
  if (!isFinite(c) || c <= 0) return 0;                       // 0 == free
  return Math.max(MIN_STAKE_C, Math.min(MAX_STAKE_C, c));
}

function makeLobby(name, ownerName, stakeUsd) {
  const id = 'kf-' + (nextLobbyNum++);
  const stakeCents = normStake(stakeUsd);
  const lb = {
    id,
    name: (name || (stakeCents ? '$' + (stakeCents / 100) + ' Race' : 'Free Race')).slice(0, 24),
    owner: ownerName || '',
    stakeCents,
    free: stakeCents === 0,
    // Who has actually PAID for the race about to run. Cleared at every race start, so a fee is per
    // race and cannot carry over. See the charge point on k-ready.
    paid: new Map(),            // sid -> { cents, ref }
    state: 'waiting',           // waiting -> countdown -> racing -> done
    racers: new Map(),          // sid -> racer
    spectators: new Set(),      // sid
    // Spectators who pressed JOIN while a race was running, promoted to racers when it ends. Keyed
    // by socket id so a second press is a no-op — that idempotence is what makes this safe to hang a
    // paid entry fee off, because it is the only place an entry can be created.
    queued: new Map(),          // sid -> { name, color }
    startAt: 0,
    tStart: 0,
    finishOrder: [],
    emptySince: Date.now(),
    createdAt: Date.now(),
  };
  lobbies.set(id, lb);
  return lb;
}

// One house lobby always exists so a player who arrives first has somewhere to
// be, and so the browser is never an empty list.
function houseLobby() {
  for (const lb of lobbies.values()) if (lb.house) return lb;
  const lb = makeLobby('Open Practice', '');
  lb.house = true;
  return lb;
}

function gridSlot(idx) {
  return (idx - (MAX_RACERS - 1) / 2) * (ROAD_W / (MAX_RACERS + 1));
}

function spawnFor(idx) {
  const t = 0;
  const p = pointAt(t), h = headingAt(t);
  const off = gridSlot(idx), perp = h + Math.PI / 2;
  return { x: p.x + Math.cos(perp) * off, y: p.y + Math.sin(perp) * off, ang: h };
}

// A racer IS a kart. `k` is the exact object stepKart() mutates on the client, built by the same
// mkKart(), so nothing about a car lives in two shapes. x/y/ang/spd are read straight off it.
const NO_INPUT = { gas: false, brake: false, left: false, right: false, drift: false, fire: false };
function makeRacer(sid, slot, name, color) {
  const r = {
    sid, slot, name, color,
    k: PHYS.mkKart(0, slot),
    ctrl: NO_INPUT,
    lap: 1, best: 0, lapStart: 0, sectors: new Set(), prevSec: -1,
    finished: false, place: 0, ready: false, readyAt: 0, last: Date.now(),
  };
  placeOnGrid(r);
  return r;
}
function placeOnGrid(r) {
  const s = spawnFor(r.slot != null ? r.slot : 0);
  r.k.x = s.x; r.k.y = s.y; r.k.ang = s.ang; r.k.spd = 0;
  r.k.drifting = false; r.k.driftT = 0; r.k.fuel = 0; r.k.slip = 0; r.k.padT = 0; r.k.burning = false;
}

function lobbySummary(lb, withNames) {
  return {
    id: lb.id, name: lb.name, state: lb.state,
    free: lb.stakeCents === 0,
    stakeCents: lb.stakeCents, stakeUsd: lb.stakeCents / 100,
    potCents: lb.stakeCents * (lb.state === 'waiting' ? lb.paid.size : lb.racers.size),
    readyInMs: lb.state === 'waiting' && lb.readyDeadline ? Math.max(0, lb.readyDeadline - Date.now()) : null,
    racers: lb.racers.size, max: MAX_RACERS,
    spectators: lb.spectators.size,
    trackId: TRACK_ID,
    // Opt-in roster for the admin LIVE panel. Names only: this endpoint is public.
    ...(withNames ? {
      players: [...lb.racers.values()].map((r) => ({
        name: r.name, ready: !!r.ready, lap: r.lap,
        finished: !!r.finished, paid: lb.paid.has(r.sid),
      })),
      queuedNames: [...lb.queued.values()].map((q) => q.name),
    } : {}),
  };
}

function listLobbies(withNames) {
  const out = [];
  for (const lb of lobbies.values()) out.push(lobbySummary(lb, withNames));
  out.sort((a, b) => (b.racers + b.spectators) - (a.racers + a.spectators));
  return out;
}

function broadcastLobbyList() {
  io.emit('k-lobbies', { lobbies: listLobbies(), trackId: TRACK_ID, region: REGION });
}

function roster(lb) {
  const out = [];
  for (const [sid, r] of lb.racers) {
    // The grid SLOT travels with the roster. Every client builds its own car locally and, without
    // being told otherwise, builds it on slot 0 — so a full grid would start stacked on one square,
    // all clipping through each other before the lights even went out. The slot is the server's to
    // assign, so it has to be the server that says where you are.
    //
    // It is also the racer's NUMBER (slot + 1, so 1..8). Deriving it from the roster's iteration
    // index instead meant the numbers renumbered themselves whenever the lobby changed, and the
    // client made it worse by picking a livery off the CARS-array index — a different order again.
    // One server-assigned slot now decides grid box, number and colour together.
    const slot = r.slot != null ? r.slot : 0;
    const g = spawnFor(slot);
    out.push({
      id: sid, name: r.name, color: r.color, lap: r.lap, best: r.best,
      finished: r.finished, place: r.place, ready: !!r.ready,
      slot, gx: +g.x.toFixed(1), gy: +g.y.toFixed(1), ga: +g.ang.toFixed(4),
    });
  }
  return out;
}

function pushRoom(lb, ev, payload) { io.to(lb.id).emit(ev, payload); }

function sendState(lb) {
  pushRoom(lb, 'k-state', {
    state: lb.state,
    startAt: lb.startAt,
    // The ready window, so the lobby can show the clock everyone was waiting to see. This was the
    // whole "the 30 seconds never starts" bug: readyDeadline was set and honoured on the server, but
    // k-state did not include it, so no client had anything to count down. Sent as BOTH an absolute
    // deadline and a remaining duration - the duration is immune to a client whose clock is skewed.
    readyDeadline: lb.readyDeadline || 0,
    readyInMs: lb.state === 'waiting' && lb.readyDeadline ? Math.max(0, lb.readyDeadline - Date.now()) : null,
    readyWindowMs: READY_WINDOW_MS,
    trackId: TRACK_ID,
    seed: TRACK_SEED,
    laps: LAPS,
    roster: roster(lb),
  });
}

function tryStart(lb) {
  if (lb.state !== 'waiting') return;
  // In a paid lobby only people who actually paid may take a grid slot. Readiness alone is not enough:
  // the pot has to equal the number of cars on track, or someone races for free off other people's money.
  if (lb.stakeCents > 0) {
    for (const [sid, r] of lb.racers) if (r.ready && !lb.paid.has(sid)) r.ready = false;
  }
  /*
   * WHO GETS IN: the first 8 to press READY, in the order they pressed it. Sorting by readyAt rather
   * than by whoever happens to sit earliest in the Map makes that promise literal — being quick is
   * what earns a slot, not having joined the room first.
   */
  const ready = [...lb.racers.values()].filter((r) => r.ready).sort((a, b) => a.readyAt - b.readyAt);
  // Nobody ready — clear the clock. Leaving it running meant an EMPTY room kept publishing a
  // countdown, so the home page advertised "1/8 on the grid, starts in 3s" for a race with nobody in
  // it. A deadline is only meaningful while somebody is actually waiting on it.
  if (ready.length === 0) { if (lb.readyDeadline) { lb.readyDeadline = 0; broadcastLobbyList(); } return; }
  if (ready.length > MAX_RACERS) for (const r of ready.slice(MAX_RACERS)) r.ready = false;
  const field = ready.slice(0, MAX_RACERS);

  /*
   * WHEN IT GOES: 30 seconds between races to ready up and pay. A full grid goes immediately — there
   * is nothing to wait for. Otherwise the window has to expire, and if fewer than two are ready when
   * it does, the clock RESETS rather than starting a one-car race. That is the rule that keeps a quiet
   * lobby usable: it keeps offering another 30 seconds instead of burning through empty races.
   */
  const now = Date.now();
  if (field.length >= MAX_RACERS) { /* full grid — go now */ }
  // sendState as well as broadcastLobbyList: the lobby list feeds the home page, but the people who
  // just readied are IN the room and were never told their own clock had started.
  else if (!lb.readyDeadline) { lb.readyDeadline = now + READY_WINDOW_MS; sendState(lb); broadcastLobbyList(); return; }
  else if (now < lb.readyDeadline) return;
  else if (field.length < MIN_TO_START) { lb.readyDeadline = now + READY_WINDOW_MS; sendState(lb); return; }

  /*
   * ONLY THE FIELD RACES. This is the pay gate, and it has to be enforced by what goes on the grid --
   * not by a flag. `field` is everyone who readied (and, in a paid lobby, paid: the loop at the top of
   * tryStart already strips a ready flag from anyone not in lb.paid). Everyone else in the room is a
   * SPECTATOR for this race and is removed from the racer set entirely.
   *
   * Previously they merely had r.ready cleared and were left in lb.racers -- and the grid loop below
   * iterated lb.racers, so they were placed, given laps, and simulated anyway. That is a free entry
   * into a paid race whose pot is built only from the people who paid, and the freeloader can win it.
   * Nothing about a boolean flag can fix that; they must not be in the set the race is built from.
   */
  const fieldSet = new Set(field);
  for (const [sid, r] of [...lb.racers]) {
    if (fieldSet.has(r)) continue;
    r.ready = false;
    lb.racers.delete(sid);
    lb.spectators.add(sid);
    const s2 = io.sockets.sockets.get(sid);
    if (s2) {
      s2.isSpectator = true;
      s2.emit('k-notice', { msg: lb.stakeCents > 0
        ? 'Watching this race -- press READY before the clock to be in the next one.'
        : 'Watching this race -- press READY before the clock to be in the next one.' });
      s2.emit('k-queued', { lobbyId: lb.id, queued: false });
    }
  }
  lb.readyDeadline = 0;

  refreshTrack();
  for (const r of lb.racers.values()) {
    // Grid box comes from the racer's OWN slot, the same one the roster publishes as their number.
    // This used to be a running index over the Map, so after anyone left mid-session the car you
    // lined up in stopped matching the number painted on it.
    placeOnGrid(r);
    r.lap = 1; r.sectors = new Set(); r.prevSec = -1; r.lapStart = 0;
    r.best = 0; r.finished = false; r.place = 0;
    r.ctrl = NO_INPUT;
  }
  // The fees just collected belong to THIS race. Snapshot the pot, then clear the ledger so the next
  // race starts from zero and nobody's payment can be counted twice across two races.
  lb.potCents = lb.stakeCents * (lb.stakeCents > 0 ? lb.paid.size : 0);
  // Keep the ACTUAL lamports collected, not a re-derivation from cents at today's SOL price — the
  // pot must pay out exactly what came in, and the price moves between entry and finish.
  lb.potLamports = 0;
  lb.entriesThisRace = new Map(lb.paid);
  // The race is going. Every ticket that funded it is now spent and can never enter another.
  for (const pd of lb.paid.values()) retireTicket(pd.ticket);
  for (const pd of lb.paid.values()) lb.potLamports += Math.max(0, Math.floor(pd.lamports || 0));
  lb.paid.clear();
  lb.state = 'countdown';
  lb.startAt = Date.now() + COUNTDOWN_MS;
  lb.finishOrder = [];
  sendState(lb);
  broadcastLobbyList();
}

/*
 * LAP VALIDATION lives on the server even though the cars do not. A lap only
 * counts if the reported positions actually visited (nearly) every sector of
 * the circuit in order, so a client that teleports to the line, or drives the
 * wrong way, or cuts across the infield, does not score. This is the piece that
 * makes the result meaningful rather than merely reported — and it is the same
 * sector machinery the replay/verification work will need.
 */
const SECTORS = 16;
function noteSector(lb, r) {
  const t = Math.atan2(r.k.y - CY, r.k.x - CX);
  const sec = Math.floor((((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SECTORS);
  if (sec !== r.prevSec) { r.sectors.add(sec); r.prevSec = sec; }
  const now = (Date.now() - lb.tStart) / 1000;
  if (sec === 0 && r.sectors.size >= SECTORS - 1 && now - r.lapStart > 4) {
    const lt = now - r.lapStart;
    if (!r.best || lt < r.best) r.best = lt;
    r.lapStart = now;
    r.sectors.clear(); r.sectors.add(0);
    r.lap++;
    if (r.lap > LAPS && !r.finished) {
      r.finished = true;
      lb.finishOrder.push({ id: r.sid, name: r.name, time: now, best: r.best });
      r.place = lb.finishOrder.length;
      pushRoom(lb, 'k-finish', { id: r.sid, name: r.name, place: r.place, time: +now.toFixed(2), best: +r.best.toFixed(2) });
      if (lb.finishOrder.length >= lb.racers.size) endRace(lb);
    }
    return true;
  }
  return false;
}

function endRace(lb) {
  if (lb.state === 'done') return;
  lb.state = 'done';
  // Settle betting markets FIRST, while finishOrder and the racer map are still intact — the
  // lobby reset below clears exactly the state 'ahead of' is judged from.
  try { settleKartWagers(lb); } catch (e) { console.error('[kart] wager settle threw', e && e.message); }


  /*
   * PAY THE WINNER. The pot was snapshotted at lights-out from the entries actually collected, so it
   * can only ever be money that was really paid in — a race with three entries pays out three stakes,
   * never four, whatever happened to the roster afterwards.
   *
   * Winner is decided by the FINISH ORDER the server itself validated (sector by sector), not by
   * anything a client claimed. If nobody completed the race — everyone disconnected, a mass retire —
   * there is no winner and the pot is refunded to the entrants instead, because the alternative is
   * the house quietly keeping money for a race that never resolved.
   */
  if (lb.stakeCents > 0 && lb.potCents > 0 && lb.potLamports > 0) {
    const raceId = lb.id + ':' + (lb.tStart || Date.now());
    const byAddr = new Map();
    for (const [sid, pd] of lb.entriesThisRace || []) byAddr.set(sid, pd.address);
    const finishers = lb.finishOrder.filter((f) => byAddr.get(f.id));
    let winners = [];
    if (finishers.length) {
      // Ties split: anyone finishing on the same lap within a hair of the best time shares it.
      const bestT = finishers[0].time;
      winners = finishers.filter((f) => f.time <= bestT + 0.01).map((f) => ({ address: byAddr.get(f.id) }));
    } else {
      // Nobody finished — refund every entrant rather than bank an unresolved race.
      winners = [...new Set([...byAddr.values()])].map((a) => ({ address: a }));
    }
    if (winners.length) settleRace(raceId, winners, lb.potLamports);
    // Unreachable in practice — no entrants means no pot — but a pot with nowhere to send it must
    // never just be dropped on the floor. The in-flight record still names everyone who funded it,
    // so give it straight back rather than banking an unresolved race.
    else refundInFlightRace(raceId, 'ended with a pot and NO payable address');
    lb.potCents = 0; lb.potLamports = 0; lb.entriesThisRace = null;
  }

  pushRoom(lb, 'k-results', {
    trackId: TRACK_ID,
    results: lb.finishOrder.map((f, i) => ({ place: i + 1, name: f.name, time: +f.time.toFixed(2), best: +f.best.toFixed(2) })),
  });
  broadcastLobbyList();
  // Back to the lobby so the room can run again without anyone rejoining.
  setTimeout(() => {
    if (!lobbies.has(lb.id)) return;
    lb.state = 'waiting';
    for (const r of lb.racers.values()) { r.ready = false; r.finished = false; r.place = 0; }
    // Promote everyone who pressed JOIN while this race was running. They paid (or will, once
    // lobbies go paid) at that press and have been watching since; this is the race they bought.
    if (lb.queued && lb.queued.size) {
      for (const [sid, q] of lb.queued) {
        const s2 = io.sockets.sockets.get(sid);
        if (!s2 || s2.data.lobbyId !== lb.id) continue;          // left while waiting — nothing to promote
        if (lb.racers.size >= MAX_RACERS) break;
        const taken = new Set([...lb.racers.values()].map((r) => r.slot));
        let idx = 0; while (taken.has(idx) && idx < MAX_RACERS) idx++;
        const s = spawnFor(idx);
        lb.spectators.delete(sid);
        s2.isSpectator = false;
        lb.racers.set(sid, makeRacer(sid, idx, q.name, q.color));
        s2.emit('k-queued', { lobbyId: lb.id, queued: false });
        // Being promoted out of the queue is a SEAT IN THE ROOM, not a paid entry. The only charge
        // point is k-ready, so in a paid lobby say so plainly -- otherwise someone waits on a grid slot
        // they never bought and finds out when the race starts without them.
        if (lb.stakeCents > 0) s2.emit('k-notice', { msg: 'You are in the next race -- press READY to pay your entry and take a grid slot.' });
      }
      lb.queued.clear();
    }
    sendState(lb);
    broadcastLobbyList();
  }, 8000);
}

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET
// ═══════════════════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  /*
   * SIGNED BETTABLE ROSTER OVER HTTP - the kart half of the same gap snake had. The roster was only
   * pushed over the socket (k-wager-roster), so a bet could only be opened from inside a race. The
   * hub's /bets page has no socket. Same entries, same kartRosterEntry signatures, same expiry: this
   * route mints nothing and settle re-verifies everything regardless.
   *
   * Only races that are actually going to run are listed, matching the `bettable` rule the socket
   * push already applies - a market on a race that never starts is a market that cannot settle.
   */
  if (req.url === '/wager-roster' || req.url === '/kart/wager-roster') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const exp = Date.now() + WG_ROSTER_TTL;
      const arenas = [];
      for (const [lid, lb] of lobbies) {
        if (!(lb.state === 'countdown' || lb.state === 'racing')) continue;
        const racers = [...lb.racers.values()].filter((r) => !r.finished).map((r) => kartRosterEntry(lb, r, exp));
        if (!racers.length) continue;
        arenas.push({ lobby: lid, region: REGION, subjects: racers });
      }
      return res.end(JSON.stringify({ ok: true, region: REGION, exp, arenas }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'roster failed' }));
    }
  }

  /*
   * WHAT MONEY IS THIS NODE STILL SITTING ON? The blackjack equivalent of `GET /api/blackjack?q=1`,
   * and it exists for the same reason: an unpaid pot should be something you can SEE, not something
   * you infer from a player complaining. Counts, kinds, ages and ids only — no addresses and no
   * amounts, because this route is public.
   */
  if (req.url === '/queue' || req.url === '/kart/queue') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const now = Date.now();
    let dead = [];
    try { dead = JSON.parse(fs.readFileSync(QUEUE_DEAD_FILE, 'utf8')) || []; } catch (_) { dead = []; }
    const jobs = [..._jobs.values()];
    return res.end(JSON.stringify({
      ok: true, region: REGION,
      pending: jobs.length,
      dueNow: jobs.filter((j) => (j.dueAt || 0) <= now).length,
      oldestAgeSec: jobs.length ? Math.round((now - Math.min(...jobs.map((j) => j.createdAt || now))) / 1000) : 0,
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, tries: j.tries, ageSec: Math.round((now - (j.createdAt || now)) / 1000), lastErr: j.lastErr })),
      racesInFlight: _inflight.size,
      deadLettered: dead.length,
      deadIds: dead.slice(-20).map((d) => d.id),
    }));
  }

  if (req.url === '/health' || req.url === '/kart/health') {
    // CORS: snakepot.com's /games/kart page reads this to show whether each node is actually up and
    // how many lobbies are running. Without the header the browser blocks the read and the page shows
    // both regions "offline" while they are perfectly healthy. Public read-only status, no credentials.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      ok: true, region: REGION, trackId: TRACK_ID, seed: TRACK_SEED,
      lobbies: lobbies.size, up: Math.round(process.uptime()),
      // Surfaced on the health check too, so an unpaid pot shows up on the page that is already
      // polled rather than only on a route somebody has to know to ask for.
      moneyQueue: _jobs.size, racesInFlight: _inflight.size,
    }));
  }
  // Lobby list over plain HTTP so the platform's home page can show live races without opening a
  // socket for a card nobody may click. Same shape the socket broadcasts.
  if (req.url === '/kart/lobbies' || req.url === '/lobbies') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, region: REGION, trackId: TRACK_ID, lobbies: listLobbies(true) }));
  }
  res.writeHead(404); res.end('kart');
});

const io = new Server(server, {
  path: '/kart/socket.io',
  // WebSocket first. Polling-first is what left snake players stuck on long-poll
  // with a permanently bad ping; do not reorder these.
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: false },
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5,
});

function leaveLobby(sock) {
  const lb = lobbies.get(sock.data.lobbyId);
  if (!lb) return;
  // Leaving before the race starts refunds the entry, for the same reason as un-readying.
  if (lb.state === 'waiting') refundOne(lb, sock.id, 'left before start');
  lb.racers.delete(sock.id);
  lb.spectators.delete(sock.id);
  if (lb.queued) lb.queued.delete(sock.id);   // leaving cancels a queued entry for the next race
  sock.leave(lb.id);
  sock.data.lobbyId = null;
  if (lb.racers.size === 0 && lb.spectators.size === 0) {
    lb.emptySince = Date.now();
    // Everyone has gone and the race never started — give the entries back.
    if (lb.state === 'waiting') refundUnstarted(lb, 'room emptied');
  }
  /*
   * A RACE MUST ALWAYS RESOLVE, INCLUDING WHEN EVERYONE LEAVES.
   *
   * This only ended the race while racers REMAINED (`size > 0`), so if the last driver dropped mid-race
   * the lobby sat in 'racing' forever: endRace never ran, settleRace never ran, and the pot - real
   * money already taken at READY - was never paid out OR refunded. That is the worst possible state
   * for an entry fee to be left in, and it is reachable from a single disconnect in a one-car race.
   *
   * Empty and still racing now ends it too. endRace pays whoever the server validated as finishing
   * and, when nobody did, refunds every entrant - so the money always leaves the pot one way or the
   * other rather than going quiet.
   */
  if (lb.state === 'racing' && lb.racers.size === 0) endRace(lb);
  else if (lb.state === 'racing' && lb.racers.size > 0 && lb.finishOrder.length >= lb.racers.size) endRace(lb);
  /*
   * A DEPARTURE MUST NOT TRIGGER A START. Leaving shrinks the room, and the next tick evaluates the
   * start rule against whoever is left -- so pressing LEAVE could fire the race off immediately for
   * everyone else, which is what "clicking leave starts a race" was. Nobody chose that moment; the
   * clock is the only thing allowed to. If a start is still pending, re-arm the full window so the
   * remaining drivers get the countdown they were promised rather than an ambush.
   */
  if (lb.state === 'waiting' && lb.readyDeadline) {
    const stillReady = [...lb.racers.values()].filter((r) => r.ready).length;
    if (stillReady === 0) lb.readyDeadline = 0;
    else lb.readyDeadline = Math.max(lb.readyDeadline, Date.now() + Math.min(READY_WINDOW_MS, 10000));
  }
  sendState(lb);
  broadcastLobbyList();
}

io.on('connection', (sock) => {
  sock.data.lobbyId = null;
  sock.data.joinedAt = Date.now();
  sock.emit('k-hello', { region: REGION, trackId: TRACK_ID, seed: TRACK_SEED, laps: LAPS });
  sock.emit('k-lobbies', { lobbies: listLobbies(), trackId: TRACK_ID, region: REGION });

  sock.on('k-list', () => {
    sock.emit('k-lobbies', { lobbies: listLobbies(), trackId: TRACK_ID, region: REGION });
  });

  sock.on('k-create', (d) => {
    d = d || {};
    if (lobbies.size >= 40) return sock.emit('k-notice', { msg: 'Too many lobbies open right now.' });
    const lb = makeLobby(String(d.name || '').trim(), String(d.player || '').slice(0, 16), d.stake);
    broadcastLobbyList();
    sock.emit('k-created', { id: lb.id });
  });

  sock.on('k-join', (d) => {
    d = d || {};
    let lb = lobbies.get(String(d.lobbyId || ''));
    if (!lb) lb = houseLobby();

    // ── ENTERING A RACE THAT IS ALREADY RUNNING ───────────────────────────────────────────────────
    // You watch this one and you are entered for the NEXT one. Dropping a late arrival straight onto
    // the grid would put them half a lap down in a race everyone else started fairly, which is not a
    // late entry, it is a broken race for them and a free position for everyone behind.
    //
    // THIS IS ALSO THE SINGLE CHARGE POINT for paid lobbies. Pressing JOIN is the one action that
    // takes an entry fee — never READY, never a reconnect, never re-opening the lobby. `queued` is a
    // Set keyed by socket id, so pressing JOIN five times, double-clicking it, or reconnecting and
    // pressing it again all collapse to the same single entry. When money is switched on, the fee is
    // taken here and ONLY on the transition from "not queued" to "queued".
    if (lb.state !== 'waiting') {
      if (!lb.queued) lb.queued = new Map();
      const already = lb.queued.has(sock.id);
      if (lb.queued.size + lb.racers.size >= MAX_RACERS) {
        return sock.emit('k-notice', { msg: 'Next race is already full — watching.' }), joinAsSpectator(sock, lb);
      }
      if (sock.data.lobbyId && sock.data.lobbyId !== lb.id) leaveLobby(sock);
      lb.queued.set(sock.id, {
        name: String(d.name || 'Racer').slice(0, 16),
        color: String(d.color || '#39d353').slice(0, 9),
      });
      joinAsSpectator(sock, lb);
      // Say it once, on the transition only, so spamming the button is silent rather than a wall of
      // toasts — and so the "you have been charged" message can never appear twice.
      if (!already) sock.emit('k-notice', { msg: 'Watching this race — you are in the next one.' });
      sock.emit('k-queued', { lobbyId: lb.id, queued: true });
      sendState(lb);
      broadcastLobbyList();
      return;
    }

    if (lb.racers.size >= MAX_RACERS) {
      // Never a hard error mid-flow — put them in as a spectator instead of
      // bouncing them back to a menu with nothing to look at.
      return sock.emit('k-notice', { msg: 'That race is full — watching instead.' }), joinAsSpectator(sock, lb);
    }
    if (sock.data.lobbyId) leaveLobby(sock);
    // Claim the lowest FREE grid slot and hold it for as long as this racer is in the lobby. It used
    // to be `lb.racers.size`, recomputed from the live Map on every roster() call — so when anyone
    // left, everybody behind them shifted down a slot, changing their grid box and their race number
    // mid-session. A race number that moves is not a race number.
    const taken = new Set([...lb.racers.values()].map((r) => r.slot));
    let idx = 0; while (taken.has(idx) && idx < MAX_RACERS) idx++;
    const s = spawnFor(idx);
    lb.racers.set(sock.id, makeRacer(sock.id, idx,
      String(d.name || 'Racer').slice(0, 16), String(d.color || '#39d353').slice(0, 9)));
    sock.join(lb.id);
    sock.data.lobbyId = lb.id;
    lb.emptySince = 0;
    sendState(lb);
    broadcastLobbyList();
  });

  function joinAsSpectator(s2, lb) {
    if (s2.data.lobbyId) leaveLobby(s2);
    lb.spectators.add(s2.id);
    s2.join(lb.id);
    s2.data.lobbyId = lb.id;
    lb.emptySince = 0;
    sendState(lb);
    broadcastLobbyList();
  }

  sock.on('k-spectate', (d) => {
    const lb = lobbies.get(String((d || {}).lobbyId || ''));
    if (!lb) return sock.emit('k-notice', { msg: 'That race has finished.' });
    joinAsSpectator(sock, lb);
  });

  /*
   * READY — AND, in a paid lobby, THE SINGLE POINT AN ENTRY FEE IS EVER TAKEN.
   *
   * The owner's rule: if you do not ready up you do not pay and you do not race; the moment you ready,
   * the entry is taken and you are in. So the fee hangs off the false -> true transition of THIS flag
   * and nowhere else — not on join, not on reconnect, not on re-opening the lobby.
   *
   * Double-charging is prevented structurally rather than by being careful: `lb.paid` is a Map keyed by
   * socket id, and the charge only happens on the transition from absent to present. Readying,
   * un-readying and readying again inside the same race is therefore ONE payment, because the entry is
   * already in the map the second time. `paid` is cleared when a race starts, so a fee is per race.
   *
   * Un-readying does NOT refund — the entry is committed once taken, exactly like the snake ante. What
   * it does is stop you being put on the grid, which is why the refund path below exists for a race
   * that never runs.
   */
  sock.on('k-ready', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb) return;
    const r = lb.racers.get(sock.id);
    if (!r) return;
    const want = !!(d && d.ready);

    if (want && lb.stakeCents > 0 && !lb.paid.has(sock.id)) {
      // ⚠️ MONEY IS NOT WIRED YET. Until an on-chain entry deposit is verified here, a paid lobby must
      // refuse to run rather than let anyone race for free in a room that advertises a pot — that would
      // be worse than the feature being missing, because the pot would pay out money nobody put in.
      // The hook belongs exactly here, and it must confirm the deposit BEFORE the line below runs.
      if (!ENTRY_FEES_ENABLED) {
        return sock.emit('k-notice', { msg: 'Paid races are not open yet — free races are.' });
      }
      const t = verifyTicket(lb.id, d && d.ticket, d && d.tsig);
      if (!t) return sock.emit('k-need-pay', { lobbyId: lb.id, stakeCents: lb.stakeCents });
      // Already used for a race that ran, or refunded. Either way it buys nothing further.
      if (ticketSpent(d && d.ticket)) return sock.emit('k-need-pay', { lobbyId: lb.id, stakeCents: lb.stakeCents });
      if (t.cents !== lb.stakeCents) return sock.emit('k-notice', { msg: 'That entry was for a different stake.' });
      // One ticket, one seat. A ticket is per (lobby, address), so re-presenting the same one after a
      // reconnect re-uses the existing entry instead of creating a second — this is what makes
      // readying, un-readying and readying again a single payment.
      for (const [sid, pd] of lb.paid) if (pd.address === t.address && sid !== sock.id) lb.paid.delete(sid);
      // `at` is what makes a refund id for this entry stable — see refundOne. It must be set once,
      // here, at the only place an entry is ever created, and never refreshed.
      lb.paid.set(sock.id, { cents: lb.stakeCents, address: t.address, lamports: t.lamports, ticket: (d && d.ticket) || null, at: Date.now() });
    }

    // Standing down before the lights is a full refund — you are not in this race, so you are not
    // paying for it.
    /*
     * NO UN-READYING ONCE PAID. Readying in a paid lobby takes the entry fee, and from that moment you
     * are on the grid: the pot has your money in it and the others are waiting on a field that must
     * stop changing. Letting someone toggle back out meant the pot could shrink while the clock ran.
     *
     * The way out is still there and still costs nothing - LEAVE refunds in full for any race that has
     * not started (see leaveLobby). That is a clear promise: you are either in this race or out of the
     * room, never half-committed.
     */
    if (!want && lb.stakeCents > 0 && lb.paid.has(sock.id)) {
      return sock.emit('k-notice', { msg: 'You are in this race - leave the lobby if you want your entry back.' });
    }
    if (!want && lb.state === 'waiting' && lb.paid.has(sock.id)) refundOne(lb, sock.id, 'un-readied');
    r.ready = want;
    r.readyAt = Date.now();
    sendState(lb);
    tryStart(lb);
  });

  // Position report. Trusted for RENDERING only; the server still decides laps.
  /*
   * INPUTS, not positions. This is the whole point of the rewrite: the only thing a client is allowed
   * to tell the server is which buttons are held. Six booleans have no cheat surface — there is no
   * value here a modified client could inflate to go faster, because speed is not in the message.
   *
   * Deliberately state, not events: a dropped packet just means the car keeps doing what it was doing
   * for another 33ms, which is far better than a lost keyup leaving the throttle stuck on. The old
   * `k-pos` handler is gone entirely rather than kept for compatibility — leaving a path in that
   * still accepts a claimed position would leave the exact hole this closes.
   */
  sock.on('k-in', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb) return;
    const r = lb.racers.get(sock.id);
    if (!r || !d) return;
    r.ctrl = { gas: !!d.g, brake: !!d.b, left: !!d.l, right: !!d.r, drift: !!d.d, fire: !!d.f };
    r.last = Date.now();
  });

  let _chatLast = 0, _chatBurst = 0;
  sock.on('k-chat', (d) => {
    const lb = lobbies.get(sock.data.lobbyId);
    if (!lb) return;
    const msg = String((d || {}).msg || '').slice(0, 140).trim();
    if (!msg) return;
    /*
     * RATE LIMIT. A spectator needs no ticket and costs nothing to create, so this is the one place an
     * anonymous socket can generate load and nuisance for a whole room. Racers are limited too - being
     * in the race is not a licence to flood it.
     */
    const nowc = Date.now();
    if (nowc - _chatLast < 1200) { if (++_chatBurst > 3) return; } else { _chatBurst = 0; }
    _chatLast = nowc;
    const r = lb.racers.get(sock.id);
    // io.to() includes the sender, so the client must NOT echo locally — the
    // same trap the snake chat hit.
    pushRoom(lb, 'k-chat', { name: r ? r.name : 'spectator', msg });
  });

  sock.on('k-leave', () => leaveLobby(sock));
  /*
   * LOG WHY. Players report dropping mid-race and the server has no disconnect() calls of its own, so
   * the cause is the transport - and socket.io already knows it. `reason` distinguishes the cases that
   * need completely different fixes: 'ping timeout' (the client stopped answering - tab throttled, GC
   * pause, or the physics loop blocking the event loop), 'transport close' (network dropped),
   * 'transport error' (a frame the socket could not handle, e.g. over maxHttpBufferSize).
   * Without this the next session is guessing again.
   */
  sock.on('disconnect', (reason) => {
    const lbx = lobbies.get(sock.data.lobbyId);
    const racing = !!(lbx && lbx.state === 'racing' && lbx.racers.has(sock.id));
    if (racing || (lbx && lbx.stakeCents > 0)) {
      console.log('[kart] DISCONNECT reason=' + reason + ' lobby=' + (sock.data.lobbyId || '-') +
        ' state=' + ((lbx && lbx.state) || '-') + ' midRace=' + racing +
        ' transport=' + ((sock.conn && sock.conn.transport && sock.conn.transport.name) || '?') +
        ' upSec=' + Math.round((Date.now() - (sock.data.joinedAt || Date.now())) / 1000));
    }
    leaveLobby(sock);
  });
});

/*
 * ── THE SIMULATION ────────────────────────────────────────────────────────────────────────────────
 * 120Hz, fixed step, accumulator-driven. Fixed because the physics MUST be reproducible: stepKart
 * integrates with dt, so feeding it whatever wall-clock gap the event loop happened to produce would
 * make a laggy server a slightly different game from a quiet one, and make a race impossible to
 * replay. 120Hz because that is what the client's own tests were run at, and because a smaller step
 * keeps contact from tunnelling at 540 units/sec.
 *
 * An accumulator with a hard ceiling: if the loop stalls, we catch up by a bounded number of steps
 * and then drop the rest. Without the ceiling a two-second GC pause would try to run 240 steps in one
 * go, stall the loop further, and spiral.
 */
const SIM_HZ = 120;
const SIM_DT = 1 / SIM_HZ;
const SIM_MAX_CATCHUP = 8;       // at most 8 steps (66ms) of catch-up in one pass

function simulate(lb, seconds) {
  lb._acc = (lb._acc || 0) + seconds;
  let steps = Math.floor(lb._acc / SIM_DT);
  if (steps > SIM_MAX_CATCHUP) { steps = SIM_MAX_CATCHUP; lb._acc = 0; } else { lb._acc -= steps * SIM_DT; }
  const racers = [...lb.racers.values()];
  for (let n = 0; n < steps; n++) {
    for (const r of racers) {
      // A finished kart coasts off the line instead of parking on it. Same idea as the client's
      // slow-down lap, and it has to be here too now that the server owns the position.
      const ctrl = r.finished ? NO_INPUT : (r.ctrl || NO_INPUT);
      // Everyone else on track is a potential tow. The server is the only place slipstream can be
      // computed from TRUE positions rather than 40ms-old interpolations of them.
      const donors = [];
      for (const o of racers) if (o !== r && !o.finished) donors.push(o.k);
      PHYS.stepKart(r.k, SIM_DT, {
        gas: ctrl.gas, brake: ctrl.brake, left: ctrl.left, right: ctrl.right,
        drift: ctrl.drift, fire: ctrl.fire, slipFrom: donors,
      });
    }
    // Contact, resolved for every pair by the ONE machine that owns both cars. On the client each
    // side could only move itself and had to trust the other to do the same; here it is symmetric by
    // construction, which is what makes contact safe to have money riding on.
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) {
        const a = racers[i], b = racers[j];
        if (a.finished || b.finished) continue;
        PHYS.contactPair(a.k, b.k, false);
        PHYS.contactPair(b.k, a.k, false);
      }
    }
    for (const r of racers) if (!r.finished) noteSector(lb, r);
  }
}

// ── Tick: countdown -> racing, broadcast, reap ─────────────────────────────
const TICK_MS = 33;              // ~30Hz to every client and spectator
setInterval(() => {
  const now = Date.now();
  for (const lb of [...lobbies.values()]) {
    // The ready window has to be judged by the CLOCK, not only when somebody presses the button —
    // otherwise the 30 seconds elapse and the race just sits there until the next input arrives.
    if (lb.state === 'waiting' && lb.readyDeadline && now >= lb.readyDeadline) tryStart(lb);
    if (lb.state === 'countdown' && now >= lb.startAt) {
      lb.state = 'racing';
      lb.tStart = now;
      // raceId is `lb.id + ':' + lb.tStart`, so this is the first moment the pot HAS an id. Record it
      // before anything else happens to it.
      markRaceInFlight(lb);
      broadcastKartRoster(lb);
      lb._simAt = now; lb._acc = 0;   // start the accumulator clean, not with the whole countdown in it
      for (const r of lb.racers.values()) { r.lapStart = 0; r.sectors = new Set(); r.prevSec = -1; }
      sendState(lb);
      broadcastLobbyList();
    }
    if (lb.state === 'racing') {
      if (now - lb.tStart > RACE_TIMEOUT_MS) endRace(lb);
      simulate(lb, (now - (lb._simAt || now)) / 1000);
      lb._simAt = now;
      const cars = [];
      for (const r of lb.racers.values()) {
        const k = r.k;
        cars.push({
          id: r.sid, x: +k.x.toFixed(1), y: +k.y.toFixed(1), a: +k.ang.toFixed(3),
          s: Math.round(k.spd), lap: r.lap, df: !!k.drifting, b: !!(k.burning || k.padT > 0),
          fin: r.finished,
          // The authoritative simulation tick this snapshot came from. The client replays its own
          // unacknowledged inputs from here, so a correction never throws away input the player has
          // already given — that is what stops the car rubber-banding on every packet.
          q: r.ackSeq || 0,
        });
      }
      pushRoom(lb, 'k-cars', { t: now - lb.tStart, cars });
      // Signed roster for the betting panel. Every few seconds is plenty — it changes only when
      // somebody joins, leaves or finishes, and each entry carries a 5-minute signature.
      if (!lb._lastRoster || now - lb._lastRoster > 4000) { lb._lastRoster = now; broadcastKartRoster(lb); }
    }
    // Reap empty non-house lobbies so the browser does not fill with ghosts.
    if (!lb.house && lb.racers.size === 0 && lb.spectators.size === 0 &&
        lb.emptySince && now - lb.emptySince > EMPTY_LOBBY_TTL) {
      refundUnstarted(lb, 'lobby reaped');
      lobbies.delete(lb.id);
      broadcastLobbyList();
    }
  }
}, TICK_MS);

// Midnight-UTC rollover, checked once a minute.
setInterval(() => {
  if (refreshTrack()) {
    io.emit('k-track', { trackId: TRACK_ID, seed: TRACK_SEED });
    broadcastLobbyList();
    console.log('[kart] new daily circuit', TRACK_ID, TRACK_SEED);
  }
}, 60000);

/*
 * ── BOOT: PICK UP WHATEVER THE LAST PROCESS WAS STILL HOLDING ────────────────────────────────────
 * Order matters. Read the file first, THEN convert any race that was mid-flight into a refund, and
 * only then start the drain — so the recovered refunds go out in the same pass as everything that
 * was already queued. This all runs before listen(), so no new race can be started into a queue that
 * has not been restored yet.
 */
loadQueue();
recoverInFlight();
setInterval(() => { drainQueue().catch((e) => console.error('[kart] drain threw', e && e.message)); }, DRAIN_MS);
drainQueue().catch(() => {});

houseLobby();
server.listen(PORT, () => {
  console.log('[kart] ' + REGION + ' listening on :' + PORT + '  track ' + TRACK_ID + ' (' + TRACK_SEED + ')' +
    '  queue ' + _jobs.size + ' job(s)');
});

process.on('uncaughtException', (e) => console.error('[kart] uncaught', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[kart] unhandled', e && e.stack || e));
