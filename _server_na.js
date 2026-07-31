'use strict';

const express = require('express');

const http = require('http');

const https = require('https');

const { Server } = require('socket.io');

const crypto = require('crypto');

// ── OWNER TUNING AUTH ────────────────────────────────────────────────────────────────────────────
// The owner wallet's ed25519 public key as a DER SubjectPublicKeyInfo, so crypto.verify can use it
// directly and the server needs no base58 decoder. Wallet: 4B9MgNPUgDiKKQRhsC3pmdWoAehs4yjHb8VfL2Nahzpv
// (owner-confirmed 2026-07-26; keep OWNER_WALLETS in slither-snakes.html in sync)
const SS_OWNER_SPKI_B64 = 'MCowBQYDK2VwAyEALyxRUCKgOO+rQExbgJ5D4MwMaQXXdRaz/z8VCp91Ww8=';
let _ssOwnerKey = null;
function ssOwnerKey() {
  if (!_ssOwnerKey) {
    _ssOwnerKey = crypto.createPublicKey({
      key: Buffer.from(SS_OWNER_SPKI_B64, 'base64'), format: 'der', type: 'spki',
    });
  }
  return _ssOwnerKey;
}
// Canonical JSON over a FIXED key order — both sides must hash byte-identical text.
function ssTuneCanon(t) {
  // ⚠️ APPEND ONLY, AND THE CLIENT'S ARRAY MUST MATCH THIS EXACTLY. The signature is over this
  // text; one differing key or a different order and every owner push is rejected as unsigned.
  const k = ['grazePx', 'grazeHead', 'bodyScale', 'grazeReach', 'circDeg', 'faceDeg', 'n2nScale', 'grazeScaleK', 'rule', 'killSink'];
  return JSON.stringify(k.map((x) => (t[x] === undefined || t[x] === null ? null : t[x])));
}
function ssOwnerVerify(lobbyId, tuning, ts, sigB64) {
  try {
    const n = Number(ts);
    if (!n || Math.abs(Date.now() - n) > 300000) return false;      // 5-minute window
    if (!sigB64 || typeof sigB64 !== 'string') return false;
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    const hash = crypto.createHash('sha256').update(ssTuneCanon(tuning)).digest('hex');
    const msg = Buffer.from('ss-tune:' + lobbyId + ':' + n + ':' + hash, 'utf8');
    return crypto.verify(null, msg, ssOwnerKey(), sig);
  } catch (e) { console.warn('[ss-tune] verify ' + (e && e.message)); return false; }
}
// The tuning NEW lobbies start from. Owner changes update this (and every live lobby) and are saved to
// disk, so a pm2 restart doesn't silently snap the whole game back to the shipped constants.
const SS_TUNING_FILE = '/opt/pac-arena/ss-tuning.json';
// Two base-radius snakes (ssSectionRadius(0)=8 each). The anchor where graze scaling is a no-op.
// Two snakes at the STARTING length (INIT_SECTIONS = 30 -> ssSectionRadius = 24.17 each).
// This is the size every player begins at, so it is the only sane place for scaling to be a
// no-op. It was 16 (two ns=0 snakes) - a size that NEVER occurs in play, so the 'unchanged'
// anchor was unreachable and every real size measured as a departure from it.
const SS_GRAZE_REF_REACH = 48.34;
// Graze difficulty anchor (owner 2026-07-31). The graze is now equally hard at EVERY size;
// these two say WHICH size it is equally hard AS. Killer 26 is the owner's own 'feels right'
// size, target 30 is the spawn size, i.e. the most common circler you actually meet.
// GRAZE NECK — the stretch of the TARGET'S trail, right behind their head, that is excluded
// from the kill test. It exists so a head-on approach resolves as nose-to-nose (bigger wins)
// instead of a body kill... but N2N IS EXPLICITLY SKIPPED FOR CIRCLING PAIRS, so on a circle
// graze it defers to nothing and is pure dead ground.
//
// It was ceil((RaBase + Rd)/SS_POINT_DIST) — i.e. it GREW WITH BOTH SNAKES. That is a SECOND
// size-dependence, separate from the sink one: 41.6px of dead trail at ns8 rising to 60.8px at
// ns63. And it sits exactly where a graze kill is made — you cut a circler off with the trail you
// JUST LAID, which is the part nearest your head, which is the part that was excluded.
//
// Flattened to 20 points (32px) = what the SMALLEST pair of snakes already gets today, so this can
// only ever be easier than it was, never harder, at any size. ⚠️ This is the ONE lever that moves
// kill difficulty WITHOUT touching sink: it changes WHERE on the trail a kill counts, not HOW DEEP
// it must go. Visible graze depth is unchanged at 4.30px. Normal body collisions and N2N keep the
// original size-scaled exclusion — only the circle graze uses this.
const SS_GRAZE_NECK_PTS = 20;
// ⚠️ KILL DEPTH AND ROOM ARE TWO DIFFERENT TESTS. They are not the same event and must not
// share a knob. Both are circle-graze tests, but the VICTIM is a different snake in each:
//
//   aCirc                    the victim IS the circler -> its own loop drove it into someone's
//                            trail. THIS IS THE KILL. Depth fixed at SS_GRAZE_KILL_SINK.
//   !aCirc && D.circleActive the victim is NOT circling, the target is -> this is somebody
//                            manoeuvring around a circler. THIS IS ROOM, and grazePx drives it.
//
// Lumping them into one margin is why turning 'max body overlap' up to give yourself room ALSO
// made your kills need that much more graze - the owner's exact complaint, and it was real.
// Split, grazePx buys room to work with WITHOUT moving how far a circler must be driven to die.
// Still symmetric: every player gets the same room and every circler dies at the same depth.
const SS_GRAZE_KILL_SINK = 4.304;   // px, every size — a size-26 snake vs a spawn-size circler
const SS_GRAZE_ANCHOR_KILLER_NS = 26;
const SS_GRAZE_ANCHOR_TARGET_NS = 30;
// Runtime hitbox changes are refused outright while this is true - see the ss-tune handler.
const SS_TUNE_LOCKED = false;   // owner panel ENABLED - ssOwnerVerify (ed25519 + 5min replay window) is the gate
let SS_TUNING_DEFAULT = { killSink: 4.304, n2nScale: 0.30, bodyScale: 0.75, grazePx: 3.3, grazeHead: 1.20, grazeReach: 1.00, grazeScaleK: 0.75, circDeg: 360, faceDeg: 21, rule: 'biggest_wins' };
// Load the owner's saved tuning. This USED to run right here as a bare try-block, and it threw on
// every single boot: `fs` is declared ~270 lines below and ssClampTuning falls back to SS_CAMP_*_D
// constants declared ~950 lines below, and a hoisted `const` is not initialised until its line runs.
// The catch turned each one into a warning, so the file on disk was silently ignored and every
// restart snapped the game back to the shipped constants - NA had grazePx 3.35 saved and had been
// running 3.3 for 100 restarts. Chasing the individual names is whack-a-mole; the block simply has to
// run after the module has finished evaluating, so it is a function now and it is called at the
// bottom of the file. Nothing reads SS_TUNING_DEFAULT before then (lobbies copy it on creation).
function ssLoadSavedTuning() {
  try {
    if (fs.existsSync(SS_TUNING_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SS_TUNING_FILE, 'utf8'));
      SS_TUNING_DEFAULT = ssClampTuning(saved, SS_TUNING_DEFAULT);
      console.log('[tuning] loaded saved tuning ' + JSON.stringify(SS_TUNING_DEFAULT));
    } else { console.log('[tuning] no saved tuning file, using shipped defaults'); }
  } catch (e) { console.warn('[tuning] load failed ' + (e && e.message)); }
}
function ssSaveTuning(t) {
  try { fs.writeFileSync(SS_TUNING_FILE, JSON.stringify(t)); } catch (e) { console.warn('[tuning] save failed ' + (e && e.message)); }
}
// Clamp every knob to a range the simulation stays sane in. Anything missing keeps its current value.
function ssClampTuning(t, cur) {
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const c = cur || {};
  return {
    n2nScale:   num(t.n2nScale,   0.05, 1.00, c.n2nScale   != null ? c.n2nScale   : 0.30),
    bodyScale:  num(t.bodyScale,  0.20, 2.00, c.bodyScale  != null ? c.bodyScale  : 0.75),
    grazePx:    num(t.grazePx,    0.00, 20.0, c.grazePx    != null ? c.grazePx    : 3.3),
    // KILL DEPTH, in literal px — how far a circling snake must be driven into a trail before it
    // dies. Separate from grazePx (which is ROOM) on purpose: see the collision site. Floored at
    // 0.1 so a kill can never fire before the sprites actually touch, capped at 20 like room.
    killSink:   num(t.killSink,   0.10, 20.0, c.killSink   != null ? c.killSink   : SS_GRAZE_KILL_SINK),
    grazeHead:  num(t.grazeHead,  0.50, 2.50, c.grazeHead  != null ? c.grazeHead  : 1.20),
    grazeReach: num(t.grazeReach, 0.20, 2.00, c.grazeReach != null ? c.grazeReach : 1.00),
    // 0 = flat px (old behaviour), 1 = identical feel at every size. 0.75 keeps a small edge
    // for smaller snakes while removing the 2.6x gap. See the collision site for the arithmetic.
    // NEGATIVE k is allowed and useful: it makes the graze margin SHRINK as snakes grow. Because
    // killDist grows with size, a smaller absolute margin on a big snake is a smaller RELATIVE
    // change - which is what lets the skim depth fall away with size while the difficulty stays
    // flat. k>0 does the opposite (constant relative depth, difficulty varies); k=0 is flat px.
    grazeScaleK: num(t.grazeScaleK, -2.00, 1.50, c.grazeScaleK != null ? c.grazeScaleK : 0.75),
    circDeg:    Math.round(num(t.circDeg, 90, 720, c.circDeg != null ? c.circDeg : 360)),
    faceDeg:    Math.round(num(t.faceDeg,  1,  90, c.faceDeg != null ? c.faceDeg : 21)),
    rule:       (['biggest_wins', 'smallest_wins', 'random', 'both_die'].indexOf(t.rule) >= 0) ? t.rule : (c.rule || 'biggest_wins'),

    // ── anti-camp arena push ──

    campSec:      num(t.campSec,      0,  120, c.campSec      != null ? c.campSec      : SS_CAMP_SEC_D),

    campPush:     num(t.campPush,     0, 1500, c.campPush     != null ? c.campPush     : SS_CAMP_PUSH_D),

    campMaxOff:   num(t.campMaxOff,   0, 3000, c.campMaxOff   != null ? c.campMaxOff   : SS_CAMP_MAXOFF_D),

    campEase:     num(t.campEase,     0, 1500, c.campEase     != null ? c.campEase     : SS_CAMP_EASE_D),

    campEscapeSec:num(t.campEscapeSec,0,   60, c.campEscapeSec!= null ? c.campEscapeSec: SS_CAMP_ESCSEC_D),

    campEscapeDist:num(t.campEscapeDist,0,5000,c.campEscapeDist!=null ? c.campEscapeDist: SS_CAMP_ESCDIST_D),

    campShrink:   num(t.campShrink,    0, 0.30, c.campShrink   != null ? c.campShrink   : SS_CAMP_SHRINK_D),

    campShrinkMax:num(t.campShrinkMax, 0, 0.80, c.campShrinkMax!= null ? c.campShrinkMax: SS_CAMP_SHRINKMAX_D),

    campAccel:    num(t.campAccel,     0, 1.00, c.campAccel    != null ? c.campAccel    : SS_CAMP_ACCEL_D),

    campPushMax:  num(t.campPushMax,   1, 5.00, c.campPushMax  != null ? c.campPushMax  : SS_CAMP_PUSHMAX_D),

  };

}



// ── ANTI-CAMP ARENA PUSH ─────────────────────────────────────────────────────────────────────────

// Defaults (all live-tunable from the COMBAT TUNING panel).

const SS_CAMP_SEC_D     = 10;    // seconds of continuous circling before the map starts pushing

const SS_CAMP_PUSH_D    = 618;   // px/sec the ring travels at (owner 2026-07-31: 658 -6%). NOTE
                                 // nominal: ssTick runs at TICK_MS=33 but passes dt=1/60, so the
                                 // ground speed is about 0.45x this. Measured 253px/s at 565.

const SS_CAMP_ACCEL_D   = 0.0034; // +0.34%/s: reaches the +10% ceiling at ~29s, i.e. only once the border has travelled all the way across to where they were sitting

const SS_CAMP_PUSHMAX_D = 1.10;  // ...up to this multiple of the start speed (owner: +10% max, not +70%)

const SS_CAMP_MAXOFF_D  = 4500;  // px cap on how far the centre may travel from origin

const SS_CAMP_EASE_D    = 260;   // px/sec the centre drifts back once nobody is camping

const SS_CAMP_ESCSEC_D  = 6;     // seconds of genuine travel needed to call off the push

const SS_CAMP_ESCDIST_D = 600;   // ...and how far they must actually get from the camp spot

const SS_CAMP_SHRINK_D    = 0.020;  // arena radius fraction/sec the ring closes while anyone camps

const SS_CAMP_SHRINKMAX_D = 0.45;   // ...never past this fraction, so the arena cannot collapse

// ── ROAMING ARENA ──────────────────────────────────────────────────────────────────────────
// The border no longer reacts to camping. It roams on a fixed cycle instead (see ssCampPush).
const SS_ROAM_REGROW_D = 10;    // seconds to regain full size once the ring arrives
const SS_ROAM_HOLD_D   = 10;    // ...then this long sat still at full size before it moves again
// HOP DISTANCE IS DERIVED, NOT TASTE. The drawn radius chases targetR at SS_BORDER_SHRINK_IN,
// which caps how fast the ring can physically close: 3000*0.0022*60 = 396 px/s. A 50% squeeze of
// a 3000px arena is 1500px of radius, so the border needs 1500/396 = 3.79s to actually get there,
// i.e. 3.79 * 565 = 2140px of travel. A shorter hop would arrive while the ring was still closing
// and then turn straight around, so it would never once reach half size. Hence the floor.
const SS_ROAM_HOP_MIN  = 3127;  // px — shortest hop (owner: 2310 +6.5%)
const SS_ROAM_HOP_MAX  = 3980;  // px — longest hop (owner: 2940 +6.5%)
// SQUEEZE SCALES WITH THE LIVE PLAYER COUNT so the arena is never more cramped per player
// than it is today. Squeezed radius = baseR * sqrt(n / REF), because room is AREA and area goes
// as radius squared - the sqrt is what keeps px^2-per-player constant. At n = REF the depth is
// exactly SS_CAMP_SHRINKMAX_D; below it the ring may close further, above it it closes less and
// eventually not at all. Owner: bots do NOT count, only real players.
const SS_ROAM_REF_PLAYERS = 5;   // player count at which the squeeze is exactly SS_CAMP_SHRINKMAX_D
const SS_ROAM_MIN_PLAYERS = 2;   // a lone player is treated as 2, so waiting alone is not punished
// ── GAME MODES: ZONE WARS vs ORIGINAL ────────────────────────────────────────
// ORIGINAL lobbies are the ones whose id starts `ss-og-` (ss-og-free-lobby, ss-og-paid-lobby-5).
// EVERY EXISTING LOBBY ID KEEPS ITS MEANING and is Zone Wars, so no live room changes identity
// and no money path (escrow keys, foodpark, wager rosters, entry tokens) sees a new name for a
// room it already knows. ORIGINAL is the arena exactly as it was before 2026-07-30: static
// centre on the origin, camper-triggered push, no roaming, no respread.
function ssIsOgLobby(lid) { return String(lid || '').indexOf('ss-og-') === 0; }
// Pre-roam fallbacks for ssCampPushOG. The SS_CAMP_*_D constants above were retuned for the
// roam (523->618 speed, 3000->4500 off, 0.32->0.45 depth) and must not leak into ORIGINAL.
const SS_OG_PUSH_D      = 523;
const SS_OG_MAXOFF_D    = 3000;
const SS_OG_SHRINKMAX_D = 0.32;
const SS_ROAM_SHRINK_CAP  = 0.75; // hard ceiling on depth, so no count can ever collapse the arena


// Extra pebbles a PAID lobby holds at all times, on top of SS_FOOD_TARGET.
const SS_FOOD_PAID_BONUS = 15;
// Fresh food must never spawn ON a snake. Squared px clearance from every sampled body node.
const SS_FOOD_SNAKE_CLEAR2 = 120 * 120;



function ssCampTune(sg, k, d) { const v = sg.tuning && sg.tuning[k]; return (v == null ? d : v); }



// Picks the next centre for the roaming arena: a random point inside the maxOff disc whose distance
// from where the ring is NOW lands in the hop band. Rejection-sampled - the band is wide next to the
// disc so this hits within a couple of tries, and the fallback still returns a legal in-disc target.
// Because both endpoints are inside a convex disc, the whole path is too - no maxOff clamp needed.
// How deep this arena should squeeze RIGHT NOW, from the live real-player count. Recomputed
// every tick, not pinned at departure, so the map answers the moment someone drops in, quits or
// cashes out. Room is AREA and area goes as radius squared, which is why the sqrt is what keeps
// px^2-per-player constant. Bots are excluded (owner). A lone player counts as SS_ROAM_MIN_PLAYERS
// so waiting alone for opponents is not punished with a tiny ring.
function ssRoamDepth(sg, baseShrink) {
  let live = 0;
  for (const s of sg.snakes.values()) { if (s.alive && !s.bot) live++; }
  const n = Math.max(SS_ROAM_MIN_PLAYERS, live);
  return Math.max(0, Math.min(SS_ROAM_SHRINK_CAP,
    1 - (1 - baseShrink) * Math.sqrt(n / SS_ROAM_REF_PLAYERS)));
}

function ssRoamDepart(sg, maxOff, baseShrink) {
  let best = null;
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * maxOff;
    const tx = Math.cos(a) * r, ty = Math.sin(a) * r;
    const d = Math.hypot(tx - sg.cx, ty - sg.cy);
    if (!best || d > best.d) best = { x: tx, y: ty, d: d };
    if (d >= SS_ROAM_HOP_MIN && d <= SS_ROAM_HOP_MAX) { best = { x: tx, y: ty, d: d }; break; }
  }
  sg.roamFromX = sg.cx; sg.roamFromY = sg.cy;
  sg.roamToX = best.x;  sg.roamToY = best.y;
  sg.roamDist = Math.max(1, best.d);
  // DEPTH IS FIXED AT DEPARTURE and held for the whole hop. Recomputing it every tick would make
  // the border jump mid-flight whenever someone died or joined, and would break the guarantee
  // that the squeeze lands exactly on arrival (it is driven by fraction-of-distance-covered).
  sg.roamShrinkMax = ssRoamDepth(sg, baseShrink);   // recomputed live each tick too
  sg.roamPhase = 'moving';
  sg.roamT = 0;
}

// ── ORIGINAL MODE: the camper-triggered push, restored verbatim from before 2026-07-30 ─────
// Lobbies whose id starts `ss-og-` run THIS instead of the roaming cycle. The arena sits on the
// origin and only ever moves in response to somebody holding a circle, exactly as it did before
// the roaming border shipped. Reads its knobs through ssCampTune (so ss-tuning.json still drives
// it, which is what was really live) with the PRE-ROAM constants as the fallback - the SS_CAMP_*_D
// constants above have since been retuned for the roam and must not leak in here.
function ssCampPushOG(sg, dt) {
  const now = Date.now();
  const secNeeded  = ssCampTune(sg, 'campSec', SS_CAMP_SEC_D);
  const pushSpeed  = ssCampTune(sg, 'campPush', SS_OG_PUSH_D);
  const maxOff     = ssCampTune(sg, 'campMaxOff', SS_OG_MAXOFF_D);
  const easeSpeed  = ssCampTune(sg, 'campEase', SS_CAMP_EASE_D);
  const escSec     = ssCampTune(sg, 'campEscapeSec', SS_CAMP_ESCSEC_D);
  const escDist    = ssCampTune(sg, 'campEscapeDist', SS_CAMP_ESCDIST_D);
  const campers = [];
  const shrinkRate = ssCampTune(sg, 'campShrink', SS_CAMP_SHRINK_D);
  const shrinkMax  = ssCampTune(sg, 'campShrinkMax', SS_OG_SHRINKMAX_D);
  const shrinkEase = shrinkRate * 2;   // recovers twice as fast as it closes
  const accel   = ssCampTune(sg, 'campAccel', SS_CAMP_ACCEL_D);
  const pushMax = ssCampTune(sg, 'campPushMax', SS_CAMP_PUSHMAX_D);
  for (const sn of sg.snakes.values()) {
    if (!sn.alive || sn.bot) continue;
    const h = sn.path && sn.path[0];
    if (!h) continue;
    if (sn.circleActive) {
      // Circling: start/continue the camp clock.
      if (!sn._campStart) sn._campStart = now;
      // RE-ANCHOR every frame they are circling, and wipe any escape progress. Two reasons:
      //  1. Resuming the circle before the escape window elapses restarts the FULL escape time. You
      //     cannot break off for 4 seconds, circle again, and keep the old progress.
      //  2. The escape distance must be measured from where they are ACTUALLY camping now. Anchoring
      //     once let a player drift, resume circling somewhere new, and then count as instantly "far
      //     from the camp spot" against a stale anchor they had already left.
      sn._campX = h.x; sn._campY = h.y;
      sn._campEscFrom = 0;
    } else if (sn._campStart) {
      // NOT circling - but stopping is not enough. They must break the circle AND actually travel
      // escDist away from where they were camping, and keep BOTH true for escSec. Anything less
      // (a twitch, a brief straighten, stopping then resuming) leaves the push running.
      const far = Math.hypot(h.x - (sn._campX || 0), h.y - (sn._campY || 0)) >= escDist;
      if (!far) sn._campEscFrom = 0;                       // hasn't gone anywhere yet
      else if (!sn._campEscFrom) sn._campEscFrom = now;    // clock starts the moment they're clear
      else if (now - sn._campEscFrom >= escSec * 1000) {   // sustained escape -> free
        sn._campStart = 0; sn._campEscFrom = 0;
      }
    }
    if (sn._campStart) {
      const held = (now - sn._campStart) / 1000;
      if (held >= secNeeded) campers.push(sn);   // EVERY camper counts, not just the longest
    }
  }
  if (campers.length) {
    // TRANSLATE by the resultant of every camper's away-vector. One camper => a full directional
    // push. Two on opposite sides => the vectors cancel and the ring stops sliding, because there is
    // no single direction that punishes both. The shrink below is what gets them.
    let ax = 0, ay = 0;
    for (const c of campers) {
      const h = c.path[0];
      let dx = sg.cx - h.x, dy = sg.cy - h.y;
      const m = Math.hypot(dx, dy);
      if (m < 1) { dx = 1; dy = 0; } else { dx /= m; dy /= m; }
      ax += dx; ay += dy;
    }
    ax /= campers.length; ay /= campers.length;   // resultant; ~0 when they oppose each other
    // RAMP: gentle for the first moments, then it leans on them harder the longer they hold the
    // circle. campPushT is wall-time spent actually pushing and resets as soon as nobody qualifies.
    sg.campPushT = (sg.campPushT || 0) + dt;
    const spd = pushSpeed * Math.min(pushMax, 1 + accel * sg.campPushT);
    sg.cx += ax * spd * dt;
    sg.cy += ay * spd * dt;
    // Remember where the ring is heading so displaced food can be dropped into the ground it is
    // about to uncover, instead of scattered uniformly and lagging behind the leading edge.
    sg.cvx = ax; sg.cvy = ay;
    const off = Math.hypot(sg.cx, sg.cy);
    if (off > maxOff) { sg.cx = sg.cx / off * maxOff; sg.cy = sg.cy / off * maxOff; }
    // SHRINK - the pressure that CANNOT be cancelled by standing opposite one another. Ramps while
    // anyone is camping, faster with more campers, and is capped so the arena never collapses.
    const rate = shrinkRate * Math.min(3, campers.length);
    sg.campShrinkPct = Math.min(shrinkMax, (sg.campShrinkPct || 0) + rate * dt);
    sg.campPushing = true;
  } else {
    const off = Math.hypot(sg.cx, sg.cy);
    if (off > 0.5) {
      const step = Math.min(off, easeSpeed * dt);
      sg.cx -= (sg.cx / off) * step; sg.cy -= (sg.cy / off) * step;
      // Coming HOME is still travelling, and the ground on the return side is being uncovered just
      // like the leading edge was on the way out. Publishing the direction here keeps the food bias
      // AND the in-motion food bonus alive for the whole journey - without it both switched off the
      // instant the camper died and the ring slid back onto bare ground.
      sg.cvx = -sg.cx / off; sg.cvy = -sg.cy / off;
    } else { sg.cx = 0; sg.cy = 0; sg.cvx = 0; sg.cvy = 0; }
    sg.campShrinkPct = Math.max(0, (sg.campShrinkPct || 0) - shrinkEase * dt);
    sg.campPushT = 0;   // next offence starts gentle again
    sg.campPushing = false;
  }
  // ORIGINAL never roams. Held explicitly so nothing downstream (border-chase rate, spawn scoring,
  // client HUD) can read a roam phase left over from anything.
  sg.roamPhase = null; sg.roamToX = null; sg.roamToY = null;
}
// Runs once per tick. THE ARENA ROAMS ON A TIMER - nothing here looks at what any player is doing.
//
// This replaced the anti-camp push. Holding a circle used to slide the border away from you and
// squeeze it; that trigger is GONE, and circling now causes nothing at all. Every lobby instead runs
// the same cycle forever, empty or full, free or paid:
//
//   moving  travel to a fresh centre at campPush px/s, squeezing to campShrinkMax (half size) so the
//           squeeze lands EXACTLY as the ring arrives, however long the hop turned out to be
//   regrow  SS_ROAM_REGROW_D seconds back out to full size, standing still
//   hold    SS_ROAM_HOLD_D seconds at full size
//   -> moving again.  Cycle is ~4.5s + 10s + 10s = ~25s.
//
// Now dead, kept only so a stale tuning override cannot throw: SS_CAMP_SEC_D, SS_CAMP_ACCEL_D,
// SS_CAMP_PUSHMAX_D, SS_CAMP_EASE_D, SS_CAMP_ESCSEC_D, SS_CAMP_ESCDIST_D, SS_CAMP_SHRINK_D. The old
// speed RAMP is dead with them: it existed to lean harder on someone who kept camping, and a routine
// hop is over in 4 seconds, so the roam runs at the flat start speed the owner asked to keep.
function ssCampPush(sg, dt) {
  if (sg.cx == null) { sg.cx = 0; sg.cy = 0; }
  if (sg.og) return ssCampPushOG(sg, dt);   // ORIGINAL mode - never roams
  const now = Date.now();

  // ⚠ READ THE CONSTANTS, NOT sg.tuning. ss-tuning.json still carries campPush/campShrinkMax/
  // campMaxOff from the DELETED camper system, every lobby copies it at creation, and
  // ssCampTune prefers a stored value - so editing SS_CAMP_PUSH_D did nothing at all. Speed sat
  // at the saved 509 (254.5 px/s measured) through four separate 'increases', and the depth ran
  // at the saved 0.45 rather than the constant. A saved knob must not outlive its feature.
  // The LOCKED hitbox tuning is untouched - only these three dead camp keys are bypassed.
  const speed     = SS_CAMP_PUSH_D;
  const maxOff    = SS_CAMP_MAXOFF_D;
  const baseShrink = SS_CAMP_SHRINKMAX_D;
  // LIVE depth - answers a join/quit/cash-out on the very next tick. During 'hold' the squeeze
  // is forced to 0 regardless, so this only has an effect while moving or regrowing.
  const shrinkMax = ssRoamDepth(sg, baseShrink);
  const regrowMs  = Math.max(100, ssCampTune(sg, 'roamRegrowSec', SS_ROAM_REGROW_D) * 1000);
  const holdMs    = Math.max(0, ssCampTune(sg, 'roamHoldSec', SS_ROAM_HOLD_D) * 1000);

  // PHASE TIMERS ARE WALL CLOCK, NOT ACCUMULATED dt. ssTick runs on TICK_MS=33 (~30Hz, and under
  // load nearer 27) yet hands this function dt=1/60, so anything integrating dt runs at roughly half
  // real-time and drifts with CPU load - a 10s hold measured 20.2s live. Movement below is
  // deliberately LEFT on speed*dt: that is what sets the border's speed, and the speed is meant to
  // stay exactly what it is today.
  if (sg.roamPhase !== 'moving' && sg.roamPhase !== 'settle' &&
      sg.roamPhase !== 'regrow' && sg.roamPhase !== 'hold') {
    sg.roamPhase = 'hold'; sg.roamUntil = now + holdMs; sg.campShrinkPct = 0;
  }

  if (sg.roamPhase === 'moving') {
    let dx = sg.roamToX - sg.cx, dy = sg.roamToY - sg.cy;
    const rem = Math.hypot(dx, dy);
    const step = speed * dt;
    if (rem <= step || rem < 1) {
      sg.cx = sg.roamToX; sg.cy = sg.roamToY;
      sg.campShrinkPct = shrinkMax;
      sg.cvx = 0; sg.cvy = 0;
      sg.campPushing = false;
      sg.roamPhase = 'settle'; sg.roamUntil = now + SS_ROAM_SETTLE_MS;
    } else {
      dx /= rem; dy /= rem;
      sg.cx += dx * step; sg.cy += dy * step;
      // Squeeze driven by DISTANCE COVERED, not by an integrated rate, so it lands on shrinkMax
      // exactly as the ring arrives however long the hop takes and whatever the tick rate does.
      const gone = Math.hypot(sg.cx - sg.roamFromX, sg.cy - sg.roamFromY);
      sg.campShrinkPct = shrinkMax * Math.min(1, gone / sg.roamDist);
      // ssMakeFoodSpread and the food relocator read these to seed the ground being uncovered.
      sg.cvx = dx; sg.cvy = dy;
      sg.campPushing = true;
      // Radius this ring will have when it ARRIVES. ssFindSafeSpawn needs it so a player who
      // joins mid-hop is not placed on ground the border is about to leave behind.
      sg.roamEndR = SS_ARENA_R * (1 - Math.min(0.8, (sg.shrinkPct || 0) + shrinkMax));
    }
  } else if (sg.roamPhase === 'settle') {
    // Arrived. targetR is at the full squeeze, but the DRAWN radius chases it and may still be a few
    // px out. Hold the squeeze until the border has genuinely got there, so the intended depth is
    // what players actually see rather than just what the state says. Capped so it can never wedge.
    sg.campShrinkPct = shrinkMax;
    sg.cvx = 0; sg.cvy = 0;
    sg.campPushing = false;
    const want = SS_ARENA_R * (1 - Math.min(0.8, (sg.shrinkPct || 0) + shrinkMax));
    if ((sg.arenaR || SS_ARENA_R) <= want + 3 || now >= (sg.roamUntil || 0)) {
      sg.roamPhase = 'regrow'; sg.roamUntil = now + regrowMs;
    }
  } else if (sg.roamPhase === 'regrow') {
    const left = Math.max(0, (sg.roamUntil || 0) - now);
    sg.campShrinkPct = shrinkMax * (left / regrowMs);   // linear back to full over regrowMs
    sg.cvx = 0; sg.cvy = 0;
    sg.campPushing = false;
    if (left <= 0) {
      sg.campShrinkPct = 0; sg.roamPhase = 'hold'; sg.roamUntil = now + holdMs;
      // RESPREAD, IN ONE GO. The squeeze packs every pebble into the middle, and growing back out
      // does not un-pack them - the band the border just re-covered is left bare. So the instant
      // the arena is full size again, scatter the surplus across the whole circle in a single
      // pass. One operation, not a drip: no per-tick churn to watch or to pay for.
      //
      // Deliberate rules:
      //   * MOVES orbs, never creates any. The food count is untouched, so the arena can never
      //     hold more than usual - which is the thing that must not regress here.
      //   * DENSITY-DRIVEN, not a blanket scatter. An orb is only relocated while the core holds
      //     a bigger share of the food than it does of the AREA (0.42^2), and each move is
      //     accounted for, so it stops exactly at an even spread. It cannot strip the middle -
      //     that is the same bug pointing the other way.
      //   * GOLD IS NEVER TOUCHED. Those orbs are claim tickets on real SOL and belong where
      //     they were dropped; moving one would move somebody's money.
      //   * Placed with sqrt(random) so the scatter is uniform by AREA, not bunched at the rim,
      //     and kept inside 0.92R so the border sweep does not immediately drag them back in.
      try {
        const _fullR = SS_ARENA_R * (1 - Math.min(0.8, (sg.shrinkPct || 0))) * 0.92;
        const _cx2 = sg.cx || 0, _cy2 = sg.cy || 0;
        const _core2 = (_fullR * 0.42) * (_fullR * 0.42);
        const _idx = [];
        let _tot = 0;
        for (let i = 0; i < sg.food.length; i++) {
          const f = sg.food[i];
          if (!f || f.k) continue;                     // gold = money, skip
          _tot++;
          const dx = f.x - _cx2, dy = f.y - _cy2;
          if (dx * dx + dy * dy <= _core2) _idx.push(i);
        }
        // How many the core is allowed to keep = its share of the area. Move only the surplus.
        const _keep = Math.round(_tot * 0.42 * 0.42);
        for (let j = _keep; j < _idx.length; j++) {
          const f = sg.food[_idx[j]];
          const _a = Math.random() * Math.PI * 2;
          const _rr = _fullR * Math.sqrt(0.18 + 0.82 * Math.random());
          f.x = _cx2 + Math.cos(_a) * _rr; f.y = _cy2 + Math.sin(_a) * _rr;
        }
        if (_idx.length > _keep) sg._foodDirty = true;
      } catch (e) { /* a respread must never break the sim */ }
    }
  } else {
    sg.campShrinkPct = 0;
    sg.cvx = 0; sg.cvy = 0;
    sg.campPushing = false;
    if (now >= (sg.roamUntil || 0)) ssRoamDepart(sg, maxOff, baseShrink);
  }

  sg.campPushT = 0;   // dead camper ramp - held at 0 so nothing downstream reads a stale value
}

