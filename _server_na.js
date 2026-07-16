'use strict';

const express = require('express');

const http = require('http');

const https = require('https');

const { Server } = require('socket.io');

const crypto = require('crypto');

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

const LOBBY_IDS = new Set(['free-lobby', 'ss-free-lobby', 'ss-test-lobby', 'ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);

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

const SS_BORDER_SHRINK_STEP  = 0.05;   // shrink 5% per border death

const SS_BORDER_SHRINK_MAX   = 0.10;   // never shrink more than 10% total

const SS_BORDER_SHRINK_HOLD  = 5000;   // hold the shrink for 5s (refreshed by each new border death)

const SS_BORDER_SHRINK_IN    = SS_ARENA_R * 0.0022; // inward speed/tick (~4%/s) — not instant, but fast enough to catch a careless edge-looter

const SS_BORDER_SHRINK_OUT   = SS_ARENA_R * 0.0009; // outward ease-back/tick (~1.6%/s) — gentle return

const SS_MAX_TURN      = 0.274;   // rad/tick — client MAX_TURN

const SS_FOOD_TARGET   = 95;     // client FOOD_TARGET

const SS_FOOD_GROW     = 2;       // client FOOD_GROW

const SS_BOOST_MIN     = 12;      // client BOOST_MIN

const SS_BOOST_DRAIN_A = 3.0;    // client BOOST_DRAIN_AMT

const SS_BOOST_DRAIN_T = 8;      // client BOOST_DRAIN

const SS_INIT_NS       = 17;     // client INIT_SECTIONS

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



function ssMakeFood(x, y, k, w, o, ne) {

  if (x == null) {

    const a = Math.random() * Math.PI * 2;

    const r = Math.sqrt(Math.random()) * SS_ARENA_R * 0.9;

    x = Math.cos(a) * r; y = Math.sin(a) * r;

  }

  return { x, y, ci: Math.floor(Math.random() * 20), size: 4 + Math.random() * 3,

           k: k || 0, w: w || 0, o: o || null, ne: ne || 0 };

}



// Best-candidate (Mitchell) sampling: generate K random candidates and keep the one

// whose nearest existing pebble is farthest away. Same count/density as pure random, but

// blue-noise spacing - pebbles spread evenly instead of clumping and leaving empty patches.

function ssMakeFoodSpread(sg) {

  const food = sg.food || [];

  const K = 12;

  let best = null, bestD = -1;

  for (let c = 0; c < K; c++) {

    const a = Math.random() * Math.PI * 2;

    const r = Math.sqrt(Math.random()) * SS_ARENA_R * 0.9;

    const x = Math.cos(a) * r, y = Math.sin(a) * r;

    let nd = Infinity;

    for (let i = 0; i < food.length; i++) {

      const dx = food[i].x - x, dy = food[i].y - y, d2 = dx * dx + dy * dy;

      if (d2 < nd) nd = d2;

    }

    if (nd > bestD) { bestD = nd; best = { x, y }; }

  }

  return best ? ssMakeFood(best.x, best.y) : ssMakeFood();

}



function ssReconcileFood(sg) {

  if (!sg.food) sg.food = [];

  let reg = 0;

  sg.food.forEach(f => { if (!f.k) reg++; });

  while (reg < SS_FOOD_TARGET) { sg.food.push(ssMakeFoodSpread(sg)); reg++; }

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

  const EDGE = (sg.arenaR || SS_ARENA_R) - 30; // clamp to the CURRENT (possibly shrunk) border

  const bodyLen = Math.max(1, Math.min(path.length, (sn.ns || SS_MIN_NS) * SS_SEG_STEP));

  const step = bodyLen / orbs;

  for (let c = 0; c < orbs; c++) {

    const p = path[Math.min(bodyLen - 1, Math.floor(c * step))];

    let x = p.x + (Math.random() - 0.5) * 8;

    let y = p.y + (Math.random() - 0.5) * 8;

    const d = Math.sqrt(x * x + y * y);

    if (d > EDGE) { const s = EDGE / d; x *= s; y *= s; }

    sg.food.push(ssMakeFood(x, y, 1, wPerOrb));

  }

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
    .filter(f => f && f.k && (Number(f.w) || 0) > 0)   // money orbs only; pebbles are worthless
    .map(f => ({ x: f.x, y: f.y, w: f.w }));
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
          if (!(w > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          const d = Math.sqrt(x * x + y * y);
          if (d > EDGE && d > 0) { const s = EDGE / d; x *= s; y *= s; }
          g.food.push(ssMakeFood(x, y, 1, w));
        }
        g._foodDirty = true;
        console.log(`[${lid}] restored ${orbs.length} parked gold orbs`);
      })
      .catch(e => console.warn(`[${lid}] get-food failed: ${e.message}`));
  } catch (_) {}
}