const fs = require('fs');



// ── Death-replay system (instrumentation only; no gameplay effect) ────────────

// Rolling per-tick authoritative buffer lives in sg._history. On each snake death

// a full replay (server frames + collision eval + all H2H/H2B calcs, later merged

// with the client render/interp/network report) is saved to disk + an in-memory

// ring, retrievable via /ss-replay/*. Replayed offline through PAC + MoneySlither.

const SS_REPLAY_DIR = '/opt/pac-arena/replays';

const SS_REPLAY_HISTORY_TICKS = 160;   // ~5.3s @ 30 TPS of authoritative state

const _ssReplays = [];                  // in-memory ring of recent replays

try { fs.mkdirSync(SS_REPLAY_DIR, { recursive: true }); } catch (e) {}



function ssSaveReplay(lid, victim, killer, diag) {

  return; // DISABLED (perf) - synchronous disk I/O per death blocked the event loop

  const sg = ssGames.get(lid);

  const frames = sg && sg._history ? sg._history.slice() : [];

  const rp = {

    id: diag.replayId,

    meta: { lid, victimId: victim.pid, killerId: killer ? killer.pid : null,

            stage: diag.stage, tick: diag.tick, t: diag.t, captured: Date.now() },

    diag,                 // collision eval + all H2H/H2B calcs (dots, gate, dist, crr, seg)

    frames,               // per-tick authoritative state (x,y,angle,tgt,face,boost,ns) for ~5s

    client: null          // filled in by ss-death-report from the victim's browser

  };

  _ssReplays.push(rp); while (_ssReplays.length > 30) _ssReplays.shift();

  try {

    fs.writeFileSync(`${SS_REPLAY_DIR}/${rp.id}.json`, JSON.stringify(rp));

    const files = fs.readdirSync(SS_REPLAY_DIR).filter(f => f.endsWith('.json')).sort();

    while (files.length > 80) { try { fs.unlinkSync(`${SS_REPLAY_DIR}/${files.shift()}`); } catch (e) {} }

  } catch (e) { console.warn('[REPLAY] write failed: ' + e.message); }

  console.log(`[REPLAY] saved ${rp.id} (${diag.stage}, victim=${victim.pid.slice(0,8)}, frames=${frames.length})`);

}



const PORT = process.env.PORT || 3001;

const GAME_SECRET = (process.env.GAME_SECRET || '').trim();

const REGION = (process.env.REGION || 'NA').trim();

const _usedGameTokens = new Set(); // server-level: survives room deletion, never cleared on disconnect



// ── Discord paid-lobby-join notifications ──────────────────────────────────

// Two separate channels: legacy `paid-lobby-*` ids are Pac-Man, `ss-paid-lobby-*` are Slither Snakes.

const DISCORD_WEBHOOK_PACMAN = (process.env.DISCORD_WEBHOOK_PACMAN || '').trim();

const DISCORD_WEBHOOK_SLITHER = (process.env.DISCORD_WEBHOOK_SLITHER || '').trim();

function postDiscord(webhookUrl, content) {

  if (!webhookUrl) return;

  try {

    const body = JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] } });

    const url = new URL(webhookUrl);

    const req = https.request({

      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',

      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }

    }, res => res.resume());

    req.on('error', e => console.warn('[DISCORD] notify failed: ' + e.message));

    req.write(body);

    req.end();

  } catch (e) { console.warn('[DISCORD] notify error: ' + e.message); }

}

function notifyPaidJoin(lobbyId, name) {

  const isSlither = lobbyId.startsWith('ss-');

  const webhookUrl = isSlither ? DISCORD_WEBHOOK_SLITHER : DISCORD_WEBHOOK_PACMAN;

  if (!webhookUrl) return;

  const game = isSlither ? `Slither Snakes (${REGION})` : `Pac-Man (${REGION})`;

  const safeName = String(name || 'A player').replace(/@/g, '@​').slice(0, 32);

  const usdMatch = lobbyId.match(/-(\d+)$/); // lobby id encodes the fixed USD tier, e.g. paid-lobby-25 -> $25

  const wagerTxt = usdMatch ? ` — wagered $${usdMatch[1]}` : '';

  postDiscord(webhookUrl, `@everyone **${safeName}** joined **${game}** paid lobby \`${lobbyId}\`${wagerTxt}`);

}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';



// ── Game constants ────────────────────────────────────────────────────────────

const C=48,R=36,TICK_MS=33;

const CHERRY_TICKS=300, PEPPER_TICKS=390;

// How long a dropped player is kept (frozen) in the room before removal,

// so a brief network blip resumes the same spot/score instead of respawning.

const DISCONNECT_GRACE_MS = 15000;

// Slither Snakes: real money is on the line, so a backgrounded tab / brief network blip must

// never cost a player their wager. Browsers throttle background-tab timers hard (the client

// sends input via setInterval every 33ms — background tabs can drop this to ~1/s or fully

// suspend it), so input silence alone does NOT mean the player quit. SS_GHOST_MS is now only

// the "start protecting them" threshold (freeze + collision-immune); the wager isn't actually

// forfeited until SS_DISCONNECT_GRACE_MS of continuous disconnection with no reconnect.

const SS_DISCONNECT_GRACE_MS = 600000; // 10 minutes

const CHERRY_RESPAWN=300, PEPPER_RESPAWN=240, MYSTERY_RESPAWN=300;



// ── Maze ──────────────────────────────────────────────────────────────────────

const MAZE_BASE=[

[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],

[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,0,1,1,1,0,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1],

[1,1,0,1,0,0,0,1,0,0,1,0,0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,0,1,1,1,0,1,1,0,0,0,0,1,0,1,1,0,0,1,1,0,1],

[1,1,0,1,0,0,0,1,0,0,1,0,0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,0,1,1,1,0,1,1,0,0,0,0,1,0,1,1,0,0,1,1,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1],

[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],

[1,1,0,0,0,0,0,0,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],

[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],

[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],

[1,1,0,0,0,0,0,0,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],

[1,1,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,1],

[1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,1,1],

[1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,1,1],

[1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,0,1,1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,0,1,1,1,1,1,1,0,1],

[1,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,1],

[1,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,1],

[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,0,0,1,1,1,1,1,1,1,1,0,0,0,1,1,1,1,0,1,1,1,0,1,1,1,1,1,1,0,1],

[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],

[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]

];



const SPAWNS=[

  {x:2,y:2},{x:46,y:2},{x:2,y:7},{x:46,y:7},

  {x:2,y:11},{x:46,y:11},{x:9,y:15},{x:27,y:15},

  {x:9,y:20},{x:27,y:20},{x:2,y:24},{x:46,y:24},

  {x:2,y:29},{x:46,y:29},{x:2,y:34},{x:46,y:34}

];



const POW_SPOTS=[

  {x:2,y:2},{x:46,y:2},{x:9,y:2},{x:38,y:2},

  {x:2,y:7},{x:46,y:7},{x:15,y:7},{x:31,y:7},

  {x:2,y:11},{x:9,y:11},{x:46,y:11},

  {x:9,y:15},{x:27,y:15},{x:9,y:20},{x:27,y:20},

  {x:2,y:24},{x:9,y:24},{x:46,y:24},

  {x:2,y:29},{x:20,y:29},{x:46,y:29},

  {x:2,y:34},{x:46,y:34},{x:15,y:34},{x:31,y:34}

];



// ── Token helpers ─────────────────────────────────────────────────────────────

function makeGameToken(lobbyId, pid) {

  const ts = Date.now();

  const data = `${lobbyId}:${pid}:${ts}`;

  const sig = crypto.createHmac('sha256', GAME_SECRET || 'dev').update(data).digest('hex');

  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');

}



function validateGameToken(token, lobbyId, pid) {

  try {

    const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());

    const expected = crypto.createHmac('sha256', GAME_SECRET).update(data).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

    const parts = data.split(':');

    if (parts[0] !== lobbyId) return false;

    if (pid && parts[1] !== pid) return false; // token must be for this exact wallet

    if (Date.now() - parseInt(parts[2]) > 7200000) return false; // 2h expiry

    return true;

  } catch { return false; }

}



// ── Room helpers ──────────────────────────────────────────────────────────────

function freshMaze() { return MAZE_BASE.map(r => [...r]); }



function rndPowSpot(maze) {

  const free = POW_SPOTS.filter(s => maze[s.y][s.x] === 0);

  if (!free.length) return null;

  return free[Math.floor(Math.random() * free.length)];

}



function placePowerups(maze) {

  const used = new Set();

  const place = (type, n) => {

    for (let i = 0; i < n; i++) {

      const s = rndPowSpot(maze);

      if (s && !used.has(`${s.x},${s.y}`)) { maze[s.y][s.x] = type; used.add(`${s.x},${s.y}`); }

    }

  };

  place(3, 4); place(4, 4); place(5, 2);

}



// ── Lobby defs (match client) ─────────────────────────────────────────────────

const LOBBY_IDS = new Set(['free-lobby', 'ss-free-lobby', 'ss-test-lobby', 'ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25',
  'ss-og-free-lobby', 'ss-og-paid-lobby-1', 'ss-og-paid-lobby-5']);   // ORIGINAL-mode twins
// Paid arenas are created on demand at ANY stake (ss-paid-lobby-0.07, -0.25, -12 ...), so the fixed
// set above can never describe what is actually running. A spectator may watch a room that both looks
// like a lobby AND exists right now — which keeps the old guarantee (no arbitrary name, and nothing
// here ever CREATES a room) while making every real arena watchable instead of only $1 and $5.
function isSpectatableLobby(id) {
  if (typeof id !== 'string' || !id || id.length > 40) return false;
  if (LOBBY_IDS.has(id)) return true;
  if (!/^(?:ss-(?:og-)?)?paid-lobby-\d+(?:\.\d+)?$/.test(id)) return false;
  return ssGames.has(id) || rooms.has(id);
}

// Owner-only isolated sandbox for trying experimental hitboxes. FREE (no wager) and it uses a

// SEPARATE nose/body collision model + its own tuning — nothing here touches any other lobby.

const SS_TEST_LOBBY = 'ss-test-lobby';



// ── Rooms ─────────────────────────────────────────────────────────────────────

const rooms = new Map();

// ssElimPairs no longer used (server is now authoritative for ss-* kills), kept for safety

const ssElimPairs = new Map();



// ── Snake rooms (ss-*): server-side collision — exact moneyslither.com model ──

// Extracted from moneyslither.com/client.js?v=1779196469 on 2026-06-26.

// Formulas: thicknessForSegments, head-to-head with dual-facing gate (smallest_wins),

// head-to-body with combined radii (headR + bodyR), all angles, no rear dead zone.



const SS_SPD      = 288 / 30;   // moneyslither BASE_SPEED  288 px/s ÷ 30 TPS = 9.6 px/tick

const SS_BSPD     = 630 / 30;   // moneyslither BOOST_SPEED 630 px/s ÷ 30 TPS = 21 px/tick

const SS_GHOST_MS = 6000;    // ms of input silence before freezing as (protected) disconnected —

                              // no longer eliminates outright; see SS_DISCONNECT_GRACE_MS above

const SS_HB       = 0.95;    // HITBOX_BASE

const SS_HBS      = 1.07;    // combatHitboxScale

const SS_HHBS     = 1.18;    // combatHeadHitboxScale

const SS_FACE     = Math.cos(75 * Math.PI / 180); // cos(75°) ≈ 0.259, facing gate threshold

const SS_POINT_DIST = 1.6;   // path recording granularity in px (MoneySlither POINT_DIST)

const SS_SEG_STEP = 4;       // path stride for H2B body samples (MoneySlither SEGMENT_SPACING_TICKS)

// ── Option A: server-authoritative body sync (feature-flagged; OFF = legacy head-only) ──────────

// When ON, the server streams a coarse copy of its OWN authoritative trail (render-trail `_rt`,

// derived from the same head motion as sn.path — sn.path/collision are NOT modified). The client

// renders THAT instead of free-running a body from head-only data, so drawn body == collision body.

// Deltas per tick are bounded (head-advance/SS_RT_DIST ≈ 2-4 pts) → no per-tick linear growth.

const SS_BODY_SYNC   = process.env.SS_BODY_SYNC === '1';

const SS_RT_DIST     = 6;    // px between render-trail points (< smallest sectionRadius*0.5 ≈ 7.6 → faithful client resample)

const SS_RT_KF_TICKS = 150;  // periodic full-body keyframe interval (~5s @30Hz), staggered per snake; heals joins/gaps

const SS_MIN_SIZE = 40;



// Server-authoritative physics constants (must match client exactly)

const SS_ARENA_R       = 3000;

// Dynamic border: each death-to-the-border briefly shrinks the arena, then it eases back out.

// Practice bots — FREE/test lobbies ONLY (paid can never spawn them; see ss-spawn-bot). Anyone in the
// free lobby may spawn them. Caps are per-LOBBY, not per player.
const SS_MAX_CIRCLE_BOTS = 5;   // circle bots = the graze/cashout practice targets (owner: max 5)
const SS_MAX_BOTS        = 6;   // total backstop so fighters can't push past the circle cap

const SS_BORDER_SHRINK_STEP  = 0.05;   // shrink 5% per border death

const SS_BORDER_SHRINK_MAX   = 0.10;   // never shrink more than 10% total

const SS_BORDER_SHRINK_HOLD  = 5000;   // hold the shrink for 5s (refreshed by each new border death)

const SS_BORDER_SHRINK_IN    = SS_ARENA_R * 0.0022; // inward speed/tick (~4%/s) — not instant, but fast enough to catch a careless edge-looter

const SS_BORDER_SHRINK_OUT   = SS_ARENA_R * 0.0009; // outward ease-back/tick (~1.6%/s) — gentle return

// ── ROAMING ARENA: border-chase rate ───────────────────────────────────────────────────────
// MUST live here, not with the other SS_ROAM_* consts: those sit above `const SS_ARENA_R`, and a
// module-init reference to it from there throws "Cannot access 'SS_ARENA_R' before
// initialization" - which node --check does NOT catch, and which took both nodes down once.
//
// MEASURED on prod: SS_BORDER_SHRINK_OUT is 2.7px/tick = ~73px/s, so regaining the squeezed
// radius took 20.5s and the owner's 10s regrow could not physically happen (observed 19.7s). The
// same cap on the way in left the border bottoming at 55% of full instead of the intended depth.
// targetR is what enforces the timing; this only stops the chase being the bottleneck. The chase
// clamps to targetR, so a faster rate can never overshoot. Applies ONLY while roaming, so the
// death-shrink ease-back keeps its original gentle feel.
const SS_ROAM_TRACK     = SS_ARENA_R * 0.004;   // px/tick (~325px/s) while the arena is roaming
const SS_ROAM_SETTLE_MS = 3000;                 // safety cap on the 'settle' wait (see ssCampPush)

const SS_MAX_TURN      = 0.274;   // rad/tick — client MAX_TURN

const SS_FOOD_TARGET   = 68;     // client FOOD_TARGET

const SS_FOOD_PUSH_BONUS = 25;   // extra orbs held while the arena is sliding (owner: 70 was too much)

const SS_FOOD_GROW     = 2;       // client FOOD_GROW

const SS_BOOST_MIN     = 8;       // client BOOST_MIN (owner 2026-07-26: 12 -> 8)

const SS_BOOST_DRAIN_A = 3.0;    // client BOOST_DRAIN_AMT

const SS_BOOST_DRAIN_T = 8;      // client BOOST_DRAIN

const SS_INIT_NS       = 30;     // client INIT_SECTIONS (owner 2026-07-26: longer spawn)

const SS_MIN_NS        = 8;      // client MIN_SECTIONS

const SS_MAX_NS        = 300;    // client MAX_SECTIONS



// ── MoneySlither-exact 60-TPS simulation (ported verbatim from client.js) ─────

// The authoritative sim now runs at 60 Hz via SS_SUBSTEPS sub-steps per 30 Hz ssTick;

// network broadcast stays 30 Hz. Body size is continuous (`size`), ns/thickness derived.

const SS_DT            = 1 / 60;   // MoneySlither DT (TICK_RATE=60)

const SS_SUBSTEPS      = 2;        // 60 Hz sim ÷ 30 Hz ssTick

const SS_BASE_SPEED    = 288;      // px/s

const SS_BOOST_SPEED   = 630;      // px/s

const SS_BOOST_ACCEL   = 4.5;      // boostAmount ramp /s

const SS_TURN_PER_SEC  = 8.1;      // rad/s

// ── Circle detection (ss-test-lobby ONLY) — RELATIVE-rate model ───────────────────────────────────

// Adapts to how tightly the player circles (tight OR wide), so it arms on any real loop. Grazeable

// after ONE full rotation (circDeg), and drops the INSTANT the player leaves the circle — i.e. the

// current turn rate falls to < RELDROP of the loop's own established rate (opening the radius / slowing,

// even in the same direction), or goes nearly straight, or reverses. Never active unless circling NOW.

const SS_CIRC_MINRATE   = 0.02;   // rad/substep floor: below this you're going straight (not circling at all)

const SS_CIRC_RELDROP   = 0.70;   // if current turn < this × the loop's established rate → you've left the circle

const SS_CIRC_RATEDECAY = 0.97;   // EMA for the loop's established turn rate (slow → reflects the sustained circle)

const SS_CIRC_SLOWGRACE = 2;      // substeps out of the circle before winding fully resets (must re-loop to re-arm)

const SS_BOOST_BURN    = 0.18984375;    // size burn fraction /s while boosting

const SS_START_SIZE    = 100;      // size for a fresh snake (→ ns 26)

function ssSegForSize(size){ const sz=Math.max(SS_MIN_SIZE, Number(size)||SS_MIN_SIZE); let seg = 8 + (sz-40)*(26-8)/(100-40); if(sz>100) seg = 26 + (sz-100)*0.08; return Math.max(8, Math.round(seg)); }

function ssSizeFromNs(n){ n=Math.max(SS_MIN_NS, n); return n<=26 ? 40 + (n-8)*(100-40)/(26-8) : 100 + (n-26)/0.08; }

const SS_SHED_NE_MS    = 4000;   // client SHED_NOEAT_MS

// How far BEHIND the tail a boost-shed pellet lands. The pellet used to drop on the tail
// itself, so a boosting snake laid a dense trail directly under its own path and drove straight
// back through it on any curve. That, plus the old 4s owner lock, is the whole "I go through
// pebbles and pick up nothing" report. Dropping it back means recovering your own trail costs
// real travel, which is the anti-farm pressure the timer used to provide - without ever
// refusing a pickup.
const SS_SHED_DROP_BACK = 70;   // px beyond the tail, along the tail's own heading

const SS_FOOD_PICKUP_R      = 42;  // client FOOD_PICKUP_R

const SS_KILL_FOOD_PICKUP_R = 42;  // client KILL_FOOD_PICKUP_R



// ── Test lobby: deterministic bot scenarios ───────────────────────────────────

const SS_TEST_SCENARIOS = {

  'boost-cutoff': {

    // Cut-off geometry: pursuer east (boost) from (-63,0); leader south (no boost) from (0,-19.2).

    // Pursuer(east) first in Map order. Observe which stage (H2H vs H2B) resolves the kill.

    bots: [

      { id: 'bot-pursuer', color: '#FF4444', name: 'PURSUER',

        x: -63, y: 0, angle: 0, ns: 24,

        script: () => ({ angle: 0, boost: true }) },

      { id: 'bot-leader',  color: '#44FF44', name: 'LEADER',

        x: 0, y: -19.2, angle: Math.PI / 2, ns: 24,

        script: () => ({ angle: Math.PI / 2, boost: false }) }

    ]

  },

  'bug-cutoff': {

    // SAME geometry but LEADER is first in Map insertion order (eval-order probe).

    // With MoneySlither-exact single-pass H2B: if outcome differs from boost-cutoff, eval order matters.

    bots: [

      { id: 'bot-leader',  color: '#44FF44', name: 'LEADER',

        x: 0, y: -19.2, angle: Math.PI / 2, ns: 24,

        script: () => ({ angle: Math.PI / 2, boost: false }) },

      { id: 'bot-pursuer', color: '#FF4444', name: 'PURSUER',

        x: -63, y: 0, angle: 0, ns: 24,

        script: () => ({ angle: 0, boost: true }) }

    ]

  },

  'tight-cutoff': {

    // Shorter gap — collision happens faster; stress-tests H2B at crr boundary.

    bots: [

      { id: 'bot-pursuer', color: '#FF4444', name: 'PURSUER',

        x: 0,   y: 0, angle: 0, ns: 24,

        script: ()  => ({ angle: 0,            boost: true }) },

      { id: 'bot-leader',  color: '#44FF44', name: 'LEADER',

        x: 30,  y: 0, angle: 0, ns: 24,

        script: (t) => ({ angle: t < 3 ? 0 : -Math.PI / 2, boost: true }) }

    ]

  },

  'head-on': {

    // Pure head-on collision from opposite directions — tests H2H gate.

    bots: [

      { id: 'bot-left',  color: '#FF4444', name: 'BOT-L',

        x: -150, y: 0, angle: 0,        ns: 24,

        script: () => ({ angle: 0,        boost: false }) },

      { id: 'bot-right', color: '#4444FF', name: 'BOT-R',

        x:  150, y: 0, angle: Math.PI, ns: 24,

        script: () => ({ angle: Math.PI, boost: false }) }

    ]

  },

  'crossing': {

    // Perpendicular paths — one snake going right, one going down; stresses H2B order.

    bots: [

      { id: 'bot-horiz', color: '#FF4444', name: 'HORIZ',

        x: -200, y: 0,    angle: 0,           ns: 24,

        script: () => ({ angle: 0,           boost: true }) },

      { id: 'bot-vert',  color: '#4444FF', name: 'VERT',

        x: 0,    y: -200, angle: Math.PI / 2, ns: 24,

        script: () => ({ angle: Math.PI / 2, boost: true }) }

    ]

  }

};



function ssThick(n) {

  n = Math.max(1, Number(n) || 1);

  let t = 7.5 + 0.55 * Math.sqrt(n);

  if (n > 26) t += Math.pow(n - 26, 0.7) * 0.17;

  return Math.max(10, t * 1.43);

}

function ssAngleDiff(a, b) {

  let d = a - b;

  while (d > Math.PI)  d -= 2 * Math.PI;

  while (d < -Math.PI) d += 2 * Math.PI;

  return d;

}



// `lam` is the orb's share of a dead player's stake in LAMPORTS — the authoritative money figure.
// `w` is the same value in USD and exists only so the client can draw it; see the lamport ledger note.
function ssMakeFood(x, y, k, w, o, ne, lam) {

  if (x == null) {

    const a = Math.random() * Math.PI * 2;

    const r = Math.sqrt(Math.random()) * SS_ARENA_R * 0.9;

    x = Math.cos(a) * r; y = Math.sin(a) * r;

  }

  // Money orbs render 20% larger than ordinary pebbles (owner) so the two are never confused.

  const _sz = (4 + Math.random() * 3) * (k ? 1.2 : 1);

  return { x, y, ci: Math.floor(Math.random() * 20), size: _sz,

           k: k || 0, w: w || 0, o: o || null, ne: ne || 0, lam: lam || 0 };

}



// Best-candidate (Mitchell) sampling: generate K random candidates and keep the one

// whose nearest existing pebble is farthest away. Same count/density as pure random, but

// blue-noise spacing - pebbles spread evenly instead of clumping and leaving empty patches.

function ssMakeFoodSpread(sg) {

  const food = sg.food || [];

  const K = 12;

  let best = null, bestD = -1;
  let bFall = null, bFallD = -1;   // used only if nothing clears the snakes

  for (let c = 0; c < K; c++) {

    const a = Math.random() * Math.PI * 2;

    // Spawn relative to the arena CENTRE and its CURRENT radius, not the origin and the constant.

    // Once ssCampPush starts sliding the map, the newly-exposed side would otherwise be barren while

    // food piled up behind — new food now fills the area the ring actually covers, so density stays

    // what it is today no matter where the arena has moved to.

    const _fR = (sg.arenaR || SS_ARENA_R) * 0.9;

    const _fcx = sg.cx || 0, _fcy = sg.cy || 0;

    // While the ring is travelling, weight fresh food toward the side being uncovered (same reason

    // as the relocation above); otherwise spread it evenly.

    const _mvx = sg.cvx || 0, _mvy = sg.cvy || 0;

    const _aa = (_mvx || _mvy) ? (Math.atan2(_mvy, _mvx) + (Math.random() - 0.5) * Math.PI) : a;

    const r = (_mvx || _mvy) ? _fR * (0.45 + 0.5 * Math.sqrt(Math.random())) : Math.sqrt(Math.random()) * _fR;

    const x = _fcx + Math.cos(_aa) * r, y = _fcy + Math.sin(_aa) * r;

    let nd = Infinity;

    for (let i = 0; i < food.length; i++) {

      const dx = food[i].x - x, dy = food[i].y - y, d2 = dx * dx + dy * dy;

      if (d2 < nd) nd = d2;

    }

    /*
     * NEVER DROP FRESH FOOD ON A SNAKE. Candidates were scored ONLY on distance to other
     * FOOD, so a pebble could spawn inside a body - or straight into the trail of someone
     * boosting past. Require a real gap from every body node, and keep a fallback so
     * spawning can never stall if nothing clears (a crowded arena must still get food).
     * PERF: hot path. Stride so no snake costs more than ~40 checks, and bail out of both
     * loops the instant a candidate is disqualified.
     */
    let _clr = Infinity;
    for (const _s of sg.snakes.values()) {
      if (!_s.alive || !_s.path || !_s.path.length) continue;
      const _st = Math.max(1, Math.floor(_s.path.length / 40));
      for (let _p = 0; _p < _s.path.length; _p += _st) {
        const _nx = _s.path[_p].x - x, _ny = _s.path[_p].y - y;
        const _nd2 = _nx * _nx + _ny * _ny;
        if (_nd2 < _clr) _clr = _nd2;
        if (_clr < SS_FOOD_SNAKE_CLEAR2) break;
      }
      if (_clr < SS_FOOD_SNAKE_CLEAR2) break;
    }
    if (_clr >= SS_FOOD_SNAKE_CLEAR2) {
      if (nd > bestD) { bestD = nd; best = { x, y }; }
    } else if (nd > bFallD) { bFallD = nd; bFall = { x, y }; }

  }

  const _pick = best || bFall;
  return _pick ? ssMakeFood(_pick.x, _pick.y) : ssMakeFood();

}



function ssReconcileFood(sg) {

  // Regular food is NOT tied to the border. Gold food is — and that part is right.

  //

  // Gold/kill orbs are a dead player's real wager, so they are clamped inside the ring when created

  // and must never be moved or removed. Regular pebbles are scenery: they are laid down where the

  // arena was at the time and they STAY there. If the ring slides away from some, those simply go out

  // of play — they are not dragged along behind the border, which is what made the food look like it

  // was moving with the ring.

  //

  // What was wrong: the target got +SS_FOOD_PUSH_BONUS while the ring slid and nothing ever trimmed

  // the surplus, so a board pushed back and forth kept climbing. And the top-up counted food the ring

  // had already left behind, so the part you can actually play in went sparse — measured at one point:

  // 68 orbs on the board, only 27 of them reachable.

  //

  // So the target is measured on what is IN the ring (the playable area holds a constant amount,

  // moving or still), while a generous overall ceiling stops the stragglers accumulating forever.

  // Only the very furthest are dropped when that ceiling is hit, so nothing vanishes near the edge

  // where anyone could be looking at it.

  if (!sg.food) sg.food = [];

  const cx = (sg.cx || 0), cy = (sg.cy || 0), R = (sg.arenaR || SS_ARENA_R);

  const dist = f => Math.hypot((f.x || 0) - cx, (f.y || 0) - cy);

  let inRing = 0;

  sg.food.forEach(f => { if (f && !f.k && dist(f) <= R) inRing++; });

  while (inRing < SS_FOOD_TARGET + (sg.paid ? SS_FOOD_PAID_BONUS : 0)) { sg.food.push(ssMakeFoodSpread(sg)); inRing++; }

  const CEIL = Math.round((SS_FOOD_TARGET + (sg.paid ? SS_FOOD_PAID_BONUS : 0)) * 1.6);

  let plain = 0;

  sg.food.forEach(f => { if (f && !f.k) plain++; });

  if (plain > CEIL) {

    const out = [];

    for (let n = 0; n < sg.food.length; n++) {

      const f = sg.food[n];

      if (!f || f.k) continue;

      const d = dist(f);

      if (d > R) out.push([n, d]);          // only ever drop ones already out of play

    }

    out.sort((a, b) => b[1] - a[1]);        // furthest away first

    const drop = new Set();

    for (let n = 0; n < out.length && plain - drop.size > CEIL; n++) drop.add(out[n][0]);

    if (drop.size) sg.food = sg.food.filter((f, n) => !drop.has(n));

  }

}



function ssSpawnKillFood(sg, sn) {

  if (!sn) return;

  const path = (sn.path && sn.path.length) ? sn.path : [{ x: sn.x, y: sn.y }];

  // Spread the victim's wager as money orbs ALONG the snake's body (head->tail) at the exact

  // spot it died - a trail, NOT a pile. MORE orbs the bigger the snake was (scales with ns).

  // Every orb is clamped to just inside the arena border so kill food never lands outside

  // the ring - including when a snake dies right against the edge.

  const ns = sn.ns || SS_MIN_NS;

  const orbs = Math.max(2, Math.min(30, Math.round(ns / 4)));

  const wPerOrb = (sn.usd || 0) / orbs;

  // The same drop in lamports — the figure that actually decides what the eater can cash out.
  // Split with the remainder pushed onto the first orb so the orbs sum to EXACTLY what the snake
  // carried: plain integer division would destroy up to orbs-1 lamports of a dead player's stake on
  // every single kill, and that money would sit in escrow claimable by nobody (the "gold food just
  // disappeared" failure, one lamport at a time). Zeroed on the snake below so it can never drop twice.
  const carriedLam = ssLamCarried(sn);
  const lamPerOrb  = Math.floor(carriedLam / orbs);
  const lamExtra   = carriedLam - lamPerOrb * orbs;

  const EDGE = (sg.arenaR || SS_ARENA_R) - 30; // clamp to the CURRENT (possibly shrunk) border

  const bodyLen = Math.max(1, Math.min(path.length, (sn.ns || SS_MIN_NS) * SS_SEG_STEP));

  const step = bodyLen / orbs;

  for (let c = 0; c < orbs; c++) {

    const p = path[Math.min(bodyLen - 1, Math.floor(c * step))];

    let x = p.x + (Math.random() - 0.5) * 8;

    let y = p.y + (Math.random() - 0.5) * 8;

    const _kcx = sg.cx || 0, _kcy = sg.cy || 0;



    const _kdx = x - _kcx, _kdy = y - _kcy;



    const d = Math.sqrt(_kdx * _kdx + _kdy * _kdy);



    if (d > EDGE) { const s = EDGE / d; x = _kcx + _kdx * s; y = _kcy + _kdy * s; }

    sg.food.push(ssMakeFood(x, y, 1, wPerOrb, null, 0, lamPerOrb + (c === 0 ? lamExtra : 0)));

  }

  // The stake is on the floor now. Clear the ledger so a second call (ghost-kill timeout racing a
  // real kill, a disconnect shed after a death) cannot mint the same money a second time.
  sn._lamFood = 0; sn._lamBase = 0; sn._lamAuth = false;
  _stakeLam.delete(sn.pid);

}

// ── Unclaimed gold-food persistence (PAID lobbies only) ───────────────────────────────────────────
// Gold orbs are CLAIM TICKETS on money already pooled in escrow: when a player dies their deposit
// stays in the escrow account and their `pw:` record is deleted, so ONLY whoever eats the orbs can
// draw that value out. The room teardown (`ssGames.delete`) used to destroy sg.food along with the
// game — the SOL then sat in escrow permanently unclaimable by anyone, which is the "gold food just
// disappeared" bug. So: park the unclaimed orbs when a paid room empties, reclaim them when it
// reopens. This NEVER moves money — escrow is untouched here; we only persist the tickets.
//
// LOBBY-SCOPED BY CONSTRUCTION: the store key is per-lobby (foodpark:ss-paid-lobby-1 vs
// foodpark:ss-paid-lobby-5), and the lid is re-verified inside the payload, so money left in the $1
// lobby can only ever come back in the $1 lobby. Free/test lobbies are excluded: their food carries
// no wager (w=0) and regenerates on its own, so there is nothing of value to preserve.
function ssIsPaidLobby(lid) { return !!lid && lid.indexOf('ss-') === 0 && lid.indexOf('paid') !== -1; }

function ssFoodAuth(lid) {
  const ts = Date.now();
  return { ts, proof: crypto.createHmac('sha256', GAME_SECRET).update('food:' + lid + ':' + ts).digest('hex') };
}

// ── Authoritative LAMPORT ledger (paid lobbies) ───────────────────────────────────────────────────
// The value a snake carries used to originate in the player's own browser — `d.usd` on their first
// ssin (see ssHandleInput) — so nothing this server said about money was really this server's
// opinion, and /api/settle had to defend itself with a 20x cap on any cash-out claim. Two fields,
// kept apart on purpose:
//   _lamBase  the deposit api/join.js verified ON-CHAIN, read out of `pw:` via the stake-read action
//   _lamFood  lamports picked up as gold food — orbs spawned and priced by THIS process, never by a client
// carried = _lamBase + _lamFood, and that total is what the cash-out proof signs.
//
// LAMPORTS, not USD, because the payout is in SOL: a player is owed exactly the SOL they put in plus
// the SOL they took off other players, and no exchange-rate move between joining and cashing out can
// change that — which is also what keeps escrow able to cover every payout it owes. The client turns
// this into USD at the live price for display, so the figure over a snake's head still floats with SOL.
const _stakeLam = new Map();   // pid → authoritative deposit in lamports (KV `pw:`)

function ssStakeAuth() {
  const ts = Date.now();
  return { ts, proof: crypto.createHmac('sha256', GAME_SECRET).update('stake-read:' + ts).digest('hex') };
}

// Fire-and-forget by design. This is NEVER awaited in the connection handler: awaiting there would
// delay registering the socket's own event listeners, and a client's first packets would be dropped.
function ssFetchStake(pid) {
  if (!GAME_SECRET || !pid || String(pid).indexOf('bot-') === 0) return;
  const { ts, proof } = ssStakeAuth();
  const url = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify({ action: 'stake-read', addresses: [pid] }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.json()).then(d => {
    const lam = (d && d.stakes) ? Math.floor(Number(d.stakes[pid]) || 0) : 0;
    if (lam > 0) { _stakeLam.set(pid, lam); console.log('[stake] ' + String(pid).slice(0, 8) + ' = ' + lam + ' lamports'); }
    else console.warn('[stake] NO deposit on record for ' + String(pid).slice(0, 8) + ' — cash-out will fall back to the capped path');
  }).catch(e => console.warn('[stake] read failed for ' + String(pid).slice(0, 8) + ': ' + (e && e.message)));
}

/* Forfeit a vanished paid player's stake to the house. Fire-and-forget: the sweep is escrow-internal
 * bookkeeping, nobody is waiting on it, and /api/settle is idempotent (it GETDELs `pw:`), so a repeat
 * call costs nothing. Bots and free lobbies have no stake to forfeit. */
function ssForfeitStake(pid, lid) {
  if (!GAME_SECRET || !pid || String(pid).indexOf('bot-') === 0) return;
  const ts = Date.now();
  const proof = crypto.createHmac('sha256', GAME_SECRET).update('forfeit:' + pid + ':' + ts).digest('hex');
  const url = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify({ action: 'forfeit', playerAddress: pid, lobbyId: lid }),
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json()).then(d => {
    if (d && d.already) console.log(`[${lid}] forfeit ${String(pid).slice(0, 8)}: nothing owed (already resolved)`);
    else if (d && d.ok) console.log(`[${lid}] forfeit ${String(pid).slice(0, 8)}: swept ${d.amount || 0} to house`);
    else console.warn(`[${lid}] forfeit ${String(pid).slice(0, 8)} refused: ${(d && d.error) || 'unknown'}`);
  }).catch(e => console.warn(`[${lid}] forfeit call failed for ${String(pid).slice(0, 8)}: ${e && e.message}`));
}

// Adopt the authoritative deposit the moment it arrives. Because food winnings are banked separately
// in _lamFood, this can happen before OR after the snake has eaten anything and the total is the same
// either way — which is what makes the fire-and-forget fetch above safe.
function ssLamCarried(sn) {
  if (!sn) return 0;
  if (!sn._lamAuth) {
    const base = _stakeLam.get(sn.pid);
    if (base > 0) { sn._lamBase = base; sn._lamAuth = true; }
  }
  return sn._lamAuth ? Math.max(0, Math.floor((sn._lamBase || 0) + (sn._lamFood || 0))) : 0;
}

// Sign the cash-out total so /api/settle can pay it without trusting the player's browser. Returns
// null when the ledger is not authoritative (free lobby, bot, or the stake read never landed) — the
// caller then mints no proof and settle falls back to its old capped path rather than refusing a
// payout. Same HMAC trust model as the kill proofs and elim-lock.
function ssCashProof(sn, lid) {
  if (!GAME_SECRET || !sn) return null;
  const carried = ssLamCarried(sn);
  if (!sn._lamAuth || !(carried > 0)) return null;
  const ts = Date.now();
  const base = Math.floor(sn._lamBase || 0);
  const canon = 'cashout:' + sn.pid + ':' + lid + ':' + base + ':' + carried + ':' + ts;
  return { lam: carried, base, lobby: lid, ts,
           proof: crypto.createHmac('sha256', GAME_SECRET).update(canon).digest('hex') };
}

// Low-level: hand an explicit orb list to the store. Sending [] CLEARS the lobby's park, which is
// correct — it means nothing is left unclaimed here.
function ssParkOrbs(lid, orbs) {
  if (!ssIsPaidLobby(lid) || !GAME_SECRET) return;
  try {
    const { ts, proof } = ssFoodAuth(lid);
    const url = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
    fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
      body: JSON.stringify({ action: 'park-food', lid, orbs }), signal: AbortSignal.timeout(5000) })
      .then(() => { if (orbs.length) console.log(`[${lid}] parked ${orbs.length} unclaimed gold orbs`); })
      .catch(e => console.warn(`[${lid}] park-food failed: ${e.message}`));
  } catch (_) {}
}

// Called at teardown: persist whatever gold is still on the floor.
function ssParkFood(lid, sg) {
  if (!ssIsPaidLobby(lid) || !GAME_SECRET || !sg) return;
  const orbs = (sg.food || [])
    // Money orbs only; pebbles are worthless. An orb counts as money if EITHER figure is set — `lam`
    // is the one that decides a payout, so an orb carrying lamports must never be dropped from the
    // park just because its display value rounded to nothing.
    .filter(f => f && f.k && ((Number(f.w) || 0) > 0 || (Number(f.lam) || 0) > 0))
    .map(f => ({ x: f.x, y: f.y, w: f.w, lam: Math.floor(Number(f.lam) || 0) }));
  ssParkOrbs(lid, orbs);
}