function ssFindSafeSpawn(sg) {

  const minDist = 900;

  let best = null, bestMin = -1;

  for (let att = 0; att < 40; att++) {

    const a = Math.random() * Math.PI * 2;

    const r = SS_ARENA_R * (0.22 + Math.random() * 0.56);

    const sx = Math.cos(a) * r, sy = Math.sin(a) * r;

    let nearestDist = Infinity;

    sg.snakes.forEach(sn => {

      if (!sn.alive) return;

      const dx = sn.x - sx, dy = sn.y - sy;

      nearestDist = Math.min(nearestDist, Math.sqrt(dx * dx + dy * dy));

    });

    if (nearestDist > minDist) return [sx, sy]; // good spot found

    if (nearestDist > bestMin) { bestMin = nearestDist; best = [sx, sy]; }

  }

  return best || [Math.cos(Math.random() * Math.PI * 2) * SS_ARENA_R * 0.5, Math.sin(Math.random() * Math.PI * 2) * SS_ARENA_R * 0.5];

}



function ssSpawnSnake(pid, color, name, sg) {

  let sx, sy;

  if (sg) { [sx, sy] = ssFindSafeSpawn(sg); }

  else {

    const a = Math.random() * Math.PI * 2;

    const r = SS_ARENA_R * (0.22 + Math.random() * 0.56);

    sx = Math.cos(a) * r; sy = Math.sin(a) * r;

  }

  const face = Math.atan2(-sy, -sx);

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

    food: [], _foodDirty: true, _lastFoodSend: 0, _history: [],

    arenaR: SS_ARENA_R, shrinkPct: 0, shrinkResetAt: 0, // dynamic border state

    testHitbox: lid === SS_TEST_LOBBY, // test sandbox EXTRAS only (boost drain, food-shed, circle-viz)

    noseCollision: true,

    tuning: { n2nScale: 0.30, bodyScale: 0.75, grazePx: 6.5, grazeHead: 1.25, grazeReach: 1.00, circDeg: 360, faceDeg: 21, rule: 'biggest_wins' }

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

    // usd/baseUsd FIRST: the declared-length clamp below is the wager cap, so it needs the wager.

    if (d.usd != null && typeof d.usd === 'number' && sn.usd === 0) { sn.usd = Math.max(0, d.usd); sn.baseUsd = sn.usd; }

    // A client declaring its own length must still respect its wager cap, or the cap is bypassable

    // by simply rejoining with a big d.ns.

    if (d.ns && d.ns > SS_INIT_NS) { sn.ns = Math.min(ssGrowCap(sn), d.ns); sn.size = ssSizeFromNs(sn.ns); sn.thick = ssThick(sn.ns); }

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
const SS_CAP_BASE   = 30;   // carrying just your entry wager (1x)
const SS_CAP_DOUBLE = 45;   // double the entry wager (2x)
const SS_CAP_MAX    = 50;   // triple (3x) and the hard ceiling beyond it
// Growth cap by how many ENTRY WAGERS you are carrying (r = usd / entry wager).
// r<=1 (just your entry) => 30; 2x => 45; 3x => 50; beyond 3x => still 50 (hard ceiling).
// Two legs by design: +15/wager up to double, then +5/wager to triple.
// Only physical SIZE is limited here - money (usd) is uncapped and keeps growing past this.
function ssCapFromRatio(r) {
  if (!isFinite(r) || r <= 1) return SS_CAP_BASE;
  if (r <= 2) return Math.round(SS_CAP_BASE + 15 * (r - 1));
  if (r <= 3) return Math.round(SS_CAP_DOUBLE + 5 * (r - 2));
  return SS_CAP_MAX;
}
function ssGrowCap(sn) {
  // PREVIOUS BUG: this used `base` (the lobby entry price) not `usd` (what you carry), so a $1
  // lobby was locked at 30 forever no matter how much money you picked up. Now ratio-based.
  const base = sn.baseUsd || 0, usd = sn.usd || 0;   // baseUsd = entry wager; 0 = free lobby
  if (base <= 0) return SS_CAP_MAX;   // free lobby: same 50 ceiling, cannot out-grow a paid snake
  return ssCapFromRatio(usd / base);
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

    if (sn.x * sn.x + sn.y * sn.y >= aR * aR) {

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

  const _growCap = ssGrowCap(sn);

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

        const tail = sn.path[sn.path.length - 1] || { x: sn.x, y: sn.y };

        sg.food.push(ssMakeFood(tail.x + (Math.random()-0.5)*6, tail.y + (Math.random()-0.5)*6, 0, 0, sn.pid, now + SS_SHED_NE_MS));

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

  if ((sg.shrinkPct || 0) > 0 && now > (sg.shrinkResetAt || 0)) sg.shrinkPct = 0; // hold expired → ease back out

  {

    const targetR = SS_ARENA_R * (1 - (sg.shrinkPct || 0));

    if (sg.arenaR > targetR)      sg.arenaR = Math.max(targetR, sg.arenaR - SS_BORDER_SHRINK_IN);  // closing in — fast

    else if (sg.arenaR < targetR) sg.arenaR = Math.min(targetR, sg.arenaR + SS_BORDER_SHRINK_OUT); // opening back — gentle

    // Gold/SOL kill food and pebbles must never sit outside the map — push anything the shrinking

    // border has passed back inside its edge (so the closing ring visibly sweeps the money inward).

    const edge = sg.arenaR - 20;

    if (sg.food && sg.food.length && edge > 0) {

      const e2 = edge * edge;

      for (const f of sg.food) {

        const d2 = f.x * f.x + f.y * f.y;

        if (d2 > e2) { const s = edge / Math.sqrt(d2); f.x *= s; f.y *= s; sg._foodDirty = true; }

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

      sg.snakes.delete(pid);

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

    sg.snakes.delete(pid);

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

    const _cap = ssGrowCap(sn);

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
      const _arc = (_cs.ns || 26) * ssSectionRadius(_cs.ns || 26) * 0.5;
      _cs._cashW = _arc > 0 ? Math.min(1, (_cs._cashWound || 0) / _arc) : 1;   // wind-in progress 0..1 for the client ring
      if ((_cs._cashWound || 0) >= _arc) { _cs._cashStart = Date.now(); _cs._cashW = 1; }
    } else if (Date.now() - _cs._cashStart >= 5500) {
      _cs._cashResolved = 'paid';
      _cs.alive = false; _cs.path = []; _cs.segs = [];
      io.to(lid).emit('ss-cashout-done', { id: _cs.pid });
    }
  }

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

      score: sn.score || 0, usd: sn.usd || 0, cash: sn.cashing ? 1 : 0, cashMs: (sn.cashing && sn._cashStart) ? (Date.now() - sn._cashStart) : 0, cashW: sn.cashing ? (sn._cashW || 0) : 0,

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

  const pkt = { snakes: snakePkts, t: Date.now(), tick: sg.tick || 0, ar: Math.round(sg.arenaR || SS_ARENA_R) };

  const now = Date.now();

  if (sg._foodDirty || !sg._lastFoodSend || now - sg._lastFoodSend > 250) {

    pkt.food = sg.food.map(f => [

      Math.round(f.x), Math.round(f.y),

      f.ci || 0, Math.round((f.size || 6) * 10) / 10,

      f.k ? 1 : 0, f.w ? Math.round(f.w * 1e6) : 0

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

      score: sn.score || 0, usd: sn.usd || 0, cash: sn.cashing ? 1 : 0, cashMs: (sn.cashing && sn._cashStart) ? (Date.now() - sn._cashStart) : 0, cashW: sn.cashing ? (sn._cashW || 0) : 0, color: sn.color, name: sn.name

    });

  });

  const pkt = {

    snakes: snakePkts, t: Date.now(), tick: sg.tick || 0, ar: Math.round(sg.arenaR || SS_ARENA_R),

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

      const margin = skimOn ? skimMargin : 0;

      const RaEff  = RaBase * (skimOn ? grazeHead : 1);        // grazer head hitbox scale (graze only)

      const Rd = R(D), RdEff = Rd * (skimOn ? grazeBody : 1);   // target body/trail radius scale (graze only)

      const reach = RaEff + RdEff, dpath = D.path;

      const killDist = reach - margin, killDist2 = killDist > 0 ? killDist * killDist : 0;

      const neck = Math.max(2, Math.ceil((RaBase + Rd) / SS_POINT_DIST));

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
  // ESCROW SAFETY: dead-flag the victim on the settlement server the instant they die, so a killed
  // player can NEVER cash out. Closes the double-spend where a stale/racing client settles after death
  // while the SAME $ also drops as food for the killer (root cause of escrow going short). Paid lobbies
  // only; bots have no wallet. Fire-and-forget (never blocks the tick).
  if (lid && lid.indexOf('paid') !== -1 && GAME_SECRET && victim.pid && String(victim.pid).indexOf('bot-') !== 0) {
    try {
      const _ts = Date.now();
      const _proof = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victim.pid + ':' + _ts).digest('hex');
      const _su = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
      fetch(_su, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-game-proof': _proof, 'x-game-ts': String(_ts) },
        body: JSON.stringify({ action: 'elim-lock', victimAddress: victim.pid }), signal: AbortSignal.timeout(5000) }).catch(() => {});
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

app.get('/counts', (_, res) => {

  const LOBBY_IDS = ['free-lobby', 'ss-free-lobby', 'ss-paid-lobby-1', 'ss-paid-lobby-5', 'paid-lobby-1', 'paid-lobby-25'];

  const counts = {};

  for (const id of LOBBY_IDS) {

    const r = io.sockets.adapter.rooms.get(id);

    counts[id] = r ? r.size : 0;

  }

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

    if (!watchLobbyId || !LOBBY_IDS.has(watchLobbyId)) { socket.disconnect(); return; }

    socket.isSpectator = true;

    socket.join(watchLobbyId);

    if (watchLobbyId.startsWith('ss-')) {

      const sg = ssGames.get(watchLobbyId);

      if (sg) {

        ssSendJoinBodies(socket, sg, '__spectator__'); // full current bodies, frame one

        ssBroadcastStateTo(socket, sg);                // immediate snapshot, don't wait ~33ms for the next tick

      }

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

    socket.on('disconnect', () => {}); // nothing to clean up — no player/snake state was ever created

    return;

  }



  socket.walletAddress = (socket.handshake.auth && socket.handshake.auth.pid) || null;

  socket.playerName    = (socket.handshake.auth && socket.handshake.auth.name) || '';

  socket.joinedAt      = Date.now();



  const { gameToken, lobbyId, pid, name, color, wagerSol } = socket.handshake.auth;



  // Validate lobby

  if (!lobbyId) { socket.disconnect(); return; }

  const isPaid = lobbyId !== 'free-lobby' && lobbyId !== 'ss-free-lobby' && lobbyId !== SS_TEST_LOBBY;



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

    if (_csn) { _csn.alive = false; _csn._cashedOut = true; }

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

    if (_sn && _sn.alive) { _sn.alive = false; _sn._cashedOut = true; _sn.path = []; _sn.segs = []; }

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

    if (lobbyId !== 'ss-free-lobby' && lobbyId !== 'free-lobby' && lobbyId !== SS_TEST_LOBBY) return;

    const sg = ssGames.get(lobbyId);

    if (!sg) return;

    let botN = 0; sg.snakes.forEach(s => { if (s.bot) botN++; });

    if (botN >= 6) { socket.emit('err', 'Bot limit reached (6)'); return; }

    const mode = (d && d.mode === 'fight') ? 'fight' : 'circle';

    let a = Math.random() * Math.PI * 2, r = SS_ARENA_R * (0.2 + Math.random() * 0.35);

    let bx = Math.cos(a) * r, by = Math.sin(a) * r;

    // Test lobby: spawn the bot to the SIDE of the requester — visible but NOT in their forward path,

    // so the player doesn't drive straight into it and trade a death on spawn ("spawns then vanishes").

    if (lobbyId === SS_TEST_LOBBY) {

      const me = sg.snakes.get(pid);

      if (me) {

        const off = 360, ang = (me.angle || 0), side = ang + Math.PI / 2; // perpendicular to their heading

        bx = me.x + Math.cos(side) * off; by = me.y + Math.sin(side) * off;

        const R2 = (sg.arenaR || SS_ARENA_R) - 120; // keep inside the border — flip to the other side if needed

        if (bx * bx + by * by > R2 * R2) { bx = me.x - Math.cos(side) * off; by = me.y - Math.sin(side) * off; }

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

  });

  socket.on('ss-tune', () => { /* LOCKED: hardcoded tuning; ignore all ss-tune, incl. DevTools cheats */ });



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

function requireAdmin(req, res, next) {

  const s = (req.headers['x-admin-secret'] || req.query.secret || '').trim();

  next();

}

app.get('/admin/status', requireAdmin, (req, res) => {

  const LOBBY_IDS = ['free-lobby','ss-free-lobby','ss-paid-lobby-1','ss-paid-lobby-5','paid-lobby-1','paid-lobby-5','paid-lobby-25'];

  const rooms = {};

  const inLobby = new Set();

  for (const lid of LOBBY_IDS) {

    const room = io.sockets.adapter.rooms.get(lid);

    const players = [];

    if (room) for (const sid of room) { const sk = io.sockets.sockets.get(sid); if (sk) { players.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); inLobby.add(sid); } }

    rooms[lid] = players;

  }

  const others = [];

  for (const [sid, sk] of io.sockets.sockets) { if (!inLobby.has(sid)) others.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); }

  res.json({ rooms, others, timestamp: Date.now() });

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



httpServer.listen(PORT, () => {

  console.log(`PAC ARENA game server listening on :${PORT}`);

});