// Called when a player joins: reclaim this lobby's parked gold.
// The store side uses GETDEL (atomic claim) so only ONE node/instance can ever take a given parked
// set — the same lobby id runs on BOTH the NA and EU nodes against ONE shared escrow, and restoring
// the same orbs on both would let two sets of players cash out the same SOL (escrow shortfall).
// Deliberate trade-off: if the claim response is lost in flight the tickets are lost (the SOL simply
// stays in escrow) rather than risking duplication — a lost ticket costs those players; a duplicated
// one costs the escrow and breaks everyone else's cashout. Fail toward no-duplication, like settle.
function ssRestoreParkedFood(lid, sg) {
  if (!ssIsPaidLobby(lid) || !GAME_SECRET || !sg || sg._foodRestored) return;
  sg._foodRestored = true;   // set SYNCHRONOUSLY: a second joiner in the same tick must not re-claim
  try {
    const { ts, proof } = ssFoodAuth(lid);
    const url = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
    fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
      body: JSON.stringify({ action: 'get-food', lid }), signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(j => {
        const orbs = (j && Array.isArray(j.orbs)) ? j.orbs : [];
        if (!orbs.length) return;
        const g = ssGames.get(lid);
        // Room already torn down again while we were fetching — we've CLAIMED (deleted) the park, so
        // put it straight back or the money would be orphaned.
        if (!g) { ssParkOrbs(lid, orbs); return; }
        if (!g.food) g.food = [];
        // Clamp to the CURRENT (possibly shrunk) border so restored money always lands where players
        // can actually reach it, never outside the ring. ssTick's shrink sweep keeps it in from here.
        const EDGE = (g.arenaR || SS_ARENA_R) - 30;
        for (const o of orbs) {
          let x = Number(o.x) || 0, y = Number(o.y) || 0;
          const w = Number(o.w) || 0;
          const lam = Math.floor(Number(o.lam) || 0);
          if (!(w > 0 || lam > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          const d = Math.sqrt(x * x + y * y);
          if (d > EDGE && d > 0) { const s = EDGE / d; x *= s; y *= s; }
          g.food.push(ssMakeFood(x, y, 1, w, null, 0, lam));
        }
        g._foodDirty = true;
        console.log(`[${lid}] restored ${orbs.length} parked gold orbs`);
      })
      .catch(e => console.warn(`[${lid}] get-food failed: ${e.message}`));
  } catch (_) {}
}



function ssFindSafeSpawn(sg) {

  // Spawn placement = the emptiest spot inside the LIVE arena.

  //

  // The old version drew a point at SS_ARENA_R * [0.22 .. 0.78] around the ORIGIN and measured only

  // the distance to other snakes' HEADS. Both halves stopped being true once the border started

  // moving:

  //   * The arena is a circle at (sg.cx, sg.cy) with radius sg.arenaR. The anti-camp push slides that

  //     centre up to SS_CAMP_MAXOFF_D (3000) from the origin and the ring shrinks by up to 55%

  //     (0.10 border-death + 0.45 camp), so the playable circle can be 1350 wide and sitting entirely

  //     to one side of the origin. A point drawn 2340 from the ORIGIN is then usually OUTSIDE it —

  //     which is players 'spawning into the moving border' and dying on arrival.

  //   * A snake is a BODY, not a point. Being 900 from someone's head means nothing when their tail

  //     is lying across the square you just landed on, so head-only distance did not prevent a

  //     spawn kill either.

  //

  // Now: score candidate points across the live circle by their CLEARANCE — the distance to the

  // nearest thing that can kill them, wall or snake — and take the best one. That is exactly 'as far

  // from the border and from everyone else as this arena allows'. No spawn immunity is involved;

  // the position is simply correct.

  const cx = sg.cx || 0, cy = sg.cy || 0;

  const aR = sg.arenaR || SS_ARENA_R;

  // The ring closes at SS_BORDER_SHRINK_IN per tick, so landing just inside it is still spawning into

  // the border, only a second later. Clearance is credited beyond this margin, never inside it.

  const wallMin = Math.max(300, aR * 0.28);

  // Everything that can kill a spawn: each alive snake's head plus its body, sampled along the same

  // path the H2B collision loop reads. A coarse stride is right here — we are measuring hundreds of

  // units of clearance, not testing an overlap — and it keeps the cost flat however long snakes get.

  const occ = [];

  sg.snakes.forEach(sn => {

    if (!sn.alive) return;

    occ.push(sn.x, sn.y);

    // THE ROAD AHEAD COUNTS AS OCCUPIED. Scoring only on where snakes ARE meant the emptiest
    // square was often the one someone was about to drive through - you spawned directly in
    // front of a face and died to a head-on you never saw. Worst while the arena is moving,
    // since the squeeze crowds every candidate together. Project the head forward along its own
    // heading so being in the path is penalised exactly like being on top of them.
    const _fa = (typeof sn.angle === 'number') ? sn.angle : 0;
    const _fcos = Math.cos(_fa), _fsin = Math.sin(_fa);
    for (let _d = 160; _d <= 640; _d += 160) occ.push(sn.x + _fcos * _d, sn.y + _fsin * _d);

    const path = sn.path;

    if (!path || !path.length) return;

    const spacing = ssSegSpacing(sn.ns);

    const stride = Math.max(1, Math.ceil(48 / Math.max(1, spacing)));   // ~one sample per 48px of body

    const lim = Math.min(sn.ns, 1200);

    for (let k = 2; k < lim; k += stride) {

      const pt = path[Math.round(k * spacing / SS_POINT_DIST)];

      if (pt) occ.push(pt.x, pt.y);

    }

  });

  // Concentric rings of candidates out to the last radius that still clears the wall, rotated by a

  // random phase so two players joining in the same second are not handed the same square.

  const usable = Math.max(0, aR - wallMin);

  const phase = Math.random() * Math.PI * 2;

  const RINGS = 6;

  let best = null, bestScore = -Infinity;

  for (let ring = 0; ring <= RINGS; ring++) {

    const rr = usable * (ring / RINGS);

    const n = ring === 0 ? 1 : ring * 6;

    for (let s = 0; s < n; s++) {

      const a = phase + (s / n) * Math.PI * 2 + ring * 0.7;

      const sx = cx + Math.cos(a) * rr, sy = cy + Math.sin(a) * rr;

      let clear = usable - rr;                       // room to the wall, past the safety margin
      // THE RING IS A MOVING TARGET. A spot safely inside the circle now can be left outside it
      // seconds later, because the border walks up to SS_ROAM_HOP_MAX away while closing. So
      // while it is travelling, also measure to the DESTINATION circle's edge and keep the worse
      // of the two: the winning spot then lies in the overlap of where the arena is and where it
      // is going - the only ground that stays playable for the whole hop.
      if (sg.roamPhase === 'moving' && sg.roamToX != null) {
        const _ddx = sg.roamToX - sx, _ddy = sg.roamToY - sy;
        const _dEdge = (sg.roamEndR || aR) - Math.sqrt(_ddx * _ddx + _ddy * _ddy);
        if (_dEdge < clear) clear = _dEdge;
      }

      for (let i = 0; i < occ.length; i += 2) {

        const dx = occ[i] - sx, dy = occ[i + 1] - sy;

        const d = Math.sqrt(dx * dx + dy * dy);

        if (d < clear) clear = d;

        if (clear <= bestScore) break;               // already beaten — stop measuring this candidate

      }

      if (clear > bestScore) { bestScore = clear; best = [sx, sy]; }

    }

  }

  return best || [cx, cy];

}



function ssSpawnSnake(pid, color, name, sg) {

  let sx, sy;

  if (sg) { [sx, sy] = ssFindSafeSpawn(sg); }

  else {

    // No arena object at all (shouldn't happen for a real join) — the origin IS the centre here.

    const a = Math.random() * Math.PI * 2;

    const r = SS_ARENA_R * (0.22 + Math.random() * 0.56);

    sx = Math.cos(a) * r; sy = Math.sin(a) * r;

  }

  // Face the LIVE arena centre, not the origin. Once the anti-camp push has slid the ring away the

  // origin can be well outside the playable circle, so facing it aimed a fresh spawn AT the wall —

  // and the seeded tail behind the head pointed inward, the wrong way round.

  // FACE WHERE THE ARENA IS GOING, NOT WHERE IT IS. Aiming a fresh spawn at the CURRENT centre
  // is wrong the moment the ring is travelling: that centre is walking away, so you get pointed
  // at ground the border is about to sweep over - i.e. spawned facing straight into a moving
  // wall - and the seeded tail is laid into the closing edge. Aim at the DESTINATION centre
  // instead, so a new player starts out running with the map. Falls back to the live centre
  // whenever the ring is parked (settle/regrow/hold), which is the old behaviour.
  const _roamAim = !!(sg && sg.roamPhase === 'moving' && sg.roamToX != null);
  const _sfcx = sg ? (_roamAim ? sg.roamToX : (sg.cx || 0)) : 0;
  const _sfcy = sg ? (_roamAim ? sg.roamToY : (sg.cy || 0)) : 0;

  const _sfdx = _sfcx - sx, _sfdy = _sfcy - sy;

  const face = (_sfdx * _sfdx + _sfdy * _sfdy) < 1 ? Math.random() * Math.PI * 2 : Math.atan2(_sfdy, _sfdx);

  const ns = SS_INIT_NS;

  // MoneySlither: path entries at POINT_DIST=1.6px, maxPath=max(800, numSegments*SEGMENT_SPACING_TICKS+200)

  const maxPath = Math.max(800, Math.ceil(ns * ssSectionRadius(ns) * 0.5 / SS_POINT_DIST) + 200);

  const path = [];

  for (let i = 0; i < maxPath; i++)

    path.push({ x: sx - Math.cos(face) * i * SS_POINT_DIST, y: sy - Math.sin(face) * i * SS_POINT_DIST });

  return {

    pid, color: color || '#FFD700', name: name || 'SNAKE',

    x: sx, y: sy, angle: face, targetAngle: face, circling: false,

    size: ssSizeFromNs(ns), ns, thick: ssThick(ns), path,

    boostAmount: 0, _lastPathX: sx, _lastPathY: sy, _pathAcc: 0,

    growQueue: 0, _shed: 0,

    alive: true, boost: false, score: 0, usd: 0, lastTs: Date.now()

  };

}



function ssSpawnBots(sg, scenario) {

  const def = SS_TEST_SCENARIOS[scenario];

  if (!def) throw new Error(`Unknown test scenario: ${scenario}`);

  def.bots.forEach(bd => {

    const path = [{ x: bd.x, y: bd.y }]; // single entry — no phantom body at spawn

    const sn = {

      pid: bd.id, color: bd.color, name: bd.name,

      x: bd.x, y: bd.y, angle: bd.angle, targetAngle: bd.angle,

      faceAngle: bd.angle, circling: false,

      size: ssSizeFromNs(bd.ns), ns: bd.ns, thick: ssThick(bd.ns), path,

      boostAmount: 0, _lastPathX: bd.x, _lastPathY: bd.y, _pathAcc: 0,

      growQueue: 0, _shed: 0,

      alive: true, boost: false, score: 0, usd: 0,

      lastTs: Date.now(),

      bot: true, _botTick: 0, _botScript: bd.script

    };

    sg.snakes.set(bd.id, sn);

    console.log(`[bot] spawned ${bd.id} at (${bd.x},${bd.y}) angle=${bd.angle.toFixed(3)}`);

  });

}



function ssGetSegsFromPath(sn) {

  if (!sn.path || !sn.path.length) return [];

  const r = ssSectionRadius(sn.ns), spacing = r * 0.5;

  // Cover the full kept-path arc (ns visible segs + tail buffer) so circling snakes

  // have their complete coil checked in H2B — not just the first 58% of one loop.

  const maxSegs = sn.ns + Math.ceil((4 * r + 80) / spacing) + 2;

  const pts = [[Math.round(sn.x), Math.round(sn.y)]];

  let cum = 0;

  for (let o = 0; o + 1 < sn.path.length && pts.length < maxSegs; o++) {

    const dx = sn.path[o + 1].x - sn.path[o].x, dy = sn.path[o + 1].y - sn.path[o].y;

    const d = Math.hypot(dx, dy);

    if (d > 0) {

      while (pts.length < maxSegs && cum + d >= spacing * pts.length) {

        const f = (spacing * pts.length - cum) / d;

        pts.push([Math.round(sn.path[o].x + f * dx), Math.round(sn.path[o].y + f * dy)]);

      }

    }

    cum += d;

  }

  return pts;

}



const ssGames = new Map(); // lobbyId → { snakes: Map(pid→snake), tickInterval, tuning }



function getSsGame(lid) {

  if (!ssGames.has(lid)) ssGames.set(lid, {

    snakes: new Map(), tickInterval: null, tick: 0,
    og: ssIsOgLobby(lid),   // ORIGINAL mode: static arena + camper push, no roam, no respread

    food: [], _foodDirty: true, _lastFoodSend: 0, _history: [],

    arenaR: SS_ARENA_R, shrinkPct: 0, shrinkResetAt: 0, // dynamic border state

    testHitbox: lid === SS_TEST_LOBBY, // test sandbox EXTRAS only (boost drain, food-shed, circle-viz)
    paid: /paid-lobby/.test(String(lid)),   // paid lobbies stock extra food

    noseCollision: true,

    tuning: { ...SS_TUNING_DEFAULT }   // inherits the owner's live tuning; see ss-tune

  });

  return ssGames.get(lid);

}



function ssSegSpacing(ns) {

  return ssSectionRadius(ns) * 0.5; // damnbruh formula: sectionRadius * SEGMENT_SPACING(0.5)

}

function ssSectionRadius(ns) {

  return 8 + Math.pow(ns * 5, 0.6) * 0.8;

}



// ssHandleInput: receive direction/boost input — server owns position, no x/y needed from client

function ssHandleInput(lid, pid, d, io) {

  const sg = getSsGame(lid);

  let sn = sg.snakes.get(pid);

  // Player is (re)sending input -> they're present again. Un-freeze immediately — this is the

  // ONLY place a resumed connection is detected for SS games (see ssTick's grace-window check).

  if (sn && sn.disconnected) { sn.disconnected = false; sn.disconnectedAt = null; }

  if (!sn || (!sn.alive && (!sn._killedAt || Date.now() - sn._killedAt > 2000))) {

    // First input OR dead snake rejoin (2s cooldown prevents revival from in-flight packets)

    sn = ssSpawnSnake(pid, (sn && sn.color) || d.color || '#FFD700', (sn && sn.name) || d.name || 'SNAKE', sg);

    if (d.usd != null && typeof d.usd === 'number' && sn.usd === 0) { sn.usd = Math.max(0, d.usd); sn.baseUsd = sn.usd; }

    // JOIN LENGTH IS ALWAYS SS_INIT_NS (17) — practice, free and paid alike. ssSpawnSnake already sets
    // it; nothing may raise it here. This used to honour a client-declared `d.ns` (clamped to the wager
    // cap), so a fresh spawn could start LONGER than 17 — and the client's own default was `ns: ...||26`,
    // so a join with no local snake yet literally asked for 26. Length is now earned in-game only, and a
    // client can no longer declare its own size at all (the cap-bypass surface is gone with it).
    // NOTE this does NOT affect a refresh/reconnect: that snake still exists and is alive, so this
    // whole spawn branch is skipped and the player resumes their real server-side length. Only genuine
    // fresh spawns and post-death respawns come through here, and both correctly start at 17.

    // A fresh life wipes any recorded exit: fate is keyed by pid and is otherwise never

    // cleared, so a stale 'already out' record from an earlier death in this lobby would

    // decide a later duel/outlast against the player who is actually still alive.

    try { if (wgEnabled(lid)) wgLobby(lid).fate.delete(String(pid)); } catch (_) {}

    sg.snakes.set(pid, sn);

    if (!sg.food || !sg.food.length) ssReconcileFood(sg);

    // Paid lobbies: reclaim any gold left on the floor when THIS lobby last emptied (once per game).
    ssRestoreParkedFood(lid, sg);

    if (!sg.tickInterval) {

      sg.tickInterval = setInterval(() => ssTick(lid, io), TICK_MS);

      console.log(`[${lid}] ss game loop started`);

    }

    return;

  }

  if (!sn.alive) return; // within 2s death cooldown — ignore

  sn.lastTs = Date.now();

  // Cashout (server-authoritative, LOCKS once started): first cash=1 begins a forced auto-circle + 6s
  // server timer (ssTick pays it & emits ss-cashout-done). While cashing we ignore ALL further input
  // (steer/boost/cancel) so it can't be aborted; a kill before 6s resolves it as a death (see ssKill).
  if (sn.cashing) {
    sn.circling = true; sn.targetAngle = null; sn.boost = false;
  } else if (d.cash) {
    sn.cashing = true; sn._cashResolved = null;
    sn._cashStart = null; sn._cashWound = 0; sn._cashPX = undefined; // 4s timer starts only once fully wound in (ssTick)
    sn.circling = true; sn.targetAngle = null; sn.boost = false;
  } else {
    if (d.circle) {
      sn.circling = true;
      sn.targetAngle = null;
    } else {
      sn.circling = false;
      if (typeof d.angle === 'number') sn.targetAngle = d.angle;
    }
    sn.boost = !!d.boost && sn.ns > SS_BOOST_MIN;
  }

  if (d.color) sn.color = d.color;

  if (d.name)  sn.name  = d.name;

  // Store client's reported facing angle for H2H gate (client angle is lag-free vs server's 1-2 tick lag)

  if (typeof d.angle === 'number') sn.faceAngle = d.angle;

}



// Socket-level disconnect (refresh / reload / brief blip). Does NOT kill or freeze the snake — it keeps

// MOVING in a straight line along its last heading and stays FULLY COLLIDABLE (see ssTick / the collision

// filters), so (a) a refreshing player resumes their real body still gliding forward instead of a frozen

// stub, and (b) nobody can abuse disconnect as an invulnerable "freeze in place" to dodge a fight. On

// any fresh input (reconnect) ssHandleInput clears sn.disconnected and control resumes seamlessly. Only

// if SS_DISCONNECT_GRACE_MS fully elapses with no reconnect does ssTick forfeit (wager → food).

function ssPlayerLeft(lid, pid, io) {

  const sg = ssGames.get(lid);

  if (!sg) return;

  const sn = sg.snakes.get(pid);

  if (sn && sn.alive && !sn.disconnected) {

    console.log('disconnected (coasting straight, grace pending)', pid, sn.ns, Date.now());

    sn.disconnected = true; sn.disconnectedAt = Date.now();

    sn.circling = false; sn.targetAngle = null; sn.boost = false; // coast straight on the last heading

  }

}



// Immediate forfeit-on-leave for SS: the player actually left the page (refresh / closed the tab /

// navigated away, or explicitly emitted 'ss-quit'), so they die RIGHT WHERE THEY WERE and their

// wager drops as collectable money-food — the EXACT same death path as any kill (ssKill spreads

// sn.usd as food + broadcasts 'elim'), so it behaves identically to dying in a fight. We do NOT

// tear the game down or delete the snake here: the dead entry lingers exactly like any kill (not

// broadcast, not collidable, pruned normally) so the food actually broadcasts to the other players

// before anything gets cleaned up. Reconnect is blocked separately by the single-use-token gate

// (the caller marks room.players[pid].alive = false). Idempotent — ssKill no-ops if already dead.

function ssForfeitNow(lid, pid, io) {

  const sg = ssGames.get(lid);

  if (!sg) return;

  const sn = sg.snakes.get(pid);

  if (sn && sn.alive) {

    console.log(`[${lid}] ${pid} left the page — forfeit death, wager drops as food`);

    ssKill(sn, null, lid, io);

  }

}



// ── MoneySlither stepMovement port — ONE 60 Hz sub-step (verbatim from client.js) ──

// Continuous `size` is authoritative; ns/thickness derived. Chord-based path sampling.

// Wager-scaled growth cap breakpoints. Keep in sync with SS_CAP_* / ssCapFromRatio in the
// client (slither-snakes.html); the server is authoritative, the client only predicts.
const SS_CAP_BASE   = 43;   // carrying just your entry wager (1x) — spawn(30) + 13 headroom
const SS_CAP_DOUBLE = 58;   // double the entry wager (2x)
const SS_CAP_MAX    = 63;   // triple (3x) and the hard ceiling beyond it
// ZONE WARS runs a much tighter ladder (owner 2026-07-31). Base is the SPAWN size, so a base-
// wager snake in Zone Wars does not grow at all - growth is something you only get by carrying
// more than you paid in. Confirmed intended. ORIGINAL keeps the numbers above untouched.
const SS_ZW_CAP_BASE   = 30;
const SS_ZW_CAP_DOUBLE = 40;
const SS_ZW_CAP_MAX    = 50;
// Growth cap by how many ENTRY WAGERS you are carrying (r = usd / entry wager).
// r<=1 (just your entry) => 30; 2x => 45; 3x => 50; beyond 3x => still 50 (hard ceiling).
// Two legs by design: +15/wager up to double, then +5/wager to triple.
// Only physical SIZE is limited here - money (usd) is uncapped and keeps growing past this.
function ssCapFromRatio(r, zw) {
  const B = zw ? SS_ZW_CAP_BASE : SS_CAP_BASE;
  const D = zw ? SS_ZW_CAP_DOUBLE : SS_CAP_DOUBLE;
  const M = zw ? SS_ZW_CAP_MAX : SS_CAP_MAX;
  if (!isFinite(r) || r <= 1) return B;
  if (r <= 2) return Math.round(B + (D - B) * (r - 1));   // linear base->double
  if (r <= 3) return Math.round(D + (M - D) * (r - 2));   // linear double->triple
  return M;
}
// sg is REQUIRED: the cap ladder differs per mode, and the mode lives on the game, not the
// snake. Both call sites already have it in scope. Missing sg falls back to ORIGINAL's ladder,
// which is the wider one, so a future caller that forgets it cannot silently shrink anybody.
function ssGrowCap(sn, sg) {
  // PREVIOUS BUG: this used `base` (the lobby entry price) not `usd` (what you carry), so a $1
  // lobby was locked at 30 forever no matter how much money you picked up. Now ratio-based.
  const base = sn.baseUsd || 0, usd = sn.usd || 0;   // baseUsd = entry wager; 0 = free lobby
  const zw = !!(sg && !sg.og);   // Zone Wars ladder; ORIGINAL keeps the old one
  if (base <= 0) return zw ? SS_ZW_CAP_MAX : SS_CAP_MAX;   // free lobby: the mode's own ceiling
  return ssCapFromRatio(usd / base, zw);
}



function ssStepMovement(sn, sg, lid, io, now) {

  // stepTurning: angle += sign(diff)*min(|diff|, TURN_SPEED_PER_SEC*DT)

  if (sn.circling) {

    sn.angle += SS_TURN_PER_SEC * SS_DT;

  } else if (typeof sn.targetAngle === 'number') {

    const diff = ssAngleDiff(sn.targetAngle, sn.angle);

    sn.angle += Math.sign(diff) * Math.min(Math.abs(diff), SS_TURN_PER_SEC * SS_DT);

  }

  while (sn.angle >  Math.PI) sn.angle -= 2 * Math.PI;

  while (sn.angle < -Math.PI) sn.angle += 2 * Math.PI;



  // Circle detection (test lobby only) — updates sn.circleActive via the loop state machine.

  if (sg.noseCollision) ssUpdateCircleState(sn, sg);



  // Boost ramp: speed = BASE + (BOOST-BASE)*boostAmount

  if (sn.boost && sn.size > SS_MIN_SIZE) sn.boostAmount = Math.min(1, (sn.boostAmount || 0) + SS_BOOST_ACCEL * SS_DT);

  else                                   sn.boostAmount = Math.max(0, (sn.boostAmount || 0) - SS_BOOST_ACCEL * SS_DT);

  const speed = SS_BASE_SPEED + (SS_BOOST_SPEED - SS_BASE_SPEED) * sn.boostAmount;



  // Advance head

  sn.x += Math.cos(sn.angle) * speed * SS_DT;

  sn.y += Math.sin(sn.angle) * speed * SS_DT;

  {

    const aR = sg.arenaR || SS_ARENA_R;

    // Measured from the arena's (possibly pushed) centre — this is what makes the advancing wall

    // actually lethal to a camper instead of just looking like it moved. See ssCampPush.

    const _bx = sn.x - (sg.cx || 0), _by = sn.y - (sg.cy || 0);

    if (_bx * _bx + _by * _by >= aR * aR) {

      // Death to the border → close the arena in a bit more (capped), and (re)start the hold clock.

      sg.shrinkPct = Math.min(SS_BORDER_SHRINK_MAX, (sg.shrinkPct || 0) + SS_BORDER_SHRINK_STEP);

      sg.shrinkResetAt = now + SS_BORDER_SHRINK_HOLD;

      ssKill(sn, null, lid, io); return;

    }

  }



  // Distance-sampled path: _pathAcc += chord distance; advance _lastPath along the chord

  const dxp = sn.x - sn._lastPathX, dyp = sn.y - sn._lastPathY, d = Math.sqrt(dxp*dxp + dyp*dyp);

  if (d > 0) {

    sn._pathAcc = (sn._pathAcc || 0) + d;

    const ux = dxp / d, uy = dyp / d;

    while (sn._pathAcc >= SS_POINT_DIST) {

      sn._lastPathX += ux * SS_POINT_DIST; sn._lastPathY += uy * SS_POINT_DIST;

      sn.path.unshift({ x: sn._lastPathX, y: sn._lastPathY });

      sn._pathAcc -= SS_POINT_DIST;

    }

  }

  const maxPath = Math.max(800, Math.ceil(sn.ns * ssSectionRadius(sn.ns) * 0.5 / SS_POINT_DIST) + 200);

  while (sn.path.length > maxPath) sn.path.pop();

  if (SS_BODY_SYNC) ssUpdateRenderTrail(sn); // Option A: update client render-trail (no-op when flag OFF)



  // Growth: drain growQueue (each unit = +1 segment worth of size) — preserves food economy.

  // Runs every tick regardless of boost. (A prior version skipped this while boosting to stop a

  // growQueue backlog from refilling ns as fast as boost-burn removed it -- but that backlog is

  // now prevented at the source: the food-pickup phase never queues growth past the cap in the

  // first place. Gating this on boost was too broad -- it deferred ALL growth earned while

  // boosting, of any size, which then dumped in as a sudden lump the instant boost stopped

  // (e.g. auto-disabling at BOOST_MIN=12) -- the "random length appears at low size" bug.)

  const _growCap = ssGrowCap(sn, sg);

  while ((sn.growQueue || 0) > 0 && sn.ns < _growCap) {

    sn.growQueue--;

    sn.size += (ssSizeFromNs(sn.ns + 1) - ssSizeFromNs(sn.ns));

    sn.ns = ssSegForSize(sn.size);

  }



  // Boost burn: size -= size*BURN*DT (continuous) + shed a pellet per whole segment lost.

  // TEST LOBBY ONLY: drain +20% (so boost-circling is a net LENGTH LOSS — you can't farm length by

  // boosting), and drop only HALF as many trail pebbles (still leaves a trail, just thinner). Other

  // lobbies keep the current tuning untouched.

  if (sn.boost) {

    if (sn.size <= SS_MIN_SIZE) { sn.boost = false; }

    else {

      const burn = sg.testHitbox ? SS_BOOST_BURN * 1.2 : SS_BOOST_BURN;

      const shedEvery = sg.testHitbox ? SS_FOOD_GROW * 2 : SS_FOOD_GROW;

      const beforeNs = sn.ns;

      sn.size = Math.max(SS_MIN_SIZE, sn.size - sn.size * burn * SS_DT);

      sn.ns = ssSegForSize(sn.size);

      sn._shed = (sn._shed || 0) + (beforeNs - sn.ns);

      while (sn._shed >= shedEvery) {

        sn._shed -= shedEvery;

        // Land the pellet BEHIND the tail, along the tail's own heading, and with NO no-eat lock:
        // your own trail is food like anyone else's. The growth cap (checked in the pickup loop)
        // is now the ONLY thing that may ever refuse a pebble.
        const tail = sn.path[sn.path.length - 1] || { x: sn.x, y: sn.y };
        const prev = sn.path[sn.path.length - 2] || tail;
        let _sdx = tail.x - prev.x, _sdy = tail.y - prev.y;
        const _sdl = Math.hypot(_sdx, _sdy);
        if (_sdl > 0.0001) { _sdx /= _sdl; _sdy /= _sdl; } else { _sdx = 0; _sdy = 0; }
        sg.food.push(ssMakeFood(
          tail.x + _sdx * SS_SHED_DROP_BACK + (Math.random()-0.5)*6,
          tail.y + _sdy * SS_SHED_DROP_BACK + (Math.random()-0.5)*6,
          0, 0, sn.pid, 0));   // ne = 0 -> never blocked by the shed cooldown

        sg._foodDirty = true;

      }

    }

  }

  sn.thick = ssThick(sn.ns);

  if (sn.ns < SS_MIN_NS) { ssKill(sn, null, lid, io); }

}



// Squared distance from point P to segment A->B. Used so food pickup covers the whole

// path the head swept this tick (up to ~21px at boost), not just its final point -

// otherwise a fast head tunnels straight through a pebble between discrete checks.

function ssPtSegD2(px, py, ax, ay, bx, by) {

  const abx = bx - ax, aby = by - ay;

  const ab2 = abx * abx + aby * aby;

  let t = ab2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / ab2 : 0;

  if (t < 0) t = 0; else if (t > 1) t = 1;

  const cx = ax + abx * t, cy = ay + aby * t, dx = px - cx, dy = py - cy;

  return dx * dx + dy * dy;

}



function ssTick(lid, io) {

  const sg = ssGames.get(lid);

  if (!sg) return;

  sg.tick = (sg.tick || 0) + 1;

  const now = Date.now();

  if (!sg.food || !sg.food.length) ssReconcileFood(sg);



  // ── Dynamic border: ease the arena radius toward its target and keep food inside it ──

  if (sg.arenaR == null) sg.arenaR = SS_ARENA_R;

  // Anti-camp: slide the arena centre away from anyone holding a circle past the trigger.

  try { ssCampPush(sg, 1 / 60); } catch (e) { /* never let this break the sim */ }

  if ((sg.shrinkPct || 0) > 0 && now > (sg.shrinkResetAt || 0)) sg.shrinkPct = 0; // hold expired → ease back out

  {

    // campShrinkPct is the anti-camp concentric squeeze (see ssCampPush) — it rides on top of the

    // existing death-driven shrink and uses the same smooth chase below.

    const targetR = SS_ARENA_R * (1 - Math.min(0.8, (sg.shrinkPct || 0) + (sg.campShrinkPct || 0)));

    // While roaming, track targetR tightly so the cycle's timing is what players actually see;
    // otherwise keep the original gentle death-shrink ease exactly as it was.
    const _roaming = sg.roamPhase && sg.roamPhase !== 'hold';
    const _inRate  = _roaming ? Math.max(SS_BORDER_SHRINK_IN, SS_ROAM_TRACK)  : SS_BORDER_SHRINK_IN;
    const _outRate = _roaming ? Math.max(SS_BORDER_SHRINK_OUT, SS_ROAM_TRACK) : SS_BORDER_SHRINK_OUT;
    if (sg.arenaR > targetR)      sg.arenaR = Math.max(targetR, sg.arenaR - _inRate);  // closing in

    else if (sg.arenaR < targetR) sg.arenaR = Math.min(targetR, sg.arenaR + _outRate); // opening back

    // Gold/SOL kill food and pebbles must never sit outside the map — push anything the shrinking

    // border has passed back inside its edge (so the closing ring visibly sweeps the money inward).

    const edge = sg.arenaR - 20;

    if (sg.food && sg.food.length && edge > 0) {

      const e2 = edge * edge;

      const _fcx = sg.cx || 0, _fcy = sg.cy || 0;

      for (const f of sg.food) {

        const _dx = f.x - _fcx, _dy = f.y - _fcy;

        const d2 = _dx * _dx + _dy * _dy;

        if (d2 > e2) {

          // RELOCATE, do not clamp. Scaling an out-of-bounds orb onto the edge circle piles EVERY

          // displaced orb into one dense arc on the trailing side while the rest of the map goes

          // bare — very visible now that the anti-camp push slides the whole ring. Dropping it at a

          // fresh uniform point inside the ring (sqrt for equal-area) keeps the count identical and

          // the spread even. Money orbs stay in play, they just move.

          // MONEY ORBS ARE NEVER TELEPORTED. They are claim tickets on real SOL, so a player has to

          // be able to go and get the money where it dropped. Pull them just inside the edge — they

          // bunch against the border as it sweeps past, which is the readable, expected behaviour

          // and what the relocation above accidentally broke. Only ordinary pebbles get spread.

          if (f.k) {

            const _s = edge / Math.sqrt(d2);

            f.x = _fcx + _dx * _s; f.y = _fcy + _dy * _s;

            sg._foodDirty = true;

            continue;

          }

          const _mvx = sg.cvx || 0, _mvy = sg.cvy || 0;

          let _ra, _rr;

          if (_mvx || _mvy) {

            // MOVING: drop it into the leading half (+/-90 degrees of travel) and out in the outer

            // band, which is the ground the ring has just uncovered. Without this the fresh side

            // stays visibly bare because a uniform scatter only lands a slice of the orbs there.

            const _mAng = Math.atan2(_mvy, _mvx);

            _ra = _mAng + (Math.random() - 0.5) * Math.PI;

            _rr = edge * (0.45 + 0.47 * Math.sqrt(Math.random()));

          } else {

            _ra = Math.random() * Math.PI * 2;

            _rr = Math.sqrt(Math.random()) * edge * 0.92;

          }

          f.x = _fcx + Math.cos(_ra) * _rr; f.y = _fcy + Math.sin(_ra) * _rr;

          sg._foodDirty = true;

        }

      }

    }

  }



  // ── Prune corpses: dead snakes past the 2s respawn window that aren't coming back ─────────────

  // ssKill leaves the dead snake in the map (so it can respawn if the player sends input within 2s).

  // But a forfeited/left player never respawns, so without this they'd accumulate forever — every

  // tick's forEach/broadcast would iterate more and more corpses, slowly inflating per-tick cost

  // (creeping lag/ping over a long-running lobby). Remove any snake dead for >3s; a player who

  // rejoins later just gets a fresh entry via ssHandleInput. Also un-sticks a body that lingered.

  sg.snakes.forEach((sn, pid) => {

    if (!sn.alive && sn._killedAt && now - sn._killedAt > 3000) {

      wgNoteExit(lid, sn); sg.snakes.delete(pid);

      io.to(lid).emit('leave', { id: pid }); // belt-and-suspenders: make sure clients drop the body

    }

  });

  // Park unclaimed gold BEFORE the game object (and its food) is dropped — see ssParkFood.
  if (sg.snakes.size === 0) { ssParkFood(lid, sg); clearInterval(sg.tickInterval); sg.tickInterval = null; ssGames.delete(lid); return; }



  // ── Drive bot inputs (before movement) ───────────────────────────────────

  sg.snakes.forEach(sn => {

    if (!sn.bot || !sn.alive || !sn._botScript) return;

    sn.lastTs = Date.now();

    const cmd = sn._botScript(sn._botTick, sn);

    if (cmd) {

      if (typeof cmd.angle === 'number') { sn.targetAngle = cmd.angle; sn.faceAngle = cmd.angle; }

      sn.boost = !!cmd.boost && sn.ns > SS_BOOST_MIN;

      sn.circling = !!cmd.circle;

    }

    sn._botTick++;

  });



  // 1. Ghost timeout (network check, 30 Hz) — freezes (does NOT kill/eliminate) a snake once its

  //    input has gone quiet for a bit. This fires long before any real abandonment: it's the

  //    normal signature of a backgrounded tab (the 33ms input-send timer gets throttled hard by

  //    the browser), not just an actual disconnect. Freezing early is protective — it makes them

  //    collision-immune sooner rather than leaving them moving-but-uncontrolled and vulnerable.

  //    The wager itself is only forfeited after SS_DISCONNECT_GRACE_MS with zero reconnect —

  //    see the grace-expiry check below and ssHandleInput (un-freezes on any fresh input).

  sg.snakes.forEach(sn => {

    if (sn.alive && !sn.disconnected && now - sn.lastTs > SS_GHOST_MS) {

      sn.disconnected = true; sn.disconnectedAt = now;

    }

  });

  // 1b. Grace-expiry — only NOW (after the full grace window, still no reconnect) does a

  // disconnected player actually lose their wager, converted to food exactly like a real death.

  sg.snakes.forEach((sn, pid) => {

    if (!sn.disconnected || now - sn.disconnectedAt <= SS_DISCONNECT_GRACE_MS) return;

    if (sn.alive) {

      console.log(`[${lid}] ${pid} forfeited after ${SS_DISCONNECT_GRACE_MS/1000}s disconnected`);

      if (!sg.food) sg.food = [];

      ssSpawnKillFood(sg, sn);

      sg._foodDirty = true;

      sn.alive = false; sn._killedAt = now; sn.segs = []; sn.path = [];

      io.to(lid).emit('leave', { id: pid });

    }

    wgNoteExit(lid, sn); sg.snakes.delete(pid);

    if (sg.snakes.size === 0) {

      ssParkFood(lid, sg); // persist unclaimed gold before the food is dropped with the game

      clearInterval(sg.tickInterval); sg.tickInterval = null;

      ssGames.delete(lid);

      console.log(`[${lid}] ss game loop stopped`);

    }

  });

  // Remember each head's pre-tick position so food pickup can test the swept segment.

  sg.snakes.forEach(sn => { if (sn.alive) { sn._phx = sn.x; sn._phy = sn.y; } });

  for (let _sub = 0; _sub < SS_SUBSTEPS; _sub++) {

    // Disconnected snakes KEEP MOVING (they coast straight along their last heading — ssPlayerLeft

    // cleared circling/targetAngle) so a refresh resumes a real gliding body and disconnect can't be

    // used as an invulnerable freeze. They are NOT skipped here or in the collision filters.

    sg.snakes.forEach(sn => { if (sn.alive) { sn._chpx = sn.x; sn._chpy = sn.y; } }); // pre-substep head → swept collision (test lobby)

    sg.snakes.forEach(sn => { if (sn.alive) ssStepMovement(sn, sg, lid, io, now); });

    sg._subFrame = _sub; // substep index this tick — used by the graze/body overlap instrumentation

    try { if (sg.noseCollision) ssCheckCollisionsNose(sg, lid, io); else ssCheckCollisions(sg, lid, io); }

    catch (_e) { console.error('[SSCOLL] ' + lid + ' ' + ((_e && _e.stack) || _e)); } // fail-safe: a collision bug skips one substep, never crashes the node

    // Mid-tick broadcast: send each sub-step's position instead of only the final one, so

    // clients receive state at 60Hz (matching the 60Hz sim) instead of 30Hz. Halves the

    // interpolation buffer's inherent render lag for remote snakes. Last sub-step is still

    // covered by the existing end-of-tick broadcast below (which also carries food/growth).

    if (_sub < SS_SUBSTEPS - 1) ssBroadcastState(sg, lid, io);

  }



  // 2. Food pickup — exact head position, no guessing.

  // The growth cap IS the bank — nothing accumulates past it. At/above cap, regular (non-money)

  // pebbles aren't picked up at all (left on the field, snake passes straight over them, no

  // score/growth); money/kill food is still always collected (usd/score never withheld) but its

  // growth portion is discarded rather than queued once at cap. This replaces any notion of a

  // separate growQueue "reserve" beyond the cap.

  sg.snakes.forEach(sn => {

    if (!sn.alive) return;

    const _cap = ssGrowCap(sn, sg);

    for (let i = sg.food.length - 1; i >= 0; i--) {

      const f = sg.food[i];

      if (f.o === sn.pid && f.ne && now < f.ne) continue; // shed cooldown

      if (!f.k && sn.ns >= _cap) continue; // regular pebble, already capped — leave it, no pickup

      const pickR = f.k ? (sn.thick + SS_KILL_FOOD_PICKUP_R) : (sn.thick + SS_FOOD_PICKUP_R);

      const _ax = sn._phx != null ? sn._phx : sn.x, _ay = sn._phy != null ? sn._phy : sn.y;

      if (ssPtSegD2(f.x, f.y, _ax, _ay, sn.x, sn.y) < pickR * pickR) {

        if (sn.ns < _cap) sn.growQueue = (sn.growQueue || 0) + SS_FOOD_GROW; // discard growth once capped

        sn.score = (sn.score || 0) + (f.k ? 50 : 10);

        if (f.w) sn.usd = (sn.usd || 0) + f.w;

        // Banked apart from the deposit (_lamBase) so it survives the stake read landing late — see
        // ssLamCarried. This is the ONLY way a snake's lamport total can grow, and every lamport of
        // it came off a snake that died holding it.
        if (f.lam) sn._lamFood = (sn._lamFood || 0) + f.lam;

        sg.food.splice(i, 1);

        sg._foodDirty = true;

      }

    }

  });

  ssReconcileFood(sg);



  // Tick snapshot for collision kill-trace (non-behavioral)

  /* per-tick replay-history snapshot DISABLED (perf) - fed the now-disabled replay */



  // (Collision now runs inside the 60 Hz sub-step loop above.)



  // Test lobby auto-reset: 2s after all bots dead, clear and re-spawn

  if (sg._testScenario && !sg._resetPending) {

    const allDead = [...sg.snakes.values()].every(sn => !sn.alive);

    if (allDead) {

      sg._resetPending = true;

      setTimeout(() => {

        const sg2 = ssGames.get(lid);

        if (!sg2 || !sg2._testScenario) return;

        sg2.snakes.clear(); sg2.food = []; sg2._foodDirty = true; sg2.tick = 0; sg2._history = []; sg2._resetPending = false;

        ssSpawnBots(sg2, sg2._testScenario);

        console.log(`[${lid}] test scenario auto-reset (${sg2._testScenario})`);

      }, 2000);

    }

  }



  // Cashout timer (server-authoritative): pay any snake that has circled a full 6s. Marks it removed
  // (alive=false, NO food drop) and signals ONLY that owner's client to run the signed /api/settle
  // cashout. A kill before 6s set _cashResolved='died' (ssKill), so this skips it -> exactly one outcome.
  for (const _cs of sg.snakes.values()) {
    if (!_cs.cashing || !_cs.alive || _cs._cashResolved) continue;
    if (!_cs._cashStart) {
      // Wind-in gate: the 4s timer does NOT start until the whole body has curled into the circle
      // (tail fully inside). Accumulate head travel while circling; once it reaches the body's arc
      // length the tail sits where the head began -> whole body is on the loop. Stops big snakes from
      // circling with their tail hanging outside to dodge circle-kills during the timer.
      if (_cs._cashPX !== undefined) _cs._cashWound = (_cs._cashWound || 0) + Math.hypot(_cs.x - _cs._cashPX, _cs.y - _cs._cashPY);
      _cs._cashPX = _cs.x; _cs._cashPY = _cs.y;
      const _arc = (_cs.ns || 26) * ssSectionRadius(_cs.ns || 26) * 0.25;  // HALF the body length: timer starts once half the snake is wound into the circle
      _cs._cashW = _arc > 0 ? Math.min(1, (_cs._cashWound || 0) / _arc) : 1;   // wind-in progress 0..1 for the client ring
      if ((_cs._cashWound || 0) >= _arc) { _cs._cashStart = Date.now(); _cs._cashW = 1; }
    } else if (Date.now() - _cs._cashStart >= 4000) {
      _cs._cashResolved = 'paid';
      // Sign the authoritative carried total BEFORE the snake is torn down, and send it ONLY to its
      // owner's private channel. /api/settle pays this figure and ignores whatever the client asks
      // for, which is what removes the need for a fraud cap on the claim. No proof (free lobby, bot,
      // or the stake read never landed) is not an error: settle then falls back to the old capped
      // client claim, so a cash-out is never blocked by this — it is only ever made honest by it.
      const _cp = ssCashProof(_cs, lid);
      if (_cp) { io.to('p:' + _cs.pid).emit('ss-cash-proof', _cp);
        console.log(`[${lid}] cash proof MINTED for ${String(_cs.pid).slice(0, 8)} lam=${_cp.lam} base=${_cp.base} food=${_cp.lam - _cp.base}`); }
      else if (ssIsPaidLobby(lid)) console.warn(`[${lid}] NO cash proof for ${String(_cs.pid).slice(0, 8)} — settle will use the capped client claim`);
      _cs.alive = false; _cs._killedAt = Date.now(); _cs.path = []; _cs.segs = [];
      // Ledger consumed. The proof is the claim now, so this snake's money must not also drop as food
      // or be signed a second time. The client may re-present the SAME proof if the payout fails —
      // settle burns it only once SOL has actually moved.
      _cs._lamFood = 0; _cs._lamBase = 0; _cs._lamAuth = false;
      _stakeLam.delete(_cs.pid);
      io.to(lid).emit('ss-cashout-done', { id: _cs.pid });
    }
  }

  // P2P betting exchange: roster broadcast + outcome settlement (additive, never blocks the tick).
  try { ssWagerTick(lid, sg, io); } catch (_) {}

  // 5. Broadcast state to all clients

  ssBroadcastState(sg, lid, io);

}



// Option A: maintain a coarse copy of the snake's OWN trail for client rendering. Mirrors the head

// motion sn.path already follows (does NOT read or modify sn.path). Self-initializing so the flag

// can be toggled mid-game. New head points collected in _rtNew (oldest→newest) for per-tick deltas.

function ssUpdateRenderTrail(sn) {

  if (sn._rtLastX === undefined) {

    sn._rtLastX = sn.x; sn._rtLastY = sn.y; sn._rt = [[Math.round(sn.x), Math.round(sn.y)]];

    sn._rtNew = []; sn._rtNeedKf = true; sn._rtKfPhase = Math.floor(Math.random() * SS_RT_KF_TICKS);

  }

  const dx = sn.x - sn._rtLastX, dy = sn.y - sn._rtLastY, len = Math.hypot(dx, dy);

  if (len >= SS_RT_DIST) {

    const ux = dx / len, uy = dy / len, n = Math.floor(len / SS_RT_DIST);

    for (let i = 0; i < n; i++) {

      sn._rtLastX += ux * SS_RT_DIST; sn._rtLastY += uy * SS_RT_DIST;

      const p = [Math.round(sn._rtLastX), Math.round(sn._rtLastY)];

      sn._rt.unshift(p); sn._rtNew.push(p);

    }

  }

  const cap = Math.ceil(sn.ns * ssSectionRadius(sn.ns) * 0.5 / SS_RT_DIST) + 8;

  while (sn._rt.length > cap) sn._rt.pop();

}



function ssBroadcastState(sg, lid, io) {

  if (!sg) return;

  const snakePkts = [];

  sg.snakes.forEach(sn => {

    if (!sn.alive) return;

    const pk = {

      id: sn.pid, x: +sn.x.toFixed(1), y: +sn.y.toFixed(1),

      angle: sn.angle, ns: sn.ns, boost: sn.boost, circle: !!sn.circling,

      score: sn.score || 0, usd: sn.usd || 0, lam: ssLamCarried(sn), cash: sn.cashing ? 1 : 0, cashMs: (sn.cashing && sn._cashStart) ? (Date.now() - sn._cashStart) : 0, cashW: sn.cashing ? (sn._cashW || 0) : 0,

      color: sn.color, name: sn.name,

      sp: (sg.noseCollision && sn.circleActive) ? 1 : 0 // test lobby: circle-active = head is grazeable (H-overlay)

    };

    // Option A body stream (only when flag ON and trail exists): keyframe `rk` (staggered/periodic

    // or first) else delta `rd`. Flat [x0,y0,...] head-first. OFF → neither field → client unchanged.

    if (SS_BODY_SYNC && sn._rt) {

      const kf = sn._rtNeedKf || ((sg.tick % SS_RT_KF_TICKS) === (sn._rtKfPhase || 0));

      if (kf) { const a = []; for (const p of sn._rt) { a.push(p[0], p[1]); } pk.rk = a; sn._rtNeedKf = false; }

      else if (sn._rtNew && sn._rtNew.length) { const a = []; for (const p of sn._rtNew) { a.push(p[0], p[1]); } pk.rd = a; }

      sn._rtNew = [];

    }

    snakePkts.push(pk);

  });

  const pkt = { snakes: snakePkts, t: Date.now(), tick: sg.tick || 0, ar: Math.round(sg.arenaR || SS_ARENA_R),

                acx: Math.round(sg.cx || 0), acy: Math.round(sg.cy || 0), cpush: !!sg.campPushing };

  const now = Date.now();

  // (A 100ms floor was tried here on 2026-07-30 and REVERTED - it made gold orbs visibly lag
  //  outside the moving border. The dirty path deliberately bypasses the 250ms throttle.)
  // The roaming border's edge-sweep sets _foodDirty every tick while the ring travels,

  // and the roaming border's edge-sweep sets it EVERY tick while the ring travels - so the

  // full ~100-orb array went out at 30Hz instead of 4Hz for ~10s of every ~30s, in every

  // lobby. That is the FPS dip 'when the circle moves' and the worse ping, especially on

  // EU where the RTT is higher. Real events still land within 100ms and the client predicts

  // pickups locally, so nothing is visibly slower; the sweep just stops spamming.

  if (sg._foodDirty || !sg._lastFoodSend || now - sg._lastFoodSend > 250) {

    pkt.food = sg.food.map(f => [

      Math.round(f.x), Math.round(f.y),

      f.ci || 0, Math.round((f.size || 6) * 10) / 10,

      f.k ? 1 : 0, f.w ? Math.round(f.w * 1e6) : 0,

      // SHED OWNER + NO-EAT DEADLINE. Computed server-side but never transmitted, so the client

      // predictor could not know a pebble was off-limits: it "ate" it, the pebble vanished from the

      // screen, and the server went on refusing it. Sending them makes both sides apply one rule.

      f.o || 0, f.ne || 0

    ]);

    sg._lastFoodSend = now;

    sg._foodDirty = false;

  }

  io.to(lid).emit('ss-state', pkt);

}



// One-off full snapshot sent directly to a single (spectator) socket on connect, so they don't

// stare at a blank arena for up to ~33ms waiting for the next regular tick broadcast. Always

// includes food (no _foodDirty throttling — this fires once per spectator, not every tick).

// Read-only and additive: never touches sg._lastFoodSend/_foodDirty, so it can't skip or delay

// the real room-wide broadcast for actual players.

function ssBroadcastStateTo(socket, sg) {

  if (!sg) return;

  const snakePkts = [];

  sg.snakes.forEach(sn => {

    if (!sn.alive) return;

    snakePkts.push({

      id: sn.pid, x: +sn.x.toFixed(1), y: +sn.y.toFixed(1),

      angle: sn.angle, ns: sn.ns, boost: sn.boost, circle: !!sn.circling,

      score: sn.score || 0, usd: sn.usd || 0, lam: ssLamCarried(sn), cash: sn.cashing ? 1 : 0, cashMs: (sn.cashing && sn._cashStart) ? (Date.now() - sn._cashStart) : 0, cashW: sn.cashing ? (sn._cashW || 0) : 0, color: sn.color, name: sn.name

    });

  });

  const pkt = {

    snakes: snakePkts, t: Date.now(), tick: sg.tick || 0, ar: Math.round(sg.arenaR || SS_ARENA_R),

    acx: Math.round(sg.cx || 0), acy: Math.round(sg.cy || 0), cpush: !!sg.campPushing,

    food: sg.food.map(f => [

      Math.round(f.x), Math.round(f.y),

      f.ci || 0, Math.round((f.size || 6) * 10) / 10,

      f.k ? 1 : 0, f.w ? Math.round(f.w * 1e6) : 0

    ])

  };

  socket.emit('ss-state', pkt);

}



// One-time JOIN body seed: send each OTHER alive snake's authoritative body (sn.path decimated

// head->tail to render resolution) to the JOINING socket ONLY, once per connection. Lets a fresh

// or rejoining client render full tails on frame one instead of a straight stub. Additive +

// render-only: no gameplay/collision/authority/tick change; nothing broadcast to other clients.

function ssSendJoinBodies(socket, sg, selfPid) {

  if (!socket || !sg) return;

  const out = [];

  sg.snakes.forEach(sn => {

    if (!sn.alive || sn.pid === selfPid || !sn.path || sn.path.length < 2) return;

    const step = Math.max(1, Math.round(ssSectionRadius(sn.ns) * 0.5 / SS_POINT_DIST));

    const p = [];

    for (let i = 0; i < sn.path.length && p.length < 4000; i += step) {

      p.push(Math.round(sn.path[i].x), Math.round(sn.path[i].y));

    }

    if (p.length >= 4) out.push({ id: sn.pid, ns: sn.ns, p });

  });

  if (out.length) socket.emit('ss-bodies', { t: Date.now(), snakes: out });

}



// Instrumentation helper (read-only; does NOT affect collision outcome):

// runs the exact H2B head-in-body scan for `att` head against `vic` body, returns hit or null.

function ssScanHeadInBody(attHeadX, attHeadY, attThick, vic, T) {

  const hR = attThick * SS_HB * T.hbs * T.hhbs;

  const bR = vic.thick * SS_HB * T.hbs;

  const crr2 = (hR + bR) * (hR + bR);

  const vpath = vic.path;

  if (!vpath || vpath.length === 0) return null;

  const collLim = Math.min(vic.ns, 1200);

  for (let k = 2; k < collLim; k++) {

    const idx = Math.round(k * ssSectionRadius(vic.ns) * 0.5 / SS_POINT_DIST);

    const pt = vpath[idx] || vpath[vpath.length - 1];

    const sdx = attHeadX - pt.x, sdy = attHeadY - pt.y;

    if (sdx * sdx + sdy * sdy <= crr2) {

      return { k, idx, dist: +Math.sqrt(sdx*sdx+sdy*sdy).toFixed(2), crr: +Math.sqrt(crr2).toFixed(2),

               bodyPt: { x: +pt.x.toFixed(1), y: +pt.y.toFixed(1) } };

    }

  }

  return null;

}



// [COLLISION_SNAPSHOT] Decimated tail of a path from the head end (instrumentation only;

// never touches gameplay). Captures the actual authoritative body geometry at death time.

function ssPathTail(path, n, stride) {

  if (!path || !path.length) return [];

  const out = [];

  const st = Math.max(1, stride | 0);

  for (let i = 0; i < path.length && out.length < n; i += st) {

    out.push({ x: +path[i].x.toFixed(1), y: +path[i].y.toFixed(1) });

  }

  return out;

}



function ssCheckCollisions(sg, lid, io) {

  const T = sg.tuning;

  // MoneySlither: collide on the exact head (s.x,s.y) against the raw 1.6px path — no segs.

  // Disconnected (frozen) snakes are excluded entirely — collision-immune both ways, so nobody

  // can be killed while their input is stuck (backgrounded tab) and unable to react or flee.

  const alive = [...sg.snakes.values()].filter(s => s.alive && s.path && s.path.length > 1); // disconnected snakes coast + still collide (not immune)

  const died = new Set();

  const _evalOrder = alive.map(s => s.pid.slice(0, 8));

  let _h2hKilled = false;



  // ── Head-to-head: MoneySlither pipeline. Both snakes must face each other within faceDeg.

  // Gate fails → pair falls through to H2B only (no TYPE-2 fallback).

  // Gate passes → winner decided by T.rule (smallest_wins default; see below).

  const _faceCos = Math.cos((T.faceDeg ?? 75) * Math.PI / 180);

  for (let i = 0; i < alive.length; i++) {

    const p = alive[i]; if (died.has(p.pid)) continue;

    const px = p.x, py = p.y;                       // MoneySlither: exact head (sp.x, sp.y)

    const hR1 = p.thick * SS_HB * T.hbs * T.hhbs;

    for (let j = i + 1; j < alive.length; j++) {

      const q = alive[j]; if (died.has(q.pid)) continue;

      const qx = q.x, qy = q.y;

      const hR2 = q.thick * SS_HB * T.hbs * T.hhbs;

      const rr = (hR1 + hR2) * T.hbs; // MoneySlither exact: (headR1+headR2) * combatHitboxScale

      const dx = qx - px, dy = qy - py, d2 = dx * dx + dy * dy;

      if (d2 > rr * rr) continue;

      let pDot = 0, qDot = 0, dh = 0;

      if (d2 > 0) {

        dh = Math.sqrt(d2);

        // MoneySlither client.js:842-845 uses sp.angle (the simulated HEADING) for the

        // facing gate — NOT a client-reported aim. Using faceAngle (the player's aim, which

        // leads the heading mid-turn) made PAC fire H2H where MoneySlither falls to H2B,

        // killing a boosting (smaller) leader in a cut-off instead of the pursuer. Proven

        // via parity harness: faceAngle→107/2304 wrong outcomes, angle→0 residual.

        const pFace = p.angle;

        const qFace = q.angle;

        pDot = Math.cos(pFace) * (dx / dh) + Math.sin(pFace) * (dy / dh);

        qDot = Math.cos(qFace) * (-dx / dh) + Math.sin(qFace) * (-dy / dh);

      }

      if (pDot < _faceCos || qDot < _faceCos) continue;                 // gate fails → H2B

      // Apply the lobby's H2H winner RULE (owner-tunable in the combat panel). This was the bug:

      // the winner used to be hardcoded to the bigger snake, so the rule did nothing and a straight

      // face-off always killed the smaller one. Now: smallest_wins (default, MoneySlither) = the

      // SMALLER snake survives; biggest_wins = bigger survives; random = coin flip; both_die = both.

      // Equal sizes always coin-flip.

      const _rule = T.rule || 'smallest_wins';

      if (_rule === 'both_die') {

        _h2hKilled = true; died.add(p.pid); died.add(q.pid);

        const _bd = { stage:'H2H', reason:'both_die', tick:sg.tick, t:Date.now() };

        ssKill(p, q, lid, io, _bd); ssKill(q, p, lid, io, _bd);

        console.log('[KILL_TRACE] ' + JSON.stringify({ type:'H2H', reason:'both_die', p:p.pid, q:q.pid }));

        continue;

      }

      let winner, loser, reason;

      let _pWins;

      if      (p.size === q.size)        _pWins = Math.random() < 0.5;

      else if (_rule === 'biggest_wins') _pWins = p.size > q.size;

      else if (_rule === 'random')       _pWins = Math.random() < 0.5;

      else /* smallest_wins */           _pWins = p.size < q.size;

      winner = _pWins ? p : q; loser = _pWins ? q : p; reason = _rule + (p.size === q.size ? '-tie' : '');

      const _h2h = { type:'H2H', tk:sg.tick, t:Date.now(), lid, evalOrder:_evalOrder,

        p:{ pid:p.pid, x:px, y:py, ang:+p.angle.toFixed(3), face:p.faceAngle!=null?+p.faceAngle.toFixed(3):null, pDot:+pDot.toFixed(4) },

        q:{ pid:q.pid, x:qx, y:qy, ang:+q.angle.toFixed(3), face:q.faceAngle!=null?+q.faceAngle.toFixed(3):null, qDot:+qDot.toFixed(4) },

        d:+dh.toFixed(2), rr:+rr.toFixed(2), faceCos:+_faceCos.toFixed(4), winner:winner.pid, loser:loser.pid, reason };

      console.log('[KILL_TRACE] ' + JSON.stringify(_h2h));

      const _hh = (sg._history||[]).slice(-10).map(s => { const o={tk:s.tk}; if(s.sn[p.pid]) o[p.pid.slice(0,8)]=s.sn[p.pid]; if(s.sn[q.pid]) o[q.pid.slice(0,8)]=s.sn[q.pid]; return o; });

      console.log('[KILL_HIST] ' + JSON.stringify({ loser:loser.pid, tks:_hh }));

      _h2hKilled = true; died.add(loser.pid);

      ssKill(loser, winner, lid, io, {

        stage:'H2H', tick:sg.tick, t:Date.now(), killerId:winner.pid, victimId:loser.pid,

        killerHead: winner===p?{x:px,y:py}:{x:qx,y:qy},

        victimHead: loser===p?{x:px,y:py}:{x:qx,y:qy},

        victimAngle:+loser.angle.toFixed(3), killerAngle:+winner.angle.toFixed(3),

        victimTarget:loser.targetAngle!=null?+loser.targetAngle.toFixed(3):null, killerTarget:winner.targetAngle!=null?+winner.targetAngle.toFixed(3):null,

        victimFace:loser.faceAngle!=null?+loser.faceAngle.toFixed(3):null, killerFace:winner.faceAngle!=null?+winner.faceAngle.toFixed(3):null,

        victimBoost:!!loser.boost, killerBoost:!!winner.boost, victimNs:loser.ns, killerNs:winner.ns,

        pDot:+pDot.toFixed(4), qDot:+qDot.toFixed(4), faceCos:+_faceCos.toFixed(4), reason,

        aliveOrder:_evalOrder, gateUsesField:'angle',

        collisionPoint:{x:+((px+qx)/2).toFixed(1),y:+((py+qy)/2).toFixed(1)},

        collisionSnapshot:{ pHead:{x:+px.toFixed(1),y:+py.toFixed(1)}, qHead:{x:+qx.toFixed(1),y:+qy.toFixed(1)},

          winnerId:winner.pid, loserId:loser.pid,

          pPathLen:p.path?p.path.length:0, qPathLen:q.path?q.path.length:0,

          pPathTail:ssPathTail(p.path, 80, 2), qPathTail:ssPathTail(q.path, 80, 2) },

        dist:+dh.toFixed(2), crr:+rr.toFixed(2) });

    }

  }



  // ── Head-to-body: MoneySlither exact source —

  //   var idx = k * SEGMENT_SPACING_TICKS;

  //   var seg = sqq.path[idx] || sqq.path[sqq.path.length - 1];

  // k=2..numSegments, SEGMENT_SPACING_TICKS=4, POINT_DIST=1.6px → path[8]=12.8px first check.

  // Single-pass, order-dependent, NO tiebreaker — matches MoneySlither client.js exactly.

  for (let i = 0; i < alive.length; i++) {

    const pp = alive[i]; if (died.has(pp.pid)) continue;

    const hR = pp.thick * SS_HB * T.hbs * T.hhbs;

    const hhx = pp.x, hhy = pp.y;                   // MoneySlither: exact head (spp.x, spp.y)

    for (let j = 0; j < alive.length; j++) {

      const qq = alive[j]; if (qq.pid === pp.pid || died.has(qq.pid)) continue;

      const bR = qq.thick * SS_HB * T.hbs;

      const crr2 = (hR + bR) * (hR + bR);

      const qpath = qq.path;

      if (!qpath || qpath.length === 0) continue;

      const collLim = Math.min(qq.ns, 1200);

      for (let k = 2; k < collLim; k++) {

        const idx = Math.round(k * ssSectionRadius(qq.ns) * 0.5 / SS_POINT_DIST);

        const pt = qpath[idx] || qpath[qpath.length - 1];

        const sdx = hhx - pt.x, sdy = hhy - pt.y;

        if (sdx * sdx + sdy * sdy <= crr2) {

          const _sd = Math.sqrt(sdx*sdx+sdy*sdy), _crr = Math.sqrt(crr2);

          const _vh = { x: qq.x, y: qq.y };   // killer exact head

          const _h2b = { type:'H2B', tk:sg.tick, t:Date.now(), lid, evalOrder:_evalOrder, h2hKilledFirst:_h2hKilled,

            att:{ pid:pp.pid, hx:hhx, hy:hhy, ang:+pp.angle.toFixed(3), face:pp.faceAngle!=null?+pp.faceAngle.toFixed(3):null, boost:!!pp.boost, ns:pp.ns },

            vic:{ pid:qq.pid, hx:_vh?_vh.x:null, hy:_vh?_vh.y:null, ang:+qq.angle.toFixed(3), boost:!!qq.boost, ns:qq.ns },

            k, idx, bodyPt:{ x:+pt.x.toFixed(2), y:+pt.y.toFixed(2) }, dist:+_sd.toFixed(3), crr:+_crr.toFixed(3) };

          console.log('[KILL_TRACE] ' + JSON.stringify(_h2b));

          const _hb = (sg._history||[]).slice(-10).map(s => { const o={tk:s.tk}; if(s.sn[pp.pid]) o[pp.pid.slice(0,8)]=s.sn[pp.pid]; if(s.sn[qq.pid]) o[qq.pid.slice(0,8)]=s.sn[qq.pid]; return o; });

          console.log('[KILL_HIST] ' + JSON.stringify({ attacker:pp.pid, victim:qq.pid, tks:_hb }));

          died.add(pp.pid);

          // ── Bidirectional / eval-order instrumentation (read-only; does not change outcome) ──

          // Reverse scan: is the KILLER's (qq) head also inside the VICTIM's (pp) body this tick?

          const _rev = _vh ? ssScanHeadInBody(_vh.x, _vh.y, qq.thick, pp, T) : null;

          const _bidir = !!_rev;

          // [COLLISION_SNAPSHOT] exact coords the H2B loop tested on the killer's (qq) body,

          // k=2..kHit, plus the decimated body path the player ran into (instrumentation only).

          const _tested = [];

          for (let _kk = 2; _kk <= k; _kk++) {

            const _ii = Math.round(_kk * ssSectionRadius(qq.ns) * 0.5 / SS_POINT_DIST);

            const _sp = qpath[_ii] || qpath[qpath.length - 1];

            _tested.push({ k:_kk, idx:_ii, x:+_sp.x.toFixed(1), y:+_sp.y.toFixed(1),

                           dist:+Math.hypot(hhx - _sp.x, hhy - _sp.y).toFixed(2) });

          }

          const _collSnap = {

            kHit:k, idxHit:idx, crr:+_crr.toFixed(2),

            bodyOwnerId:qq.pid, attackerId:pp.pid,        // player head (attacker) ran into bot body (owner)

            attackerHead:{x:+hhx.toFixed(1),y:+hhy.toFixed(1)},

            bodyOwnerHead:_vh?{x:+_vh.x.toFixed(1),y:+_vh.y.toFixed(1)}:null,

            bodyPathLen:qpath.length,

            bodyPathTail:ssPathTail(qpath, 80, 2),        // decimated authoritative body from head end

            testedSegments:_tested                        // every path[k*4] tested until the hit

          };

          ssKill(pp, qq, lid, io, {

            stage:'H2B', tick:sg.tick, t:Date.now(), killerId:qq.pid, victimId:pp.pid,

            collisionSnapshot:_collSnap,

            killerHead:_vh?{x:+_vh.x.toFixed(1),y:+_vh.y.toFixed(1)}:null,

            victimHead:{x:+hhx.toFixed(1),y:+hhy.toFixed(1)},

            victimAngle:+pp.angle.toFixed(3), killerAngle:+qq.angle.toFixed(3),

            victimTarget:pp.targetAngle!=null?+pp.targetAngle.toFixed(3):null, killerTarget:qq.targetAngle!=null?+qq.targetAngle.toFixed(3):null,

            victimFace:pp.faceAngle!=null?+pp.faceAngle.toFixed(3):null, killerFace:qq.faceAngle!=null?+qq.faceAngle.toFixed(3):null,

            victimBoost:!!pp.boost, killerBoost:!!qq.boost, victimNs:pp.ns, killerNs:qq.ns,

            collisionPoint:{x:+pt.x.toFixed(2),y:+pt.y.toFixed(2)}, k, idx,

            dist:+_sd.toFixed(2), crr:+_crr.toFixed(2),

            aliveOrder:_evalOrder, evaluatedFirst:'victim(attacker head-in-body found first)',

            bidirectional:_bidir,

            reverseHeadInBody:_rev,                                   // killer head into victim body, or null

            reverseOrderWouldKill:_bidir ? qq.pid : pp.pid,          // who dies if alive-array reversed

            evalOrderDecidedVictim:_bidir                           // true => order determined who died

          });

          break;

        }

      }

      if (died.has(pp.pid)) break;

    }

  }



  // ── [PASSTHRU_PROBE] read-only missed-collision detector (enable with env SS_PASSTHRU_PROBE=1) ──

  // Uses prod's IDENTICAL sampling (idx = round(k*ssSectionRadius(ns)*0.5/SS_POINT_DIST)) and

  // IDENTICAL crr as the H2B loop above. sampledHit = minSampledDist2 <= crr2; shouldHaveKilled =

  // sampledHit && !killOccurred (head inside a sampled body point but no death => server miss).

  // killOccurred read from the already-populated `died` set. Hit evaluated per victim (deepest

  // penetration). Logs only when sampledHit. Pure logging: never calls ssKill, never mutates

  // died/paths/positions. Off unless the env flag is set.

  if (process.env.SS_PASSTHRU_PROBE) {

    for (let i = 0; i < alive.length; i++) {

      const pp = alive[i];

      const hR = pp.thick * SS_HB * T.hbs * T.hhbs;

      const hhx = pp.x, hhy = pp.y;

      let bestScore = Infinity, bestPid = null, bestD2 = 0, bestCrr2 = 0;

      for (let j = 0; j < alive.length; j++) {

        const qq = alive[j];

        if (qq.pid === pp.pid) continue;

        const qpath = qq.path; if (!qpath || qpath.length === 0) continue;

        const bR = qq.thick * SS_HB * T.hbs;

        const crr2 = (hR + bR) * (hR + bR);

        const stepFactor = ssSectionRadius(qq.ns) * 0.5 / SS_POINT_DIST; // == prod H2B idx factor

        const collLim = Math.min(qq.ns, 1200);

        let minD2 = Infinity;

        for (let k = 2; k < collLim; k++) {

          const idx = Math.round(k * stepFactor);

          const pt = qpath[idx] || qpath[qpath.length - 1];

          const dx = hhx - pt.x, dy = hhy - pt.y, d2 = dx * dx + dy * dy;

          if (d2 < minD2) minD2 = d2;

        }

        if (minD2 === Infinity) continue;

        const score = minD2 - crr2;

        if (score < bestScore) { bestScore = score; bestPid = qq.pid; bestD2 = minD2; bestCrr2 = crr2; }

      }

      if (bestPid == null) continue;

      const sampledHit = bestD2 <= bestCrr2;

      if (!sampledHit) continue;

      const killOccurred = died.has(pp.pid);

      console.log('[PASSTHRU_PROBE] ' + JSON.stringify({

        tick: sg.tick, attacker: pp.pid, victim: bestPid,

        minSampledDist2: +bestD2.toFixed(1), crr2: +bestCrr2.toFixed(1),

        killOccurred, sampledHit,

        shouldHaveKilled: sampledHit && !killOccurred

      }));

    }

  }

}



// ── Circle detection (ss-test-lobby) — winding accumulator. See SS_CIRC_* above. ──

// Winds up signed turning while turning TIGHTLY in one direction; ~one full turn (circDeg) → grazeable.

// The MOMENT the snake comes out of the circle — opens the radius / slows below SS_CIRC_RATE, or

// reverses — the winding resets and circleActive drops, so a fresh full circle is required to re-arm.

// One tight loop arms it (no multi-loop validation); weaving/zig-zag/straight never wind up. Test lobby

// only; does not touch movement or visuals.

function ssUpdateCircleState(sn, sg) {

  const T = sg.tuning || {};

  const complete = (T.circDeg != null ? T.circDeg : 360) * Math.PI / 180;

  if (sn._csWind == null) { sn._csWind = 0; sn._csDir = 0; sn._csSlow = 0; sn._csRate = 0; sn._csLoop = false; sn.circleActive = false; }

  const clear = () => { sn._csWind = 0; sn._csRate = 0; sn._csLoop = false; sn._csDir = 0; };



  const dA = ssAngleDiff(sn.angle, sn._prevAngle != null ? sn._prevAngle : sn.angle);

  sn._prevAngle = sn.angle;

  const mag = Math.abs(dA), dir = dA >= 0 ? 1 : -1;



  // Reversed direction → the loop is broken; start a fresh winding the other way (weaving never accrues).

  if (dir !== sn._csDir && mag > SS_CIRC_MINRATE) { clear(); sn._csDir = dir; sn._csRate = mag; sn._csSlow = 0; sn.circleActive = false; return; }



  // "Left the circle" = going nearly straight, OR the current turn dropped well below the loop's own

  // established rate (opening the radius / slowing — even in the same direction). Drop grazeable NOW.

  const leaving = mag < SS_CIRC_MINRATE || (sn._csRate > SS_CIRC_MINRATE && mag < sn._csRate * SS_CIRC_RELDROP);

  if (leaving) {

    sn.circleActive = false;                                     // INSTANT off the moment you leave the circle

    if (++sn._csSlow > SS_CIRC_SLOWGRACE) clear();               // sustained → wipe progress, must re-loop to re-arm

    return;

  }

  sn._csSlow = 0;

  // Track the loop's established turn rate with a slow EMA (so a real slow-down stands out against it).

  sn._csRate = sn._csRate > 0 ? sn._csRate * SS_CIRC_RATEDECAY + mag * (1 - SS_CIRC_RATEDECAY) : mag;

  sn._csWind += dA;

  if (Math.abs(sn._csWind) >= complete) sn._csLoop = true;       // one full rotation completed

  sn.circleActive = sn._csLoop;                                  // grazeable only after a loop AND still circling now

}



// ── SPECIAL circle head-graze collision — ss-test-lobby ONLY ──────────────────────────────────────

// CRITICAL: all geometry uses the VISUAL radius `ssSectionRadius(ns)` — the SAME radius the client

// draws the body/head at — so the hitbox matches the sprite exactly. (The old code collided at

// `ssThick`, a ~1.6× SMALLER radius, so a nose could sink 20-38px into the drawn body before dying —

// the "drive through the body" bug. Proven + fixed in scratchpad solid_body_sim.js / fixed_collide_sim.js.)

// ── THE NOSE (test lobby) — part of the snake's OUTLINE, not a point/disc/offset shape ──

// The nose is the ARC of the head circle between the two eyes. Derived from the client's test-lobby face

// (slither-snakes.html: eyes at (+0.52r, ±0.37r), eye radius 0.42r): each eye disc covers the outline from

// 20.1°..50.8° off the heading, so the exposed face arc BETWEEN the eyes is exactly ±20.1° around the

// heading. A contact "counts as nose" when the contact point on the head circle lies inside that arc —

// i.e. the direction head-centre → contact point is within SS_NOSE_ARC of the snake's heading. No bigger,

// no smaller, and it sits ON the visible outline (the head circle itself, radius = sectionRadius).

const SS_NOSE_ARC = 20.1 * Math.PI / 180; // half-angle of the face arc between the eyes

function ssCheckCollisionsNose(sg, lid, io) {

  // ── ss-test-lobby collision — TEMPORAL circle-kill model (its own mechanic, no static graze) ──────────

  // All geometry uses the DRAWN radius (sectionRadius) and the snake's DRAWN trail (sn.path, the exact

  // history of head positions the body follows). Two passes:

  //   1) BODY / TRAIL — a snake's SWEPT head vs every OTHER snake's drawn trail:

  //        • NORMAL snake → dies the instant its head reaches a trail point (overlap > 0). UNCHANGED.

  //        • CIRCLING snake (circleActive) → SKIM MARGIN: survives while it only skims the trail edge

  //          (overlap ≤ skimMargin) and dies only when its looping head reaches a trail point DEEPER than

  //          the margin. This makes the circle-kill TEMPORAL/Damnbruh-like: the circler does NOT die at the

  //          first graze — it keeps rotating and dies later, when its OWN rotation drives its head into the

  //          trail the target has laid. The delay is EMERGENT from the geometry + stored trail history.

  //   3) N2N — normal head-on nose contact, bigger wins. UNCHANGED (still skips circling pairs).

  // The circler is the snake that DIES; the target it circles is untouched by this mechanic.

  const T = sg.tuning || {};

  const noseCosMin = Math.cos(SS_NOSE_ARC);                 // N2N: contact must land on the outline arc between the eyes

  const rule = T.rule || 'biggest_wins';

  const now = Date.now();

  const alive = [...sg.snakes.values()].filter(s => s.alive && s.path && s.path.length > 1);

  const died = new Set();

  // Spawn immunity is a DEATH-SHIELD ONLY (enforced in kill()); collision is always detected so bodies

  // stay solid — immunity never removes anyone from these checks, it only suppresses their own death.

  const immune = s => s._immuneUntil && now < s._immuneUntil;

  const kill = (victim, killer, diag) => {

    if (died.has(victim.pid)) return;

    if (immune(victim)) return;

    died.add(victim.pid);

    ssKill(victim, killer, lid, io, diag);

  };

  const R = s => ssSectionRadius(s.ns);

  const prevHead = s => ({ x: s._chpx != null ? s._chpx : s.x, y: s._chpy != null ? s._chpy : s.y });

  const sweep = (ax, ay, bx, by, step) => {           // sample a swept point A→B so a fast head can't tunnel

    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step)), out = [];

    for (let i = 0; i <= n; i++) out.push({ x: ax + (bx - ax) * i / n, y: ay + (by - ay) * i / n });

    return out;

  };

  // ── VISIBLE-BODY LENGTH (render/collision sync) ─────────────────────────────────────────────────

  // The client draws exactly `ns` body circles spaced r*0.5 apart (getBodyPoints), so the drawn tail

  // ends at arc-length ns*r*0.5 → path index ns*r*0.5 / SS_POINT_DIST. `sn.path` is a much LONGER

  // history buffer (kept at ≥800 pts so the tail is always covered). Colliding against the whole

  // buffer means the head can die on trail the snake ALREADY LEFT — an invisible tail hitbox with no

  // sprite. bodyEndIdx clamps every body loop to the last DRAWN segment, so collision length == what

  // the player sees. (Matches the production H2B bound `min(ns,1200)` in ssCheckCollisions.)

  const bodyEndIdx = s => {

    const last = (s.path ? s.path.length : 0) - 1;

    return Math.min(last, Math.round(s.ns * ssSectionRadius(s.ns) * 0.5 / SS_POINT_DIST));

  };

  // Temporary render/collision-sync diagnostic (≤ once per second per lobby): shows, per snake, the

  // server's full buffer length vs the DRAWN tail index the collision is now clamped to. A large gap

  // was the invisible-tail bug (collided buffer ≫ drawn body). Remove after field verification.

  if (T.dbg && (!sg._lastSyncDiag || now - sg._lastSyncDiag > 1000)) {

    sg._lastSyncDiag = now;

    for (const s of alive) {

      const drawn = bodyEndIdx(s), buf = (s.path ? s.path.length : 0) - 1;

      if (buf - drawn > 4)

        console.log(`[${lid}] RENDER-SYNC ${s.pid.slice(0,8)} ns=${s.ns} drawnTailIdx=${drawn} bufferIdx=${buf} invisibleTailPts=${buf - drawn} (${((buf - drawn) * SS_POINT_DIST).toFixed(0)}px now clamped OUT)`);

    }

  }



  // 1) BODY / TRAIL — swept head vs every OTHER snake's DRAWN trail (past the neck, clamped to bodyEndIdx).

  //    overlap = (Ra+Rd) − closest distance from the swept head to the trail.

  //      • NORMAL snake            → dies when overlap > 0        (die on touch — UNCHANGED body collision).

  //      • CIRCLING (circleActive) → dies when overlap > skimMargin (skims the edge & keeps rotating; dies

  //        only when its looping head reaches a trail point deeper than the margin → the temporal kill).

  //    Implemented as a distance test (no sqrt in the hot loop): overlap > margin ⇔ dist < reach − margin.

  // ── GRAZE tuning knobs (test lobby ONLY; NONE of these touch normal body/H2H/movement) ──

  //   grazePx    = MAX BODY OVERLAP px — how many px a graze may sink into the body before it kills (skim depth).

  //   grazeHead  = GRAZER HEAD HITBOX ×— scales the grazing head's radius for the graze check only.

  //   bodyScale  = TARGET BODY/TRAIL RADIUS ×— scales the target trail's radius for the graze check only.

  //   grazeReach = TRAIL DANGER LENGTH ×— how much of the target's drawn trail is lethal (1=full, <1=only near head).

  const skimMargin = T.grazePx    != null ? T.grazePx    : 1.0;

  const grazeHead  = T.grazeHead  != null ? T.grazeHead  : 1.0;

  const grazeBody  = T.bodyScale  != null ? T.bodyScale  : 1.0;

  const grazeReach = T.grazeReach != null ? T.grazeReach : 1.0;

  // RETIRED 2026-07-31 — read by nothing. Its whole job was making the margin scale with snake
  // size; there is no size scaling left in either test, so it could only ever have been a silent
  // multiplier with a name that promised something it no longer did. Kept as a FIELD so existing
  // ss-tune signatures (ssTuneCanon covers it) still verify and saved files still load.
  const grazeScaleK = T.grazeScaleK != null ? T.grazeScaleK : 0.75;   // eslint-disable-line no-unused-vars

  const DBG = !!T.dbg;   // owner DEBUG toggle — gates ALL per-substep instrumentation. Default OFF so normal play has

                         // ZERO logging / full-scan overhead (the verbose logs were lagging the shared node → paid ping).

  for (const A of alive) {

    if (died.has(A.pid)) continue;

    const aCirc = !!A.circleActive;

    const RaBase = R(A), ph = prevHead(A);

    const hsweep = sweep(ph.x, ph.y, A.x, A.y, Math.max(3, RaBase * 0.5));

    if (DBG && A._wasCircle !== aCirc) { A._wasCircle = aCirc;

      console.log(`[${lid}] CIRCLE-STATE ${A.pid.slice(0,8)} circleActive → ${aCirc} winding=${(Math.abs(A._csWind || 0) * 180 / Math.PI).toFixed(0)}/${(T.circDeg != null ? T.circDeg : 360)}deg`); }

    let killD = null, killOverlap = 0, killMargin = 0, killSkimOn = false; // FIRST trail that kills A

    let nearOverlap = -Infinity, nearTarget = null, nearSkimOn = false;    // DBG-only diagnostic scan

    for (const D of alive) {

      if (A === D) continue;

      // SKIM applies if EITHER snake is circling: a circler skims trails, AND anyone skims a CIRCLER's body.

      const skimOn = aCirc || !!D.circleActive;

      const RaEff  = RaBase * (skimOn ? grazeHead : 1);        // grazer head hitbox scale (graze only)

      const Rd = R(D), RdEff = Rd * (skimOn ? grazeBody : 1);   // target body/trail radius scale (graze only)

      /*
       * GRAZE FORGIVENESS MUST SCALE WITH THE SNAKES, OR IT ONLY EXISTS FOR SMALL ONES.
       *
       * The kill test is `distance < (Ra + Rd) - margin`, so `margin` is how far you may sink into
       * a body and live. Both radii grow with length (ssSectionRadius: 8 + (ns*5)^0.6*0.8) while
       * margin was a FLAT pixel count -- so the forgiveness you actually feel, margin/reach,
       * collapsed as you grew:
       *     two base snakes  reach 16.0  ->  3.35/16.0 = 21%
       *     two size-20      reach 41.4  ->  3.35/41.4 =  8%
       * A 2.6x difference in feel for the identical input. That is the whole reason grazing felt
       * easy at size 10 and stiff at 20+; it is arithmetic, not tuning taste.
       *
       * Scaling margin by reach^k restores it. k is a BLEND, not a switch:
       *     k=0  the old behaviour (absolute px, big snakes punished)
       *     k=1  perfectly identical feel at every size
       *     k=0.75 (default) nearly equal, with a small edge still left to smaller snakes --
       *          21% -> 16.5% instead of 21% -> 8%, so being small is still slightly kinder,
       *          which is the reward for the risk of being small.
       *
       * Anchored at SS_GRAZE_REF_REACH (two base-radius snakes), so the multiplier is exactly 1
       * there: the smallest-size feel -- the one that was already liked -- is UNCHANGED, and only
       * the fall-off away from it is corrected. Nothing gets harder than it is today.
       */
      /*
       * GRAZE DIFFICULTY IS NOW A FIXED NUMBER OF WORLD PIXELS, AT EVERY SIZE, FOR BOTH SNAKES.
       *
       * `sink` = how far the circler may sink into the trail and LIVE = (Ra + Rd) - killDist
       *        = (1 - grazeHead)*Ra + (1 - bodyScale)*Rd + margin.
       * That is the difficulty. It was not size-invariant, and grazeScaleK could not make it so:
       *
       *   killer's own size (circler fixed at ns30):  ns22 1.61px -> ns40 3.21 -> ns50 3.98 -> ns63 4.89
       *
       * i.e. growing from 22 to 63 handed the circler THREE TIMES the forgiveness for the same
       * input. Owner, in their own words: good at 20-25, noticeably worse past 25, impossible at
       * 40+, never once seen at 50+. That row IS the complaint.
       *
       * THE LEVER WAS NEVER grazeScaleK. The dominant term is (1 - bodyScale)*Rd = 0.25 * MY OWN
       * radius: bodyScale thins the trail I lay by a quarter of my thickness, and I get thicker
       * as I grow. grazeScaleK only shapes the small `margin` term, which is why 1.15 -> 1.0 ->
       * 0.75 all felt like nothing, and why even k=0 only closes the gap from 2.33x to 1.48x.
       *
       * AND WHY 'RELATIVE FEEL' WAS THE WRONG TARGET: the camera does NOT zoom with snake size
       * (_zbase = min(canvas.width/928, canvas.height/522) - viewport only). A world pixel is the
       * same screen pixel whatever size you are, so aim resolves in ABSOLUTE px. The old design
       * aimed for constant margin/reach ('k=1 = perfectly identical feel'), which is the correct
       * invariant only for a camera that scales with the snake. This one does not.
       *
       * So: solve for the margin that makes sink a CONSTANT S.
       *     margin = S - (1 - grazeHead)*Ra - (1 - bodyScale)*Rd
       * with S anchored so two ns=30 snakes - the reference the owner already knows - are
       * EXACTLY as they are today:
       *     S = grazePx + ((1-grazeHead) + (1-bodyScale)) * (SS_GRAZE_REF_REACH / 2)
       * grazePx still sets the difficulty and grazeHead/bodyScale still set where the reference
       * lands, so the panel keeps working. grazeScaleK is now INERT by design: its only job was
       * to create size dependence, and there is none left to shape.
       * margin may go negative (small circler, big trail) - that is correct and intended, it
       * just means the scaled reach undershoots and is added back. sink stays S > 0 either way,
       * so a circler can always make contact before it dies.
       */
      // ANCHOR: the difficulty is pinned to what the owner already knows as correct - a size-26
      // snake grazing a spawn-size (ns 30) circler. Owner, verbatim: 'DO LIKE 26 SIZE HARD'.
      // Every knob still does its old job (it sets WHERE the anchor lands); what has gone is the
      // size DEPENDENCE, so that one difficulty now applies at every size, for both snakes.
      // With the locked values this is S = 2.00px. Raise grazePx to make grazing more forgiving
      // (harder to land), lower it to make it easier - exactly as the slider always behaved.
      // BOTH NUMBERS ARE LITERAL PIXELS. grazePx IS the room, in px. SS_GRAZE_KILL_SINK IS the
      // kill depth, in px. No anchor arithmetic, no exponent, nothing to reinterpret - what the
      // panel shows is what the geometry does.
      // aCirc => the victim is the circler => this is a KILL, fixed depth. Anything else under
      // skimOn is somebody working around a circler, and they get the room instead.
      const _killSink = T.killSink != null ? T.killSink : SS_GRAZE_KILL_SINK;
      const _sinkWant = aCirc ? _killSink : skimMargin;
      const margin = skimOn
        ? _sinkWant - (1 - grazeHead) * RaBase - (1 - grazeBody) * Rd
        : 0;

      const reach = RaEff + RdEff, dpath = D.path;

      const killDist = reach - margin, killDist2 = killDist > 0 ? killDist * killDist : 0;

      const neck = skimOn
        ? SS_GRAZE_NECK_PTS                                              // circle graze: flat, see above
        : Math.max(2, Math.ceil((RaBase + Rd) / SS_POINT_DIST));         // normal body: unchanged

      const drawnEnd = bodyEndIdx(D);

      // trail danger length (graze only). CLAMPED to [0, drawnEnd] — never force it past the path end, or

      // dpath[k+1] reads undefined and crashes the tick. If it lands ≤ neck the loop just skips (safe).

      const end = skimOn ? Math.min(drawnEnd, Math.round(drawnEnd * grazeReach)) : drawnEnd;

      const kmax = Math.min(end, dpath.length - 1);            // hard bound: dpath[k+1] must exist (never crash the tick)

      let minD2 = Infinity;

      for (let si = 0; si < hsweep.length; si++) {

        for (let k = neck; k < kmax; k++) {

          const d2 = ssPtSegD2(hsweep[si].x, hsweep[si].y, dpath[k].x, dpath[k].y, dpath[k + 1].x, dpath[k + 1].y);

          if (d2 < minD2) minD2 = d2;

        }

      }

      if (minD2 === Infinity) continue;

      if (DBG) { const ov = (RaBase + Rd) - Math.sqrt(minD2); if (ov > nearOverlap) { nearOverlap = ov; nearTarget = D; nearSkimOn = skimOn; } }

      if (minD2 <= killDist2) { killD = D; killMargin = margin; killSkimOn = skimOn; killOverlap = (RaBase + Rd) - Math.sqrt(minD2); if (!DBG) break; } // fast path: stop at first kill

    }

    if (DBG && nearSkimOn && !killD && nearOverlap > 0) {

      A._skimReached = true;

      if (!A._skimLog || now - A._skimLog > 400) { A._skimLog = now;

        console.log(`[${lid}] CIRCLE-SKIM ${A.pid.slice(0,8)} SKIMMING overlapPx=${nearOverlap.toFixed(2)} margin=${skimMargin} head=${grazeHead} body=${grazeBody} reach=${grazeReach} SURVIVING vs ${nearTarget ? nearTarget.pid.slice(0,8) : '-'}`); }

    }

    if (killD) {

      if (DBG) {

        const windDeg = A._csWind != null ? Math.abs(A._csWind) * 180 / Math.PI : 0;

        const needDeg = (T.circDeg != null ? T.circDeg : 360);

        const RaEffK = RaBase * (killSkimOn ? grazeHead : 1);

        let n2nOv = -Infinity, n2nWho = null;

        for (const O of alive) { if (O === A) continue; const ov = (RaBase + R(O)) - Math.hypot(O.x - A.x, O.y - A.y); if (ov > n2nOv) { n2nOv = ov; n2nWho = O; } }

        if (killSkimOn) { if (!sg._circ) sg._circ = []; sg._circ.push(killOverlap); if (sg._circ.length > 100) sg._circ.shift(); }

        let mn = Infinity, mx = -Infinity; if (sg._circ) for (const v of sg._circ) { if (v < mn) mn = v; if (v > mx) mx = v; }

        const why = aCirc ? 'A-circling' : (killD.circleActive ? 'D-circling(grazing a circler)' : 'neither(normal touch)');

        console.log(`[${lid}] CIRCLE-DIAG DEATH dying=${A.pid.slice(0,8)} check=TRAIL skimOn=${killSkimOn}(${why}) aCircleActive=${aCirc} winding=${windDeg.toFixed(0)}/${needDeg}deg`

          + ` | trailOverlapPx=${killOverlap.toFixed(2)} vs=${killD.pid.slice(0,8)}(circleActive=${!!killD.circleActive}) marginApplied=${killMargin} head=${grazeHead} body=${grazeBody} reach=${grazeReach} effKillDist=${(RaEffK + R(killD) * (killSkimOn ? grazeBody : 1) - killMargin).toFixed(1)} baseReach=${(RaBase + R(killD)).toFixed(1)}`

          + ` | n2nOverlapPx=${n2nOv.toFixed(2)}(${n2nWho ? n2nWho.pid.slice(0, 8) : '-'}) skimApplied=${killSkimOn} skimReachedThisLife=${!!A._skimReached}`

          + (killSkimOn && sg._circ && sg._circ.length ? ` | last${sg._circ.length}: min=${mn.toFixed(2)} max=${mx.toFixed(2)} span=${(mx - mn).toFixed(2)}` : ''));

      }

      kill(A, killD, { stage: killSkimOn ? 'CIRCLE-TRAIL' : 'BODY', tick: sg.tick, t: now, overlap: +killOverlap.toFixed(2), margin: killMargin, skimOn: killSkimOn });

    }

  }



  // 2) N2N (normal head-on) — NOSE OUTLINE vs NOSE OUTLINE, bigger wins. The nose is the arc of each head's

  //    outline between the eyes (SS_NOSE_ARC). Contact between two circles happens on the line between the

  //    centres, so: heads' circles touch (dist ≤ Ra+Rd) AND that contact direction lies on BOTH snakes'

  //    nose arcs → the visible noses touched. Skipped for circling pairs (those are the graze above).

  for (let i = 0; i < alive.length; i++) {

    const A = alive[i]; if (died.has(A.pid) || A.circleActive) continue;

    for (let j = i + 1; j < alive.length; j++) {

      const D = alive[j]; if (died.has(D.pid) || D.circleActive) continue;

      const Ra = R(A), Rd = R(D);

      const dx = D.x - A.x, dy = D.y - A.y, dd = Math.hypot(dx, dy) || 1;

      if (dd > Ra + Rd) continue;                                                           // outlines not touching

      const aNose = (Math.cos(A.angle) * dx + Math.sin(A.angle) * dy) / dd;                 // contact dir vs A heading

      const dNose = (Math.cos(D.angle) * -dx + Math.sin(D.angle) * -dy) / dd;               // contact dir vs D heading

      if (aNose < noseCosMin || dNose < noseCosMin) continue;                               // contact not on both nose arcs

      let aWins; if (A.size === D.size) aWins = Math.random() < 0.5; else if (rule === 'smallest_wins') aWins = A.size < D.size; else if (rule === 'random') aWins = Math.random() < 0.5; else aWins = A.size > D.size;

      kill(aWins ? D : A, aWins ? A : D, { stage: 'N2N', reason: rule, tick: sg.tick, t: now });

    }

  }

}



function ssKill(victim, killer, lid, io, diag) {
  if (!victim.alive) return;
  // Cashout race (see ssTick timer): a kill while circling resolves the cashout as DIED — no payout,
  // money drops as food below. If the 6s timer already paid it, alive is false & we returned above, so
  // exactly one of {paid, died} ever happens.
  if (victim.cashing && !victim._cashResolved) { victim._cashResolved = 'died'; victim.cashing = false; }
  victim.alive = false;
  victim._killedAt = Date.now();
  victim._killedBy = (killer && killer.pid) ? String(killer.pid) : null;
  // ESCROW SAFETY: dead-flag the victim on the settlement server the instant they die, so a killed
  // player can NEVER cash out. Closes the double-spend where a stale/racing client settles after death
  // while the SAME $ also drops as food for the killer (root cause of escrow going short). Paid lobbies
  // only; bots have no wallet. Fire-and-forget (never blocks the tick).
  if (lid && lid.indexOf('paid') !== -1 && GAME_SECRET && victim.pid && String(victim.pid).indexOf('bot-') !== 0) {
    try {
      const _ts = Date.now();
      const _kAddr = (killer && killer.pid && String(killer.pid).indexOf('bot-') !== 0) ? String(killer.pid) : ''; const _proof = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victim.pid + ':' + _kAddr + ':' + _ts).digest('hex');
      const _su = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
      fetch(_su, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-game-proof': _proof, 'x-game-ts': String(_ts) },
        body: JSON.stringify({ action: 'elim-lock', victimAddress: victim.pid, killerAddress: _kAddr, lobbyId: lid }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    } catch (_) {}
  }
  const sg = ssGames.get(lid);
  // Kill-transfer: ONLY when the KILLER is mid-cashout, the victim's money goes straight into the
  // killer's cashout (added to usd, still escrow-capped) instead of dropping as floor food. Every other
  // death (regular circling, self-death, non-cashing killer) drops as food exactly as before.
  let _cashTransfer = false;
  if (killer && killer.cashing && !killer._cashResolved && killer.alive) {
    killer.usd = (Number(killer.usd) || 0) + (Number(victim.usd) || 0);
    victim.usd = 0;
    // The same transfer on the authoritative ledger. Banked into the killer's _lamFood — the same
    // bucket eaten gold food goes into — because from the money's point of view this IS the victim's
    // stake being collected, just handed over directly instead of via orbs on the floor. The victim's
    // ledger is cleared in the same breath, so the total across both snakes is unchanged.
    const _vLam = ssLamCarried(victim);
    if (_vLam > 0) killer._lamFood = (killer._lamFood || 0) + _vLam;
    victim._lamFood = 0; victim._lamBase = 0; victim._lamAuth = false;
    _stakeLam.delete(victim.pid);
    _cashTransfer = true;
  }
  if (sg) {
    if (!sg.food) sg.food = [];
    if (!_cashTransfer) ssSpawnKillFood(sg, victim);
    sg._foodDirty = true;
  }
  victim.segs = [];
  victim.path = [];
  io.to(lid).emit('elim', { id: victim.pid, killerId: killer ? killer.pid : null, diag: diag || null });
}



// ═══════════════════════════ P2P BETTING EXCHANGE (server side) ═══════════════════════════
// The server is authoritative for OUTCOMES ONLY — it never moves money. Its three jobs:
//   1. Sign the bettable-snake roster (so a client can't invent a subject that could never settle,
//      and so /api/settle can catch someone betting on their own snake from a second account).
//   2. Watch every live wager's subject and tell /api/settle who won (GAME_SECRET-HMAC).
//   3. Relay wager events from Vercel to spectators over the socket, so the UI is push-driven
//      with NO client polling.
// Additive: hooks are ssWagerTick() (once per ssTick) and ssWagerSendTo() (spectator connect).
const WG_ENABLED    = new Set((process.env.SS_WAGER_LOBBIES || '').split(',').map(s => s.trim()).filter(Boolean));
// Betting is enabled by the SHAPE of a lobby id, not by a hardcoded list of three of them. The old
// default was 'ss-test-lobby,ss-paid-lobby-1,ss-paid-lobby-5', so a player in the $0.20 room -- or
// $0.50, or any custom stake -- got no signed roster at all and the betting panel truthfully reported
// 'no snakes to bet on yet' while the arena was full of them. Exactly the bug that made custom-stake
// lobbies unwatchable: a static set cannot keep up with stakes players can invent.
// Any PAID arena is bettable; free lobbies deliberately are not (nothing is at stake to settle on).
// SS_WAGER_LOBBIES still works as an explicit ALLOW-list addition if a specific room ever needs it.
function wgEnabled(lid) {
  if (!lid) return false;
  if (WG_ENABLED.has(lid)) return true;
  return /^ss-(?:og-)?paid-lobby-\d+(?:\.\d+)?$/.test(String(lid)) || String(lid) === 'ss-test-lobby';
}
const WG_SETTLE_URL = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
// Falls back to REGION, which is what ecosystem.config.js actually sets. WG_REGION was never
// defined on either box, so the EU node silently signed every roster as 'NA' - and region is part
// of the signed canon, so EU wagers were recorded against the wrong region. Consistent enough to
// verify (both ends said NA) but wrong for anything that routes settlement by region.
const WG_REGION     = String(process.env.WG_REGION || process.env.REGION || 'NA').toUpperCase() === 'EU' ? 'EU' : 'NA';
const WG_ROSTER_MS  = 4000;    // how often the signed roster is rebroadcast
const WG_ROSTER_TTL = 180000;  // how long a signed roster entry stays valid
const WG_RECON_MS   = 20000;   // backstop re-sync of live wagers (survives a server restart)

const wgState   = new Map();   // lid -> { live:Map(id->w), fate:Map(pid->{outAt,how}), lastRoster, lastRecon }
const wgIpByPid = new Map();   // pid -> ipHash (populated on connect; used for self-bet detection)

function wgLobby(lid) {
  let s = wgState.get(lid);
  if (!s) { s = { live: new Map(), fate: new Map(), lastRoster: 0, lastRecon: 0 }; wgState.set(lid, s); }
  return s;
}
function wgHmac(str) { return crypto.createHmac('sha256', GAME_SECRET).update(str).digest('hex'); }
// Same construction as api/settle.js clientIpHash — raw IPs are never stored or transmitted.
function wgIpHash(ip) { return ip ? wgHmac('ip:' + String(ip).split(',')[0].trim()).slice(0, 16) : ''; }
function wgNoteIp(pid, socket) {
  if (!GAME_SECRET || !pid) return;
  try {
    const h = socket.handshake || {};
    const ip = (h.headers && (h.headers['x-forwarded-for'] || h.headers['x-real-ip'])) || h.address || '';
    const hash = wgIpHash(ip);
    if (hash) wgIpByPid.set(String(pid), hash);
  } catch (_) {}
}

// A snake is bettable once it is a real (non-bot) alive wallet snake.
function wgBettableSnakes(sg) {
  const out = [];
  for (const sn of sg.snakes.values()) {
    if (!sn.alive) continue;
    if (!sn.pid || String(sn.pid).indexOf('bot-') === 0 || String(sn.pid).length < 20) continue;
    out.push(sn);
  }
  return out;
}
// Signed roster entry — the exact canon api/settle.js verifySnakeSig() recomputes.
function wgRosterEntry(lid, sn, exp) {
  const name = sn.name || 'SNAKE';
  const ipHash = wgIpByPid.get(String(sn.pid)) || '';
  return {
    pid: sn.pid, name, color: sn.color || '#39FF14', usd: sn.usd || 0, ipHash, exp,
    // NAME IS NOT SIGNED. This proof only establishes "this pid is a live snake in this arena";
    // the display name is cosmetic and MUTABLE. Binding it meant that the moment a player renamed
    // (or their name reset to the default 'SNAKE' mid-session) every signature they held stopped
    // verifying - their snake silently failed validation, a duel's opponent never got recorded, and
    // the wager could never settle. api/settle.js accepts this nameless form and still accepts the
    // old name-bound one during rollout.
    sig: wgHmac('snake:' + WG_REGION + ':' + lid + ':' + sn.pid + ':' + ipHash + ':' + exp),
  };
}
// Everything currently on this arena's book (open + matched). Sent WITH the roster so a client that
// missed a live push — Vercel hiccup, brief disconnect, tab wake — re-syncs within one roster tick.
// Self-healing without the client ever polling.
function wgOpenBook(lid) {
  const s = wgLobby(lid);
  const out = [];
  for (const w of s.live.values()) {
    if (w && w.id && (w.status === 'open' || w.status === 'matched')) out.push(w);
    if (out.length >= 60) break;
  }
  return out;
}
function wgBroadcastRoster(lid, sg, io) {
  const exp = Date.now() + WG_ROSTER_TTL;
  const snakes = wgBettableSnakes(sg).map(sn => wgRosterEntry(lid, sn, exp));
  try { io.to(lid).emit('ss-wager-roster', { region: WG_REGION, lobby: lid, snakes, wagers: wgOpenBook(lid) }); } catch (_) {}
}
function wgSendRosterTo(socket, lid, sg) {
  const exp = Date.now() + WG_ROSTER_TTL;
  const snakes = wgBettableSnakes(sg).map(sn => wgRosterEntry(lid, sn, exp));
  try { socket.emit('ss-wager-roster', { region: WG_REGION, lobby: lid, snakes, wagers: wgOpenBook(lid) }); } catch (_) {}
}

// ── outcome reporting (server → settle) ──────────────────────────────────────
function wgPostSettle(w, winningSide) {
  if (!GAME_SECRET) return;
  const ts = Date.now();
  const proof = wgHmac('wager-settle:' + w.id + ':' + winningSide + ':' + ts);
  w._retryAt = ts + 15000;
  fetch(WG_SETTLE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify({ action: 'wager-settle', wagerId: w.id, winningSide }),
    signal: AbortSignal.timeout(20000),
  }).then(r => r.json()).then(d => { if (d && d.ok) { w._settled = true; } else { console.error('[wg] settle REFUSED ' + w.id + ' ' + JSON.stringify(d || {}).slice(0, 240)); } }).catch(e => { console.error('[wg] settle POST FAILED ' + w.id + ' ' + ((e && e.message) || e)); });
}
function wgPostReturn(w) {
  if (!GAME_SECRET) return;
  const ts = Date.now();
  const proof = wgHmac('wager-return:' + w.id + ':' + ts);
  w._retryAt = ts + 15000;
  fetch(WG_SETTLE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify({ action: 'wager-return', wagerId: w.id }),
    signal: AbortSignal.timeout(20000),
  }).then(r => r.json()).then(d => { if (d && d.ok) { w._settled = true; } else { console.error('[wg] settle REFUSED ' + w.id + ' ' + JSON.stringify(d || {}).slice(0, 240)); } }).catch(e => { console.error('[wg] settle POST FAILED ' + w.id + ' ' + ((e && e.message) || e)); });
}
// Pull the authoritative open/live wager set for this arena (backstop after a server restart).
function wgReconcile(lid) {
  fetch(WG_SETTLE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'wager-list', region: WG_REGION, lobby: lid }),
    signal: AbortSignal.timeout(10000),
  }).then(r => r.json()).then(d => {
    if (!d || !d.ok) return;
    const s = wgLobby(lid);
    const all = [].concat(d.live || [], d.open || []);
    for (const w of all) {
      const cur = s.live.get(w.id);
      s.live.set(w.id, Object.assign({}, cur || {}, w));
    }
  }).catch(() => {});
}

// Record how/when each snake left the arena — the raw material for every bet type.
function wgTrackFate(lid, sg) {
  const s = wgLobby(lid);
  for (const sn of sg.snakes.values()) {
    const pid = String(sn.pid || ''); if (!pid) continue;
    if (sn.alive) continue;
    // Same rule as wgNoteExit: record the most recent exit, never freeze the first one.
    var _prevT = s.fate.get(pid); var _atT = sn._killedAt || Date.now();
    if (_prevT && Number(_prevT.outAt || 0) >= _atT) continue;
    // 'paid' = completed a cash-out (banked the money); anything else = died/forfeited.
    s.fate.set(pid, { outAt: sn._killedAt || Date.now(), how: sn._cashResolved === 'paid' ? 'paid' : 'died', by: sn._killedBy || null });
  }
}
// Has this snake left, and how? Returns null while it is still in the arena.
function wgNoteExit(lid, sn) {
  try {
    if (!sn || !sn.pid) return;
    if (!wgEnabled(lid)) return;   // don't spin up wager state for free lobbies
    var _s = wgLobby(lid); var _p = String(sn.pid);
    // Keep the LATEST exit, not the first. This map is never cleared for the life of the process,
    // so refusing to overwrite froze a player's EARLIER death in place: a later, real kill was never
    // recorded, and once stale fates are ignored the wager could never settle at all. A snake can
    // die, respawn and die again - the most recent exit is the truth.
    var _prevN = _s.fate.get(_p); var _atN = sn._killedAt || Date.now();
    if (_prevN && Number(_prevN.outAt || 0) >= _atN) return;
    _s.fate.set(_p, { outAt: sn._killedAt || Date.now(), how: sn._cashResolved === 'paid' ? 'paid' : 'died', by: sn._killedBy || null });
  } catch (_) {}
}
function wgFateOf(s, sg, pid, sinceTs) {
  const f = s.fate.get(String(pid));
  // ⚠ A fate recorded BEFORE this wager was placed must never settle it. s.fate is a per-lobby map
  // that is never cleared for the life of the process, so a player who died earlier in the session
  // still had a death on record. The instant a new bet on them was matched, that STALE death
  // resolved it — 'instantly said bet lost when we didn't even fight or die'. Only exits that happen
  // after the bet is live count.
  if (f && (!sinceTs || Number(f.outAt || 0) >= Number(sinceTs))) return f;
  if (f) return null;   // stale death: treat as undecided, not as an outcome
  const sn = sg.snakes.get(pid);
  if (!sn) return null;   // UNDECIDED. Never fabricate an exit time: doing so made whoever left FIRST look like they lasted LONGEST.
  return null;
}

// Decide a wager from live game truth. Returns the winning side, or null if not decided yet.
function wgDecide(s, sg, w) {
  const now = Date.now();
  // Only deaths/cash-outs from AFTER this wager went live may decide it.
  const _since = Number(w.matchedTs || w.createdTs || 0);
  if (w.type === 'cashout') {
    const f = wgFateOf(s, sg, w.subject, _since);
    if (!f) return null;
    return f.how === 'paid' ? 'YES' : 'NO';
  }
  if (w.type === 'survive') {
    const f = wgFateOf(s, sg, w.subject, _since);
    const deadline = Number(w.resolveTs || 0);
    if (f && f.how === 'died' && (!deadline || f.outAt < deadline)) return 'NO';   // died before the bell
    if (f && f.how === 'paid') return 'YES';                                       // banked it = survived
    if (deadline && now >= deadline) return 'YES';                                 // still in at the bell
    return null;
  }
  if (w.duel) {
    // A duel is CREATED with subject2 = null (the opponent is whoever accepts) and only filled in at
    // accept time from reservedSubject2. If that capture ever misses, subject2 stays null and the
    // killer's id got compared against the string "null" - so a REAL kill never matched and the duel
    // sat on LIVE forever without paying anyone. In a duel BOTH players back their own snake and a
    // snake's pid IS their wallet, so creator/acceptor are exact fallbacks.
    var _dA = w.subject || w.creator, _dB = w.subject2 || w.acceptor;
    var _fa = wgFateOf(s, sg, _dA, _since), _fb = wgFateOf(s, sg, _dB, _since);
    if (_dB && _fa && _fa.by && String(_fa.by) === String(_dB)) return 'B';
    if (_dA && _fb && _fb.by && String(_fb.by) === String(_dA)) return 'A';
    return null;
  }
  if (w.type === 'outlast') {
    const fa = wgFateOf(s, sg, w.subject, _since), fb = wgFateOf(s, sg, w.subject2, _since);
    if (!fa && !fb) return null;
    if (fa && !fb) return 'B';               // A left first, B still in → B outlasted A
    if (fb && !fa) return 'A';
    if (fa.outAt === fb.outAt) return null;  // exact tie — wait a tick
    return fa.outAt > fb.outAt ? 'A' : 'B';
  }
  return null;
}

// ── the tick ─────────────────────────────────────────────────────────────────
function ssWagerTick(lid, sg, io) {
  if (!GAME_SECRET || !wgEnabled(lid) || !sg) return;
  const now = Date.now();
  const s = wgLobby(lid);

  wgTrackFate(lid, sg);

  if (now - s.lastRoster > WG_ROSTER_MS) { s.lastRoster = now; wgBroadcastRoster(lid, sg, io); }
  if (now - s.lastRecon  > WG_RECON_MS)  { s.lastRecon  = now; wgReconcile(lid); }

  for (const [id, w] of s.live) {
    if (w._settled) { s.live.delete(id); continue; }
    if (w._retryAt && now < w._retryAt) continue;
    if (w.status === 'matched') {
      const side = wgDecide(s, sg, w);
      if (side) wgPostSettle(w, side);
    } else if (w.status === 'open' || w.status === 'reserved') {
      // 'reserved' included: a claim whose deposit never landed was handled NOWHERE, so the
      // creator's stake sat in escrow forever. Nobody took it before the window closed → creator gets 100% back, no fee.
      if (now >= Number(w.lockTs || 0)) wgPostReturn(w);
    } else if (w.status === 'settled' || w.status === 'returned' || w.status === 'cancelled') {
      s.live.delete(id);
    }
  }
}

// Recovery sweep on its own timer. ssWagerTick only runs while an arena is actually being
// simulated, so a wager stranded in an EMPTY lobby had nothing to rescue it.
function wgSweep() {
  if (!GAME_SECRET) return;
  const ts = Date.now();
  const proof = wgHmac('wager-sweep:' + ts);
  fetch(WG_SETTLE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: JSON.stringify({ action: 'wager-sweep' }),
    signal: AbortSignal.timeout(25000),
  }).then(r => r.json()).then(d => {
    if (d && d.ok && (d.reverted || d.returned)) console.log('[wg] sweep reverted=' + d.reverted + ' returned=' + d.returned);
  }).catch(() => {});
}
if (GAME_SECRET) setInterval(wgSweep, 60000);

// Give a newly-connected spectator the current roster so they can bet immediately.
function ssWagerSendTo(socket, lid) {
  try {
    if (!wgEnabled(lid)) return;
    const sg = ssGames.get(lid); if (!sg) return;
    wgSendRosterTo(socket, lid, sg);
  } catch (_) {}
}




function getOrCreateRoom(lobbyId) {

  if (!rooms.has(lobbyId)) {

    const maze = freshMaze();

    placePowerups(maze);

    rooms.set(lobbyId, {

      lobbyId, maze,

      players: new Map(),   // pid → player

      powRespawnQ: [],

      eatLog: [],

      frm: 0, pkTick: 0, pkSent: 0,

      interval: null

    });

  }

  return rooms.get(lobbyId);

}



let _si = 0;

function nextSpawn() { const s = SPAWNS[_si++ % SPAWNS.length]; return { x: s.x, y: s.y }; }



// ── Game logic (authoritative — runs on server) ───────────────────────────────

function movePlayer(p, room) {

  if (!p.alive) return;

  if (p.disconnected) return; // frozen during grace — don't drift into walls/deaths

  // Accumulator-based speed — matches client moveP() so speed is identical to old host-side.

  // Base 0.2185/tick → ~4.6 ticks/cell → ~6.6 cells/sec at TICK_MS=33.

  const spd = p.pep && p.pet > 0 ? 0.2185 * 1.55 : p.pow && p.pt > 0 ? 0.2185 * 1.25 : 0.2185;

  p.mc = (p.mc || 0) + spd;

  if (p.mc < 1) {

    // Powerup timers still tick even when not moving a cell

    if (p.pow && p.pt > 0 && --p.pt <= 0) p.pow = false;

    if (p.pep && p.pet > 0 && --p.pet <= 0) p.pep = false;

    return;

  }

  p.mc -= 1;

  // Try to turn if requested

  if (p.nx !== 0 || p.ny !== 0) {

    const tnx = p.x + p.nx, tny = p.y + p.ny;

    const tunnelTurn = p.y === 17 && tny === 17 && (tnx < 0 || tnx >= C);

    if (tunnelTurn || (tnx >= 0 && tnx < C && tny >= 0 && tny < R && room.maze[tny][tnx] !== 1)) {

      p.dx = p.nx; p.dy = p.ny;

    }

  }

  // Move in current direction

  const tx = p.x + p.dx, ty = p.y + p.dy;

  if (p.y === 17 && ty === 17 && (tx < 0 || tx >= C)) {

    // Tunnel wrap: row 17 horizontal exit

    p.prevX = p.x; p.prevY = p.y;

    p.x = tx < 0 ? C - 1 : 0;

    p.y = 17;

  } else if (tx >= 0 && tx < C && ty >= 0 && ty < R && room.maze[ty][tx] !== 1) {

    p.prevX = p.x; p.prevY = p.y;

    p.x = tx; p.y = ty;

  }

  // Powerup timers

  if (p.pow && p.pt > 0 && --p.pt <= 0) p.pow = false;

  if (p.pep && p.pet > 0 && --p.pet <= 0) p.pep = false;

}



function eatCell(p, room) {

  const v = room.maze[p.y][p.x];

  if (v === 2) {

    room.maze[p.y][p.x] = 0; p.sc += 10;

    room.eatLog.push([p.y, p.x, 0]);

  } else if (v === 3 || v === 4) {

    const type = v === 3 ? 'cherry' : 'pepper';

    const isActive = type === 'cherry' ? p.pow : p.pep;

    if (!p.held) p.held = [];

    const canPickup = !isActive && !p.held.includes(type) && p.held.length < 2;

    if (canPickup) {

      room.maze[p.y][p.x] = 0; p.sc += 50;

      p.held.push(type);

      room.eatLog.push([p.y, p.x, 0]);

      room.powRespawnQ.push({ type: v, at: room.frm + (v === 3 ? CHERRY_RESPAWN : PEPPER_RESPAWN) });

    }

  } else if (v === 5) {

    if (!p.held) p.held = [];

    const _mOrd = Math.random() < 0.5 ? ['cherry','pepper'] : ['pepper','cherry'];

    for (const _mT of _mOrd) {

      const _mAct = _mT === 'cherry' ? p.pow : p.pep;

      if (!_mAct && !p.held.includes(_mT) && p.held.length < 2) {

        room.maze[p.y][p.x] = 0; p.sc += 75;

        p.held.push(_mT);

        room.eatLog.push([p.y, p.x, 0]);

        room.powRespawnQ.push({ type: 5, at: room.frm + MYSTERY_RESPAWN });

        break;

      }

    }

  }

}



function checkCollisions(room, io) {

  const alive = [...room.players.values()].filter(p => p.alive && !p.disconnected);

  for (let i = 0; i < alive.length; i++) {

    for (let j = i + 1; j < alive.length; j++) {

      const a = alive[i], b = alive[j];

      const same = a.x === b.x && a.y === b.y;

      const crossed = a.x === (b.prevX ?? b.x) && a.y === (b.prevY ?? b.y) &&

                      b.x === (a.prevX ?? a.x) && b.y === (a.prevY ?? a.y);

      if (!same && !crossed) continue;

      if (a.pow && !b.pow) { a.sc += 300; elim(b, a.id, room, io); }

      else if (b.pow && !a.pow) { b.sc += 300; elim(a, b.id, room, io); }

    }

  }

}



function elim(victim, killerId, room, io) {

  victim.alive = false;

  // Sign the kill so settle.js can verify it came from the real game server, not a console call

  const killTs = Date.now();

  const killProof = GAME_SECRET

    ? crypto.createHmac('sha256', GAME_SECRET).update(`${killerId}:${victim.id}:${killTs}`).digest('hex')

    : null;

  const elimData = { id: victim.id, killerId, victimSol: victim.sol || 0, killProof, killTs };

  // Block victim cashout on the settlement server BEFORE broadcasting the kill to clients.

  // Delaying the elim event by ~50-100ms ensures dead: is set before the killer's client

  // even knows to call settle/kill -- closing the window where victim cashout races the kill.

  if (victim.id && GAME_SECRET) {

    const adminSecret = (process.env.ADMIN_SECRET || '').trim();

    const settleUrl = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';

    fetch(settleUrl, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret },

      body: JSON.stringify({ action: 'elim-lock', victimAddress: victim.id }),

      signal: AbortSignal.timeout(5000),

    }).then(() => {

      io.to(room.lobbyId).emit('elim', elimData);

    }).catch(e => {

      console.warn('[elim] cashout lock failed:', e.message);

      io.to(room.lobbyId).emit('elim', elimData); // emit regardless so game never gets stuck

    });

  } else {

    io.to(room.lobbyId).emit('elim', elimData);

  }

}



function tick(room, io) {

  room.frm++;

  // Powerup respawns

  for (let i = room.powRespawnQ.length - 1; i >= 0; i--) {

    const r = room.powRespawnQ[i];

    if (room.frm >= r.at) {

      const s = rndPowSpot(room.maze);

      if (s) { room.maze[s.y][s.x] = r.type; room.eatLog.push([s.y, s.x, r.type]); }

      room.powRespawnQ.splice(i, 1);

    }

  }

  room.players.forEach(p => { movePlayer(p, room); eatCell(p, room); });

  checkCollisions(room, io);



  // Broadcast at ~20fps (every 2 ticks)

  room.pkTick++;

  if (room.pkTick % 2 === 0) {

    room.pkSent++;

    const ps = [];

    room.players.forEach((p, id) => {

      const hN = (p.held?.includes('cherry') ? 1 : 0) | (p.held?.includes('pepper') ? 2 : 0);

      ps.push([id, p.x, p.y, p.dx, p.dy, p.sc, p.alive ? 1 : 0,

               p.pow ? 1 : 0, p.pt || 0, p.pep ? 1 : 0, p.pet || 0, hN]);

    });

    const msg = { ps };

    msg.spec = [...room.players.values()].filter(p => !p.alive).length;

    if (room.pkSent % 40 === 0) msg.maze = room.maze;

    else if (room.eatLog.length) { msg.eat = room.eatLog; room.eatLog = []; }

    else room.eatLog = [];

    io.to(room.lobbyId).emit('s', msg);

  }

}



// ── Server setup ──────────────────────────────────────────────────────────────

const app = express();

// Single source of truth for CORS on the plain HTTP routes below (/health, /counts, etc).

// socket.io has its own separate `cors` option a few lines down for the /socket.io/* path —

// that's fine, they never overlap on the same request. What must NEVER happen is nginx (in

// front of this process) ALSO adding its own Access-Control-Allow-Origin on top of either of

// these: two ACAO headers on one response is invalid per the CORS spec ("only one value

// allowed") and browsers hard-reject it — exactly the bug reported 2026-07-05. nginx's

// add_header lines were removed for this reason; this Express middleware is the only place

// HTTP-route CORS headers are set now.

app.use((req, res, next) => {

  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);

  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  next();

});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

// ── /wager-event — Vercel pushes betting-exchange events here; we relay to spectators ────
// This is what makes the betting UI push-driven (NO client polling). Authenticated with the same
// GAME_SECRET-HMAC as elim-lock, so only our own /api/settle can publish. Touches no money.
app.post('/wager-event', express.json({ limit: '64kb' }), (req, res) => {
  try {
    const gp  = (req.headers['x-game-proof'] || '').toString().trim();
    const gts = Number(req.headers['x-game-ts'] || 0);
    const body = req.body || {};
    const lobby = String(body.lobby || '');
    if (!GAME_SECRET || !gp || !gts || Math.abs(Date.now() - gts) > 300000) return res.status(403).json({ error: 'Forbidden' });
    const expected = crypto.createHmac('sha256', GAME_SECRET).update('wager-event:' + lobby + ':' + gts).digest('hex');
    let okAuth = false;
    try { okAuth = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) {}
    if (!okAuth) return res.status(403).json({ error: 'Forbidden' });
    const event = String(body.event || '');
    const wager = body.wager || null;
    if (wager && wager.id) {
      const s = wgLobby(lobby);
      if (event === 'settled' || event === 'returned' || event === 'cancelled') s.live.delete(wager.id);
      else s.live.set(wager.id, Object.assign({}, s.live.get(wager.id) || {}, wager));
    }
    io.to(lobby).emit('ss-wager', { event, wager });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'wager-event failed' });
  }
});

/*
 * SIGNED BETTABLE ROSTER OVER HTTP.
 *
 * The roster was only ever pushed over the game socket (ss-wager-roster), so the only place a bet
 * could be CREATED was inside a live arena with a socket already open. The hub's /bets page has no
 * socket, which is why it could list and take bets but never open one.
 *
 * This is the same data and the same signatures wgRosterEntry already builds - nothing new is
 * trusted and nothing new is signable. The signature still binds (region, lobby, pid, ipHash, exp),
 * so a roster fetched here can only ever create a wager on a snake that really is live in that
 * arena, and it still expires.
 *
 * Public read: it discloses who is currently racing for money, which the spectator view and the
 * lobby counts already show.
 */
app.get('/wager-roster', (_, res) => {
  try {
    const exp = Date.now() + WG_ROSTER_TTL;   // same TTL the socket push uses - one expiry rule, not two
    const arenas = [];
    for (const [lid, sg] of ssGames) {
      if (!lid.startsWith('ss-')) continue;
      const snakes = wgBettableSnakes(sg);
      if (!snakes.length) continue;
      arenas.push({
        lobby: lid,
        region: WG_REGION,
        subjects: snakes.map((sn) => wgRosterEntry(lid, sn, exp)),
      });
    }
    res.json({ ok: true, region: WG_REGION, exp, arenas });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || 'roster failed' });
  }
});

app.get('/counts', (_, res) => {
  const counts = {};
  const players = {};
  const ssData = (lid) => {
    const sg = ssGames.get(lid);
    if (!sg || !sg.snakes) return { n: 0, names: [] };
    let n = 0; const names = [];
    for (const [pid, sn] of sg.snakes) {
      if (sn && sn.alive && !sn.disconnected && !(typeof pid === 'string' && pid.indexOf('bot-') === 0)) { n++; if (sn.name) names.push(String(sn.name).slice(0, 16)); }
    }
    return { n, names };
  };
  // PAC ARENA rooms keep players in room.players — the exact analogue of a snake lobby's sg.snakes —
  // so report the same ALIVE count + names instead of the raw socket count (which also counted
  // spectators and un-reaped sockets, and carried no names at all).
  const pacData = (lid) => {
    const room = rooms.get(lid);
    if (!room || !room.players) {
      const r = io.sockets.adapter.rooms.get(lid);
      return { n: r ? r.size : 0, names: [] };
    }
    let n = 0; const names = [];
    for (const [, p] of room.players) {
      if (p && p.alive && !p.disconnected) { n++; if (p.name) names.push(String(p.name).slice(0, 16)); }
    }
    return { n, names };
  };
  const FIXED = ['free-lobby', 'ss-free-lobby', 'ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-25',
                 'ss-og-free-lobby', 'ss-og-paid-lobby-1', 'ss-og-paid-lobby-5'];
  for (const id of FIXED) {
    const d = id.indexOf('ss-') === 0 ? ssData(id) : pacData(id);
    counts[id] = d.n; players[id] = d.names;
  }
  for (const [lid] of ssGames) {
    if (typeof lid === 'string' && (lid.indexOf('ss-paid-lobby-') === 0 || lid.indexOf('ss-og-paid-lobby-') === 0) && !(lid in counts)) { const d = ssData(lid); counts[lid] = d.n; players[lid] = d.names; }
  }
  // Dynamic PAC lobbies (any custom stake) — enumerate the ROOMS map, not socket rooms, so a lobby
  // reports the same way whether or not anyone is currently connected to its socket room.
  for (const [rid] of rooms) {
    if (typeof rid === 'string' && rid.indexOf('paid-lobby-') === 0 && !(rid in counts)) { const d = pacData(rid); counts[rid] = d.n; players[rid] = d.names; }
  }
  counts._players = players;
  res.json(counts);
});



const httpServer = http.createServer(app);

const io = new Server(httpServer, {

  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },

  pingInterval: 25000,

  // 20s was tight enough that a backgrounded/throttled tab could miss enough pongs to trigger a

  // real socket.io disconnect on its own, on top of the input-silence (SS_GHOST_MS) path. Wagers

  // are now protected either way (see SS_DISCONNECT_GRACE_MS), but there's no reason to force an

  // avoidable reconnect for a tab that's still technically alive, just slow to respond.

  pingTimeout: 60000,

  transports: ['websocket', 'polling'],

  perMessageDeflate: false

});



io.on('connection', socket => {



  // ── VOICE-ONLY connection (Blackjack PVP tables) ───────────────────────────────────────────────

  // Blackjack is poll-based HTTP on the platform and owns no socket, so a table opens one here purely

  // to reach the same PCM relay the snake lobbies use. Deliberately its own branch that RETURNS

  // immediately: no game listeners are ever registered on this socket, so — exactly like the

  // spectator branch — there is no code path here that could spawn a snake, move one, or touch money,

  // even from a hand-crafted client. It can only forward audio to its own room.

  if (socket.handshake.auth && socket.handshake.auth.voice === true) {

    const vroom = String(socket.handshake.auth.room || '');

    const vpid  = String(socket.handshake.auth.pid || '');

    const vname = String(socket.handshake.auth.name || '').slice(0, 16);

    // Only blackjack table rooms, and only sane ids — never an arbitrary string that could collide

    // with a real lobby room and leak audio into a game.

    if (!/^bj:[A-Za-z0-9_-]{4,40}$/.test(vroom) || !vpid || vpid.length > 64) { socket.disconnect(); return; }

    socket.isVoiceOnly = true;

    socket.join(vroom);

    io.to(vroom).emit('voice-peer', { pid: vpid, name: vname, joined: true });

    socket.on('voice-audio', (buf) => {

      // Same direct per-socket relay the lobby path uses (avoids room-broadcast edge cases). Size-

      // capped so a modified client cannot use the relay as an amplifier.

      if (!buf || (buf.byteLength || buf.length || 0) > 65536) return;

      const roomSocks = io.sockets.adapter.rooms.get(vroom);

      if (!roomSocks) return;

      roomSocks.forEach(sid => {

        if (sid === socket.id) return;

        const s = io.sockets.sockets.get(sid);

        if (s) s.emit('voice-audio', { from: vpid, buf });

      });

    });

    socket.on('disconnect', () => { io.to(vroom).emit('voice-peer', { pid: vpid, name: vname, joined: false }); });

    console.log(`[${vroom}] voice-only peer ${vpid.slice(0, 8)} connected`);

    return;

  }

  // ── Read-only spectator connection (Discord "watch live" links etc.) ─────────────

  // Deliberately handled as its own branch, completely separate from the real player-join

  // logic below, and returns immediately: no game token is checked (none is issued or needed —

  // there is nothing here to pay for), no room.players/sg.snakes entry is ever created for this

  // socket, and NO input/action listeners (ssin, ss, cashout, disconnect-grace, etc.) are ever

  // registered on it. That last part is what actually makes this safe against a modified client:

  // even if someone hand-crafts a fake 'ssin' or cashout emit, the server never attached a

  // listener for those events on a spectator socket, so there is no code path here that could

  // ever spawn a snake, move one, or send money — not a permission check that could be bypassed,

  // but a listener that was simply never wired up in the first place.

  if (socket.handshake.auth && socket.handshake.auth.spectate === true) {

    const watchLobbyId = socket.handshake.auth.lobbyId;

    if (!isSpectatableLobby(watchLobbyId)) {
      // Tell the client WHY instead of dropping the socket silently — a bare disconnect is
      // indistinguishable from a network fault and shows up as "connection lost, reconnecting".
      socket.emit('ss-notice', 'That arena is no longer live');
      socket.disconnect();
      return;
    }

    socket.isSpectator = true;

    socket.join(watchLobbyId);

    if (watchLobbyId.startsWith('ss-')) {

      const sg = ssGames.get(watchLobbyId);

      if (sg) {

        ssSendJoinBodies(socket, sg, '__spectator__'); // full current bodies, frame one

        ssBroadcastStateTo(socket, sg);                // immediate snapshot, don't wait ~33ms for the next tick

      }

      ssWagerSendTo(socket, watchLobbyId);             // hand this spectator the bettable-snake roster

    } else {

      // Legacy Pac-Man room — same 'init' shape a real joiner gets, so a spectator's client

      // can call its normal initGame(players) path. rooms.get (not getOrCreateRoom) on purpose:

      // never spin up a fresh empty room/game-loop just because a spectator looked at it.

      const room = rooms.get(watchLobbyId);

      if (room) {

        socket.emit('init', {

          pid: '__spectator__',

          maze: room.maze,

          spec: [...room.players.values()].filter(p => !p.alive).length,

          players: [...room.players.values()].map(p => ({

            id: p.id, name: p.name, color: p.color,

            x: p.x, y: p.y, dx: p.dx, dy: p.dy,

            sc: p.sc, alive: p.alive, num: p.num, sol: p.sol

          }))

        });

      }

    }

    console.log(`[${watchLobbyId}] spectator connected (read-only, no token)`);

    // ── Spectator chat + voice ───────────────────────────────
    // Watching is the social half of this game and it was silent: no listeners were registered here
    // at all, so a spectator could neither type nor talk. These two are safe to add because neither
    // touches game or money state — everything else stays unregistered, so the branch keeps the
    // property that makes it trustworthy: there is still no code path from a watching socket to a
    // snake, an input, or a payout.
    const specName = String((socket.handshake.auth && socket.handshake.auth.name) || 'WATCHER')
      .replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 16) || 'WATCHER';
    // Namespaced id: can never collide with a real wallet pid, so a client keying by id cannot be
    // tricked into treating a watcher as a player.
    const specId = '__spec__' + Math.random().toString(36).slice(2, 10);

    // Rate limit. A watcher needs no token and costs nothing to create, so this is the one place an
    // anonymous socket can generate load and nuisance for everyone in the room.
    let specLast = 0, specBurst = 0;
    socket.on('chat', ({ text }) => {
      if (typeof text !== 'string') return;
      const t = text.trim().slice(0, 100);
      if (!t) return;
      const now = Date.now();
      if (now - specLast < 1200) { if (++specBurst > 3) return; } else { specBurst = 0; }
      specLast = now;
      // spec:true is NOT decoration — a watcher's name is self-asserted and unverified, so the client
      // must be able to show it apart from a real player's line. Without it anyone could type as
      // somebody who is actually staking money in the room.
      io.to(watchLobbyId).emit('chat', { id: specId, name: specName, text: t, spec: true });
    });

    // Voice: the same relay the players' path uses, so a watcher is just another peer in the room.
    socket.on('voice-ready', () => {
      socket.to(watchLobbyId).emit('voice-ready', { from: specId, spec: true });
    });
    socket.on('voice-signal', ({ toPid, type, sdp, candidate }) => {
      socket.to(watchLobbyId).emit('voice-signal', { from: specId, toPid, type, sdp, candidate });
    });
    socket.on('voice-audio', (buf) => {
      // Size-capped so the relay cannot be used as an amplifier by a modified client — same cap as
      // the blackjack voice-only path.
      if (!buf || (buf.byteLength || buf.length || 0) > 65536) return;
      const roomSocks = io.sockets.adapter.rooms.get(watchLobbyId);
      if (!roomSocks) return;
      roomSocks.forEach(sid => {
        if (sid === socket.id) return;
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('voice-audio', { from: specId, buf, spec: true });
      });
    });

    // NO "is now watching" announcement. Socket.io reconnects, and an unstable spectator link
    // would republish it on every cycle — the reconnect storms already seen here run to hundreds of
    // cycles, which would bury a live arena's chat in joins. Presence belongs in the spectator
    // count, which is already broadcast; chat is for what people actually say.

    socket.on('disconnect', () => {
      io.to(watchLobbyId).emit('voice-peer', { pid: specId, name: specName, joined: false, spec: true });
    }); // no player/snake state was ever created — nothing else to clean up

    return;

  }



  socket.walletAddress = (socket.handshake.auth && socket.handshake.auth.pid) || null;

  // Fingerprint this player's network (hashed, never stored raw) so the betting exchange can tell
  // when someone tries to back their own snake from a second account. See wgSelfBetCheck in settle.
  try { wgNoteIp(socket.walletAddress, socket); } catch (_) {}

  socket.playerName    = (socket.handshake.auth && socket.handshake.auth.name) || '';

  socket.joinedAt      = Date.now();



  const { gameToken, lobbyId, pid, name, color, wagerSol } = socket.handshake.auth;



  // Validate lobby

  if (!lobbyId) { socket.disconnect(); return; }

  const isPaid = lobbyId !== 'free-lobby' && lobbyId !== 'ss-free-lobby' && lobbyId !== 'ss-og-free-lobby' && lobbyId !== SS_TEST_LOBBY;



  const room = getOrCreateRoom(lobbyId);

  const existing = room.players.get(pid);



  // Paid lobby gate — fail CLOSED: no GAME_SECRET means misconfigured server, deny entry

  if (isPaid) {

    console.log(`[${lobbyId}] connection pid=${pid&&pid.slice(0,8)} hasToken=${!!gameToken} existing=${!!existing} alive=${existing&&existing.alive} gsSet=${!!GAME_SECRET}`);

    if (!GAME_SECRET) {

      socket.emit('err', 'Server not configured for paid lobbies — contact admin');

      socket.disconnect(); return;

    }

    // Alive reconnects (socket drop while still playing) skip token re-check — already validated.

    // Fresh joins AND dead-player reconnects must prove a new payment with a recent token.

    const isAliveReconnect = existing && existing.alive;

    if (!isAliveReconnect) {

      const tokenValid = validateGameToken(gameToken, lobbyId, pid);

      console.log(`[${lobbyId}] token valid=${tokenValid} alreadyUsed=${_usedGameTokens.has(gameToken)} existing=${!!existing}`);

      if (!tokenValid) {

        socket.emit('err', 'Invalid entry token — pay to join');

        socket.disconnect(); return;

      }

      // Dead-player reconnect: token must be freshly minted (<=5 min) and never used before.

      // This blocks reuse of the original join token after elimination — new payment required.

      if (existing && !existing.alive) {

        const tokenTs = (() => { try { const {data} = JSON.parse(Buffer.from(gameToken, 'base64url').toString()); return parseInt(data.split(':')[2]); } catch (_) { return 0; } })();

        if (Date.now() - tokenTs > 300_000 || _usedGameTokens.has(gameToken)) {

          console.log(`[${lobbyId}] dead-player reconnect blocked {EM} stale/reused token pid=${pid&&pid.slice(0,8)}`);

          socket.emit('err', 'You were eliminated — make a new deposit to rejoin');

          socket.disconnect(); return;

        }

      }

      _usedGameTokens.add(gameToken);

      notifyPaidJoin(lobbyId, name);

    }

  }



  socket.join(lobbyId);

  // Private per-player channel. The cash-out proof is worth money, so it is sent HERE and not to the
  // lobby room — `ss-cashout-done` is broadcast to everyone, and a proof riding along with it would
  // hand every spectator a signed claim on someone else's stake.
  socket.join('p:' + pid);

  // Ask /api/settle what this player actually deposited, so the value ledger is seeded from the
  // on-chain record instead of from whatever their client claims on its first ssin. Deliberately not
  // awaited — see ssFetchStake.
  if (isPaid) ssFetchStake(pid);



  // Reconnect: if pid already in room, just update socketId and keep all game state

  let player;

  const existingWasAlive = existing ? existing.alive : true;

  if (existing) {

    existing.socketId = socket.id;

    // Came back within grace window — cancel pending removal, resume same spot + score

    if (existing.dcTimer) { clearTimeout(existing.dcTimer); existing.dcTimer = null; }

    existing.disconnected = false;

    // SS games: the snake itself un-freezes in ssHandleInput on the client's next input packet

    // (arrives moments after this socket reconnect) — nothing to cancel here, no timer to clear.

    // Was dead when they left — other clients already removed them (lives=0 broadcast).

    // Give a fresh spawn and mark alive so: (a) tick() accepts their input again,

    // (b) others get a 'join' announcement so they re-add the player.

    if (!existing.alive) {

      const spawn = nextSpawn();

      existing.x = spawn.x; existing.y = spawn.y;

      existing.prevX = spawn.x; existing.prevY = spawn.y;

      existing.dx = 0; existing.dy = 0; existing.nx = 0; existing.ny = 0;

      existing.sc = 0; existing.alive = true; existing.mc = 0;

      existing.pow = false; existing.pt = 0; existing.pep = false; existing.pet = 0;

      existing.held = ['cherry', 'pepper'];

    }

    player = existing;

  } else {

    const spawn = nextSpawn();

    player = {

      id: pid, socketId: socket.id,

      name: name || 'Player', color: color || '#FFD700',

      x: spawn.x, y: spawn.y,

      dx: 0, dy: 0, nx: 0, ny: 0,

      prevX: spawn.x, prevY: spawn.y,

      sc: 0, alive: true, mc: 0,

      pow: false, pt: 0, pep: false, pet: 0,

      held: ['cherry', 'pepper'], sol: wagerSol || 0,

      num: room.players.size

    };

    room.players.set(pid, player);

  }



  // Send full initial state to joining/rejoining player

  socket.emit('init', {

    pid,

    maze: room.maze,

    spec: [...room.players.values()].filter(p => !p.alive).length,

    players: [...room.players.values()].map(p => ({

      id: p.id, name: p.name, color: p.color,

      x: p.x, y: p.y, dx: p.dx, dy: p.dy,

      sc: p.sc, alive: p.alive, num: p.num, sol: p.sol

    }))

  });



  // Announce to others if: fresh join OR was-dead reconnect (others deleted them on lives=0)

  if (!existing || !existingWasAlive) {

    socket.to(lobbyId).emit('join', {

      id: pid, name: player.name, color: player.color,

      x: player.x, y: player.y, num: player.num, sol: player.sol

    });

  }



  // Start game loop if not already running

  if (!room.interval) {

    room.interval = setInterval(() => tick(room, io), TICK_MS);

    console.log(`[${lobbyId}] game loop started`);

  }



  // ── Input ─────────────────────────────────────────────────────

  socket.on('in', ({ dx, dy }) => {

    const p = room.players.get(pid);

    if (!p || !p.alive) return;

    if (Math.abs(dx) + Math.abs(dy) !== 1) return; // reject invalid

    p.nx = dx | 0; p.ny = dy | 0;

  });



  // ── Use powerup ───────────────────────────────────────────────

  socket.on('pow', ({ type }) => {

    const p = room.players.get(pid);

    if (!p || !p.alive || !p.held?.includes(type)) return;

    p.held = p.held.filter(h => h !== type);

    if (type === 'cherry') { p.pow = true; p.pt = CHERRY_TICKS; }

    else if (type === 'pepper') { p.pep = true; p.pet = PEPPER_TICKS; }

  });



  // ── Rejoin (paid lobby) ───────────────────────────────────────

  socket.on('ping_req', (ts) => socket.emit('pong_res', ts));



  socket.on('rejoin', ({ gameToken: rt }) => {

    if (isPaid && GAME_SECRET && !validateGameToken(rt, lobbyId, pid)) return;

    const p = room.players.get(pid);

    if (!p) return;

    const s = nextSpawn();

    p.x = s.x; p.y = s.y; p.dx = 0; p.dy = 0; p.alive = true; p.sc = 0;

    p.pow = false; p.pt = 0; p.pep = false; p.pet = 0; p.held = ['cherry', 'pepper'];

    // Include spawn coords so clients snap immediately instead of waiting for the next state tick

    io.to(lobbyId).emit('rejoin', { id: pid, x: s.x, y: s.y });

  });



  // ── Chat ──────────────────────────────────────────────────────

  socket.on('chat', ({ text }) => {

    if (typeof text !== 'string') return;

    io.to(lobbyId).emit('chat', { id: pid, name: player.name, text: text.slice(0, 100) });

  });



  // ── Spectate ──────────────────────────────────────────────────

  socket.on('spectate', () => {

    const p = room.players.get(pid);

    if (p) p.alive = false;

    io.to(lobbyId).emit('spectate', { id: pid });

  });



  // -- In-game cashout (paid lobbies only) ---

  // Routing through the game server makes kill and cashout mutually exclusive:

  // p.alive=false is set synchronously before any await, so tick() collision

  // detection can never fire for this player after this point. No race possible.

  socket.on('cashout', async (data) => {

    if (!isPaid) return;

    const p = room.players.get(pid);

    if (!p || !p.alive) {

      socket.emit('cashout-result', { error: 'Cannot cashout — you were eliminated' });

      return;

    }

    // Mark dead NOW (sync, before any await) — kill detection is now impossible for this player

    p.alive = false;

    // Also mark the SNAKE dead synchronously: blocks a kill mid-cashout AND stops the

    // post-cashout disconnect from dropping kill/gold food (ssPlayerLeft only sheds food

    // for an ALIVE snake). Restored in the catch below if the settle call errors.

    const _csg = ssGames.get(lobbyId);

    const _csn = _csg && _csg.snakes.get(pid);

    if (_csn) { _csn.alive = false; _csn._cashedOut = true; _csn._killedAt = Date.now(); }

    const { sig, ts, wagerLamports } = data || {};

    const settleUrl = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';

    try {

      const resp = await fetch(settleUrl, {

        method: 'POST',

        headers: {

          'Content-Type': 'application/json',

          'x-settle-sig': String(sig || ''),

          'x-settle-ts': String(ts || ''),

        },

        body: JSON.stringify({ action: 'cashout', playerAddress: pid, wagerLamports: Number(wagerLamports) || 0, lobbyId }),

        signal: AbortSignal.timeout(30000),

      });

      const result = await resp.json().catch(() => ({}));

      if (resp.ok && !result.error) {

        // Paid -- tell other players this player left voluntarily

        socket.to(lobbyId).emit('spectate', { id: pid });

        socket.emit('cashout-result', { ok: true, sig: result.sig, playerCut: result.playerCut, creatorCut: result.creatorCut, confirmed: result.confirmed });

      } else {

        // Settle rejected (dead flag, empty escrow, etc.) -- don't restore; wager was already gone

        socket.emit('cashout-result', { error: result.error || 'Cashout failed -- contact support' });

      }

    } catch (e) {

      // Network/timeout -- restore player so they can retry

      p.alive = true;

      if (_csn) { _csn.alive = true; _csn._cashedOut = false; }

      console.warn('[cashout] settle call error:', e.message);

      socket.emit('cashout-result', { error: 'Connection error -- press SPACE to retry' });

    }

  });



  // In-game cashout NOTIFY from the client after a successful HTTP /api/settle. Removes the snake

  // IMMEDIATELY with NO kill food -- otherwise the 6s ghost-timeout (ssKill) sheds the already-paid

  // wager as gold orbs other players can eat (value duplication). Marks the snake + room player dead

  // so ghost-kill, ssKill and the disconnect food-shed (ssPlayerLeft) are all skipped. NO payout here.

  socket.on('ss-cashed', () => {

    const _sg = ssGames.get(lobbyId);

    const _sn = _sg && _sg.snakes.get(pid);

    if (_sn && _sn.alive) { _sn.alive = false; _sn._cashedOut = true; _sn._killedAt = Date.now(); _sn.path = []; _sn.segs = []; } wgNoteExit(lobbyId, _sn);

    const _pl = room && room.players.get(pid);

    if (_pl) _pl.alive = false;

    socket.to(lobbyId).emit('spectate', { id: pid });

  });



  // ── Voice chat signaling relay ────────────────────────────────

  socket.on('voice-signal', ({ toPid, type, sdp, candidate }) => {

    socket.to(lobbyId).emit('voice-signal', { from: pid, toPid, type, sdp, candidate });

  });

  socket.on('voice-ready', () => {

    socket.to(lobbyId).emit('voice-ready', { from: pid });

  });

  socket.on('voice-audio', (buf) => {

    // Emit directly to each recipient socket by ID — avoids room-broadcast edge cases

    const roomSocks = io.sockets.adapter.rooms.get(lobbyId);

    let relayCount = 0;

    if (roomSocks) {

      roomSocks.forEach(sid => {

        if (sid === socket.id) return;

        const s = io.sockets.sockets.get(sid);

        if (!s) return;

        const transport = s?.conn?.transport?.name || '?';

        console.log('[voice] relay to ' + sid.slice(0,6) + ' via ' + transport);

        s.emit('voice-audio', { from: pid, buf });

        relayCount++;

      });

    }

    socket.emit('voice-ack', { relayCount });

  });



  // ── Lightweight RTT probe for death-replay network timing ──

  socket.on('ss-ping', (d) => { socket.emit('ss-pong', d); });



  // ── Death-replay: merge the victim's client render/interp/network report ──

  socket.on('ss-death-report', (d) => {

    if (!d || !d.replayId || !d.client) return;

    const r = _ssReplays.find(x => x.id === d.replayId);

    if (!r) return;

    r.client = d.client;   // render ts, interp ts, rendered positions, offsets, snapshot ages, RTT

    try { fs.writeFileSync(`${SS_REPLAY_DIR}/${r.id}.json`, JSON.stringify(r)); } catch (e) {}

    console.log(`[REPLAY] client report merged into ${r.id}`);

  });



  // ── Snake relay (ss-* rooms) ─────────────────────────────────

  socket.on('ss', (d) => {

    // Server is now authoritative for ss-* lobbies — ignore HOST-originated ss packets.

    // The server runs physics itself (ssTick) and broadcasts ss-state; no relay needed.

    if (lobbyId.startsWith('ss-')) return;

    socket.to(lobbyId).emit('ss', d);

  });

  socket.on('ssin', (d) => {

    if (lobbyId.startsWith('ss-')) {

      // Server-authoritative: handle input directly, no peer relay

      ssHandleInput(lobbyId, pid, d, io);

      // JOIN body seed (render-only): once per connection, when the client asks (d.seed), send

      // every OTHER alive snake's authoritative body so a fresh/rejoining client draws full tails

      // immediately instead of a straight stub. No gameplay/collision change.

      if (d && d.seed && !socket._ssSeeded) {

        const _sg = ssGames.get(lobbyId);

        if (_sg && _sg.snakes.get(pid)) { socket._ssSeeded = true; ssSendJoinBodies(socket, _sg, pid); }

      }

    } else {

      socket.to(lobbyId).emit('ssin', d);

    }

  });

  // Spawn a practice bot — FREE lobby only (no wagers there, so it can never affect a real game),

  // capped so it can't be spammed. Lets the owner spice up / test the free lobby with circling or

  // fighting bots. (Gated to owner on the client; server allows it anywhere in the free lobby.)

  socket.on('ss-spawn-bot', (d) => {
   try {
    // ── PAID LOBBIES CAN NEVER SPAWN BOTS ────────────────────────────────────────────────────────
    // `lobbyId` is THIS socket's own joined lobby, taken from the handshake and (for paid rooms)
    // gated by validateGameToken/entry-token above — it is not read from `d`. The bot is only ever
    // inserted into ssGames.get(lobbyId), so a client cannot aim a bot at a room it isn't in, and a
    // socket sitting in a paid room is rejected outright here. Belt-and-braces: reject anything with
    // 'paid' in the id too, so adding a new free-lobby id later can never accidentally open paid up.
    const BOT_LOBBIES = ['ss-free-lobby', 'ss-og-free-lobby', 'free-lobby', SS_TEST_LOBBY];
    if (BOT_LOBBIES.indexOf(lobbyId) === -1 || String(lobbyId || '').indexOf('paid') !== -1) {
      socket.emit('ss-notice', 'Bots are only available in the free lobby');
      return;
    }

    const sg = ssGames.get(lobbyId);

    if (!sg) { socket.emit('ss-notice', 'No game running yet — try again in a second'); return; }

    // Spam guard: spam-clicking SPAWN used to hammer the tick with spawn work every click. Per-socket,
    // non-fatal, silent (the button is just briefly inert rather than throwing toasts at the player).
    const _bnow = Date.now();
    if (_bnow - (socket._lastBotSpawn || 0) < 350) return;
    socket._lastBotSpawn = _bnow;

    const mode = (d && d.mode === 'fight') ? 'fight' : 'circle';

    // Caps. Circle bots are the graze/cashout practice targets, so they get their own limit of 5 at a
    // time IN THE LOBBY (not per player). The total cap is the backstop so fighters can't push past it.
    let botN = 0, circleN = 0;
    sg.snakes.forEach(s => { if (s.bot) { botN++; if (s.botMode !== 'fight') circleN++; } });

    if (mode !== 'fight' && circleN >= SS_MAX_CIRCLE_BOTS) {
      socket.emit('ss-notice', 'Circle bot limit reached (' + SS_MAX_CIRCLE_BOTS + ') — kill some first');
      return;
    }

    // NOTE: this used to be `socket.emit('err', ...)`, and the client's global 'err' handler is FATAL —
    // it disconnects the socket and boots you back to the lobby screen. So hitting the bot limit
    // literally kicked the player out of the game ("it crashes when I click spawn"). Bot limits are
    // not fatal; they use the non-fatal 'ss-notice' channel, which just shows a toast.
    if (botN >= SS_MAX_BOTS) { socket.emit('ss-notice', 'Bot limit reached (' + SS_MAX_BOTS + ')'); return; }

    // Bots go through the same live-arena finder as players. The old origin-relative draw could

    // drop one straight into a border that had shrunk or been pushed off-centre, and a bot that

    // dies on spawn just looks like the SPAWN button is broken.

    let a = Math.random() * Math.PI * 2;

    let bx, by;

    { const _bs = ssFindSafeSpawn(sg); bx = _bs[0]; by = _bs[1]; }

    // Test lobby: spawn the bot to the SIDE of the requester — visible but NOT in their forward path,

    // so the player doesn't drive straight into it and trade a death on spawn ("spawns then vanishes").

    if (lobbyId === SS_TEST_LOBBY) {

      const me = sg.snakes.get(pid);

      if (me) {

        const off = 360, ang = (me.angle || 0), side = ang + Math.PI / 2; // perpendicular to their heading

        bx = me.x + Math.cos(side) * off; by = me.y + Math.sin(side) * off;

        const R2 = (sg.arenaR || SS_ARENA_R) - 120; // keep inside the border — flip to the other side if needed

        const _rx = bx - (sg.cx || 0), _ry = by - (sg.cy || 0);



        if (_rx * _rx + _ry * _ry > R2 * R2) { bx = me.x - Math.cos(side) * off; by = me.y - Math.sin(side) * off; }

        a = Math.random() * Math.PI * 2;

      }

    }

    const ns = mode === 'fight' ? 30 : 36;

    const id = 'bot-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);

    const script = mode === 'fight'

      ? (t, sn) => ({ angle: Math.atan2(-sn.y, -sn.x), boost: (t % 150) < 45 }) // drift toward center, occasional boost

      : () => ({ circle: true });                                              // just circle in place

    sg.snakes.set(id, {

      pid: id, color: mode === 'fight' ? '#FF5522' : '#22AAFF', name: mode === 'fight' ? 'FIGHTER' : 'CIRCLE',

      x: bx, y: by, angle: a, targetAngle: a, faceAngle: a, circling: false,

      size: ssSizeFromNs(ns), ns, thick: ssThick(ns), path: [{ x: bx, y: by }],

      boostAmount: 0, _lastPathX: bx, _lastPathY: by, _pathAcc: 0, growQueue: 0, _shed: 0,

      alive: true, boost: false, score: 0, usd: 0, lastTs: Date.now(),

      bot: true, _botTick: 0, _botScript: script, botMode: mode,

      _immuneUntil: Date.now() + 2500 // spawn protection so a nearby player can't insta-trade it on spawn

    });

    if (!sg.tickInterval) sg.tickInterval = setInterval(() => ssTick(lobbyId, io), TICK_MS);

    console.log(`[${lobbyId}] spawned ${mode} bot ${id} (immune 2.5s)`);

   } catch (e) {
    // Never let a bot spawn take down the socket/tick — worst case the click does nothing.
    console.warn('[ss-spawn-bot] ' + (e && e.message));
    try { socket.emit('ss-notice', 'Could not spawn bot'); } catch (_) {}
   }
  });

  // Clear bots — same lobby gating as spawning. Without this the "✕ BOTS" button is dead for anyone
  // who isn't the local host, which is everyone in a server-authoritative free lobby.
  socket.on('ss-clear-bots', () => {
   try {
    const BOT_LOBBIES = ['ss-free-lobby', 'ss-og-free-lobby', 'free-lobby', SS_TEST_LOBBY];
    if (BOT_LOBBIES.indexOf(lobbyId) === -1 || String(lobbyId || '').indexOf('paid') !== -1) return;
    const sg = ssGames.get(lobbyId);
    if (!sg) return;
    let n = 0;
    sg.snakes.forEach((s, id) => { if (s.bot) { sg.snakes.delete(id); io.to(lobbyId).emit('leave', { id }); n++; } });
    if (n) console.log(`[${lobbyId}] cleared ${n} bot(s)`);
    socket.emit('ss-notice', n ? ('Removed ' + n + ' bot(s)') : 'No bots active');
   } catch (e) { console.warn('[ss-clear-bots] ' + (e && e.message)); }
  });

  // Clear gold/kill orbs — PRACTICE + FREE LOBBIES ONLY.
  //
  // ⚠ MONEY. A gold orb is a CLAIM TICKET on SOL already sitting in escrow; deleting one in a
  // paid room would strand real money with nothing left to claim it. So this is gated exactly
  // like the bot handlers (lobbyId comes from the handshake, never from the client) AND, belt
  // and braces, it refuses to remove any orb that actually carries value. Even if a lobby were
  // somehow misclassified, or a free lobby ever ended up holding a funded orb, this cannot
  // destroy money — it will skip those and say so.
  socket.on('ss-clear-gold', () => {
   try {
    const BOT_LOBBIES = ['ss-free-lobby', 'ss-og-free-lobby', 'free-lobby', SS_TEST_LOBBY];
    if (BOT_LOBBIES.indexOf(lobbyId) === -1 || String(lobbyId || '').indexOf('paid') !== -1) {
      socket.emit('ss-notice', 'Gold clearing is practice-lobby only');
      return;
    }
    const sg = ssGames.get(lobbyId);
    if (!sg || !sg.food) return;
    let removed = 0, kept = 0;
    const before = sg.food.length;
    sg.food = sg.food.filter(f => {
      if (!f || !f.k) return true;                                   // ordinary pebble — untouched
      if ((Number(f.w) || 0) > 0 || (Number(f.lam) || 0) > 0) { kept++; return true; }  // FUNDED
      removed++; return false;
    });
    if (removed) { sg._foodDirty = true; console.log('[' + lobbyId + '] cleared ' + removed + ' gold orb(s)'); }
    else if (before) sg.food.length = sg.food.length;                // no-op, keeps shape explicit
    socket.emit('ss-notice', removed
      ? ('Removed ' + removed + ' gold orb(s)' + (kept ? (' — kept ' + kept + ' holding real value') : ''))
      : (kept ? ('Kept ' + kept + ' gold orb(s) holding real value') : 'No gold orbs'));
   } catch (e) { console.warn('[ss-clear-gold] ' + (e && e.message)); }
  });

  // ── OWNER-ONLY LIVE COMBAT TUNING (ed25519-verified) ────────────────────────────────────────
  // Applies to the LIVE lobby so the owner can feel each change while playing. Auth is a signature
  // from the owner's wallet, NOT a client flag: the previous panel trusted localStorage ss_owner,
  // which any player could set in DevTools to push collision constants that decide real-money
  // kills. Values are clamped, so a fat-fingered slider can't make the arena unplayable.
  socket.on('ss-tune', (d) => {
    try {
      if (!lobbyId.startsWith('ss-') || !d || typeof d !== 'object') return;
      const t = d.tuning && typeof d.tuning === 'object' ? d.tuning : null;
      if (!t) return;
      /*
       * HITBOXES ARE LOCKED. The values in ss-tuning.json are the ones the game is meant to run,
       * arrived at deliberately, and nothing may change them at runtime - not a modified client,
       * not a replayed owner signature, not the owner. Combat feel is not something to be
       * adjustable mid-session by anyone, because a hitbox that can move is a hitbox nobody in a
       * paid lobby can trust.
       *
       * TO UNLOCK: set SS_TUNE_LOCKED to false and restart. The owner-signature check below is
       * untouched and still governs everything once unlocked.
       */
      if (SS_TUNE_LOCKED) { socket.emit('ss-notice', 'Hitbox tuning is locked'); return; }
      if (!ssOwnerVerify(lobbyId, t, d.ts, d.sig)) { socket.emit('ss-notice', 'Tuning rejected: not signed by the owner'); return; }
      const next = ssClampTuning(t, SS_TUNING_DEFAULT);
      // GLOBAL: one adjustment retunes every arena on this node, so the owner doesn't have to repeat
      // it per lobby — and the free lobby's circle bots, being normal snakes in sg.snakes, are
      // hit-tested with exactly these values too.
      SS_TUNING_DEFAULT = next;
      ssSaveTuning(next);
      let n = 0;
      for (const [lid, g] of ssGames) {
        if (!lid.startsWith('ss-')) continue;
        g.tuning = { ...next };
        io.to(lid).emit('ss-tuning', next);   // everyone renders the hitboxes the server is using
        n++;
      }
      socket.emit('ss-tuning', next);
      console.log(`[${lobbyId}] OWNER TUNING (${n} lobbies) -> ${JSON.stringify(next)}`);
    } catch (e) { console.warn('[ss-tune] ' + (e && e.message)); }
  });

  // The panel must open showing the values the server is ACTUALLY running, never a stale local copy.
  socket.on('ss-tuning-get', () => {
    try {
      if (!lobbyId.startsWith('ss-')) return;
      const sg = ssGames.get(lobbyId);
      socket.emit('ss-tuning', (sg && sg.tuning) || SS_TUNING_DEFAULT);
    } catch (_) {}
  });



  // HOST-originated kill — validate server-side, then broadcast elim to everyone.

  // This bypasses the ss.kills strip (server strips kills from ss relay to own collision

  // authority). ss-kill goes directly from HOST → server → elim to all guests.

  socket.on('ss-kill', (d) => {

    if (!lobbyId.startsWith('ss-') || !d || !d.id) return;

    const sg = ssGames.get(lobbyId);

    if (!sg) return;

    const victim = sg.snakes.get(d.id);

    if (victim && victim.alive) {

      const killer = d.killerId ? sg.snakes.get(d.killerId) : null;

      ssKill(victim, killer, lobbyId, io);

    }

  });



  // ── Disconnect ────────────────────────────────────────────────

  // Explicit "I'm leaving the page" signal from the client (fires on pagehide/refresh/close,

  // before the socket tears down). An unambiguous leave — forfeit immediately so the body never

  // sits frozen. You can only quit your OWN pid (the socket's), so there's nothing to authorize.

  socket.on('ss-quit', () => {

    if (!lobbyId.startsWith('ss-')) return;

    const dp = room.players.get(pid);

    if (dp && dp.socketId !== socket.id) return; // superseded by a newer socket — leave it alone

    // pagehide fires on BOTH a real leave AND a refresh, so we can't kill here — the snake just starts

    // coasting straight + collidable (ssPlayerLeft). A refresh reconnects into it; a real leave is

    // forfeited by ssTick's grace-expiry. dp.alive stays true so the reconnect is a same-session resume.

    ssPlayerLeft(lobbyId, pid, io);

  });



  socket.on('disconnect', (reason) => {

    const dp = room.players.get(pid);

    // Stale-socket guard: if a newer connection for this pid has already taken over

    // (e.g. a duplicate/racing join reconnected before this older socket's disconnect

    // event arrived), dp.socketId no longer matches this socket. Acting on it here would

    // freeze/delete the CURRENT live session out from under the player. No-op instead.

    if (dp && dp.socketId !== socket.id) return;

    // Refresh / reload / close / blip closes the socket. We do NOT kill on disconnect anymore: the snake

    // keeps COASTING straight and stays collidable (ssPlayerLeft), so a refresh lands the player right

    // back into their own moving body (no frozen stub, no invulnerability to exploit), and if they never

    // come back ssTick's grace-expiry converts the wager to food. dp.alive stays TRUE so the reconnect is

    // recognised as the same session and skips re-validating the single-use token.

    if (lobbyId.startsWith('ss-')) {

      ssPlayerLeft(lobbyId, pid, io);

    }

    // Grace period: a brief network blip / heartbeat timeout shouldn't wipe the player.

    // Keep them frozen + non-collidable so they resume the SAME spot and score on

    // reconnect, instead of vanishing (looked like a cashout/kill) and respawning fresh.

    if (dp) {

      dp.disconnected = true;

      dp.dx = 0; dp.dy = 0; dp.nx = 0; dp.ny = 0; // freeze in place

      if (dp.dcTimer) { clearTimeout(dp.dcTimer); dp.dcTimer = null; }

      const isSsLobby = lobbyId.startsWith('ss-');

      // SS lobbies use the much longer SS_DISCONNECT_GRACE_MS here too — this room.players

      // entry is what a reconnecting socket looks up (`existing`) to be recognized as the SAME

      // alive session and skip re-validating its (single-use) game token. If this fired at the

      // old 15s, a reconnect any time after that would look like a brand-new join. It would

      // still have been let back in (the token itself is valid for 2h), but keeping this window

      // aligned with the snake's own grace period is what makes reconnecting seamless instead of

      // roundabout. The 'leave' broadcast that visually removes an SS snake is also skipped here

      // — ssTick's grace-expiry check (same window) is the sole source of that for SS games, so

      // other players don't see someone vanish 15s into a merely-backgrounded tab.

      const graceMs = isSsLobby ? SS_DISCONNECT_GRACE_MS : DISCONNECT_GRACE_MS;

      dp.dcTimer = setTimeout(() => {

        const cur = room.players.get(pid);

        if (cur && cur.disconnected) {

          room.players.delete(pid);

          if (!isSsLobby) io.to(lobbyId).emit('leave', { id: pid });

          console.log(`[${lobbyId}] ${name} removed after ${graceMs/1000}s grace`);

          /* PAID PAC-MAN: resolve the wager instead of abandoning it. Deleting the player used to be
           * the whole story — their `pw:` record just expired after 4h and the stake sat in escrow
           * credited to nobody, which is real money going quietly unaccounted for.
           *
           * FORFEIT TO THE HOUSE, never a refund: once the wager is in it is locked until cash-out, and
           * a disconnect is not the operator's problem. Snake already does this by shedding the stake as
           * food; Pac-Man has no food to shed into, so it sweeps. Idempotent — /api/settle GETDELs the
           * record, so a player who already died or cashed out forfeits nothing.
           *
           * SS lobbies are excluded: ssTick's own grace expiry owns that path and already forfeits. */
          if (!isSsLobby && isPaid) ssForfeitStake(pid, lobbyId);

          if (room.players.size === 0) {

            clearInterval(room.interval); room.interval = null;

            rooms.delete(lobbyId);

            console.log(`[${lobbyId}] room closed`);

          }

        }

      }, graceMs);

      console.log(`[${lobbyId}] ${name} disconnected — ${graceMs/1000}s grace before removal`);

      // Snake rooms: freeze snake immediately; ssPlayerLeft removes after grace

      if (isSsLobby) ssPlayerLeft(lobbyId, pid, io);

    } else if (room.players.size === 0) {

      clearInterval(room.interval); room.interval = null;

      rooms.delete(lobbyId);

      console.log(`[${lobbyId}] room closed`);

    }

  });

});





// ── Admin middleware ──────────────────────────────────────────────────────────

const _ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

/*

 * These routes read every player's wallet address and can kick, warn, broadcast to, and force-end

 * a live PAID lobby. This check used to read the header and then call next() unconditionally, so

 * all of that was reachable by anyone who knew the path. The likely reason it was left that way:

 * ADMIN_SECRET was never set on these boxes, so enforcing it as written would have locked the

 * panel out entirely.

 *

 * The proof is therefore a GAME_SECRET HMAC -- the same server-to-server trust /wager-event and

 * elim-lock already run on. Both this process and the Vercel function already hold GAME_SECRET,

 * so nothing has to be created, copied or rotated. The PATH is signed along with the timestamp,

 * so a captured /admin/status proof cannot be replayed against /admin/kick.

 *

 * ADMIN_SECRET still works if it is ever set, which keeps a hand-run curl possible. Fails CLOSED:

 * with neither secret configured there is no admin access, rather than open access.

 */

function requireAdmin(req, res, next) {

  const s = (req.headers['x-admin-secret'] || req.query.secret || '').trim();

  if (_ADMIN_SECRET && s.length === _ADMIN_SECRET.length) {

    try { if (crypto.timingSafeEqual(Buffer.from(s), Buffer.from(_ADMIN_SECRET))) return next(); } catch (_) {}

  }

  const proof = (req.headers['x-admin-proof'] || '').toString().trim();

  const ats   = Number(req.headers['x-admin-ts'] || 0);

  if (GAME_SECRET && proof && ats && Math.abs(Date.now() - ats) <= 300000) {

    const expected = crypto.createHmac('sha256', GAME_SECRET).update('admin:' + req.path + ':' + ats).digest('hex');

    try { if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) return next(); } catch (_) {}

  }

  console.warn('[admin] DENIED ' + req.method + ' ' + req.path + ' proof=' + (proof ? 'yes' : 'no') + ' skewMs=' + (ats ? Math.abs(Date.now() - ats) : 'n/a'));

  return res.status(403).json({ error: 'Forbidden' });

}

app.get('/admin/status', requireAdmin, (req, res) => {

  // A hardcoded list can only ever report the lobbies that existed when it was written, so every

  // custom-stake room players actually open was missing while the fixed ids were drawn empty.

  // The live maps are the truth; BASE_IDS stays only as a floor so a quiet site still has shape.

  const BASE_IDS = ['free-lobby','ss-free-lobby','ss-paid-lobby-1','ss-paid-lobby-5','paid-lobby-1','paid-lobby-5','paid-lobby-25',
                   'ss-og-free-lobby','ss-og-paid-lobby-1','ss-og-paid-lobby-5'];

  const LOBBY_IDS = [...new Set([...BASE_IDS, ...ssGames.keys(), ...rooms.keys()])];

  // Named roomsOut, not rooms: a `const rooms` here would shadow the module-level PAC map above

  // for the entire function body, making the .keys() call one line up a TDZ ReferenceError.

  const roomsOut = {};

  const inLobby = new Set();

  for (const lid of LOBBY_IDS) {

    const room = io.sockets.adapter.rooms.get(lid);

    const players = [];

    if (room) for (const sid of room) { const sk = io.sockets.sockets.get(sid); if (sk) { players.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); inLobby.add(sid); } }

    roomsOut[lid] = players;

  }

  const others = [];

  for (const [sid, sk] of io.sockets.sockets) { if (!inLobby.has(sid)) others.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); }

  res.json({ rooms: roomsOut, others, timestamp: Date.now() });

});

app.post('/admin/kick', requireAdmin, express.json(), (req, res) => {

  const { walletAddress, socketId, reason } = req.body || {};

  let kicked = 0;

  for (const [sid, sk] of io.sockets.sockets) { const hit=(walletAddress && sk.walletAddress===walletAddress)||(socketId && sid===socketId); if (hit) { sk.emit('admin-kick', { reason: reason||'Kicked by moderator' }); setTimeout(()=>{ try { sk.disconnect(true); } catch(_){} },600); kicked++; } }

  res.json({ ok: true, kicked });

});

app.post('/admin/warn', requireAdmin, express.json(), (req, res) => {

  const { walletAddress, socketId, message } = req.body || {};

  let sent = 0;

  for (const [sid, sk] of io.sockets.sockets) { const hit=(walletAddress && sk.walletAddress===walletAddress)||(socketId && sid===socketId); if (hit) { sk.emit('admin-warn', { message }); sent++; } }

  res.json({ ok: true, sent });

});

app.post('/admin/endgame', requireAdmin, express.json(), (req, res) => {

  const { lobbyId } = req.body || {};

  io.to(lobbyId).emit('admin-endgame', { reason: 'Game ended by moderator' });

  res.json({ ok: true });

});

// ─────────────────────────────────────────────────────────────────────────────



app.post('/admin/broadcast', requireAdmin, express.json(), (req, res) => {

  const { message, lobbyId } = req.body || {};

  if (!message) return res.status(400).json({ error: 'message required' });

  if (lobbyId) { io.to(lobbyId).emit('admin-broadcast', { message }); }

  else          { io.emit('admin-broadcast', { message }); }

  res.json({ ok: true });

});

// ── Test lobby endpoints (no auth — local/diagnostic use only) ───────────────

app.get('/ss-test', (req, res) => {

  const scenario = req.query.scenario || 'boost-cutoff';

  if (!SS_TEST_SCENARIOS[scenario])

    return res.status(400).json({ error: 'unknown scenario', available: Object.keys(SS_TEST_SCENARIOS) });

  const lid = `ss-test-${scenario}`;

  const sg = getSsGame(lid);

  if (sg.snakes.size === 0) {

    sg._testScenario = scenario;

    ssSpawnBots(sg, scenario);

    if (!sg.tickInterval) {

      sg.tickInterval = setInterval(() => ssTick(lid, io), TICK_MS);

      console.log(`[${lid}] test lobby started (${scenario})`);

    }

  }

  res.json({ lid, scenario, tick: sg.tick,

    snakes: [...sg.snakes.values()].map(sn => ({

      pid: sn.pid, alive: sn.alive, bot: !!sn.bot,

      x: Math.round(sn.x), y: Math.round(sn.y),

      angle: +sn.angle.toFixed(3), faceAngle: sn.faceAngle != null ? +sn.faceAngle.toFixed(3) : null,

      boost: sn.boost, ns: sn.ns, botTick: sn._botTick

    }))

  });

});



app.get('/ss-test/reset', (req, res) => {

  const scenario = req.query.scenario || 'boost-cutoff';

  const lid = `ss-test-${scenario}`;

  const sg = ssGames.get(lid);

  if (!sg) return res.status(404).json({ error: 'lobby not found — call /ss-test first' });

  sg.snakes.clear(); sg.food = []; sg._foodDirty = true; sg.tick = 0; sg._history = []; sg._resetPending = false;

  sg._testScenario = scenario;

  ssSpawnBots(sg, scenario);

  console.log(`[${lid}] test lobby manually reset (${scenario})`);

  res.json({ ok: true, lid, scenario });

});



app.get('/ss-test/status', (req, res) => {

  const scenario = req.query.scenario || 'boost-cutoff';

  const lid = `ss-test-${scenario}`;

  const sg = ssGames.get(lid);

  if (!sg) return res.status(404).json({ error: 'lobby not found' });

  res.json({ lid, tick: sg.tick, resetPending: !!sg._resetPending,

    snakes: [...sg.snakes.values()].map(sn => ({

      pid: sn.pid, alive: sn.alive,

      x: Math.round(sn.x), y: Math.round(sn.y),

      angle: +sn.angle.toFixed(3), faceAngle: sn.faceAngle != null ? +sn.faceAngle.toFixed(3) : null,

      boost: sn.boost, ns: sn.ns, botTick: sn._botTick, pathLen: sn.path ? sn.path.length : 0

    }))

  });

});



// ── Death-replay retrieval (instrumentation) ──────────────────────────────────

app.get('/ss-replay/list', (_, res) => {

  res.json(_ssReplays.slice().reverse().map(r => ({ id: r.id, ...r.meta, frames: r.frames.length, hasClient: !!r.client })));

});

app.get('/ss-replay/latest', (_, res) => {

  const r = _ssReplays[_ssReplays.length - 1];

  if (!r) return res.status(404).json({ error: 'no replays captured yet' });

  res.json(r);

});

app.get('/ss-replay/:id', (req, res) => {

  let r = _ssReplays.find(x => x.id === req.params.id);

  if (!r) { try { r = JSON.parse(fs.readFileSync(`${SS_REPLAY_DIR}/${req.params.id}.json`, 'utf8')); } catch (e) {} }

  if (!r) return res.status(404).json({ error: 'replay not found' });

  res.json(r);

});



ssLoadSavedTuning();   // now that every constant it depends on exists

httpServer.listen(PORT, () => {

  console.log(`PAC ARENA game server listening on :${PORT}`);

});



