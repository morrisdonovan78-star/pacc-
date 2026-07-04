'use strict';
const express = require('express');
const http = require('http');
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
const _usedGameTokens = new Set(); // server-level: survives room deletion, never cleared on disconnect
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── Game constants ────────────────────────────────────────────────────────────
const C=48,R=36,TICK_MS=33;
const CHERRY_TICKS=300, PEPPER_TICKS=390;
// How long a dropped player is kept (frozen) in the room before removal,
// so a brief network blip resumes the same spot/score instead of respawning.
const DISCONNECT_GRACE_MS = 15000;
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
const LOBBY_IDS = new Set(['free-lobby', 'ss-free-lobby', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);

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
const SS_GHOST_MS = 6000;    // ms of silence before server eliminates as ghost
const SS_HB       = 0.95;    // HITBOX_BASE
const SS_HBS      = 1.07;    // combatHitboxScale
const SS_HHBS     = 1.18;    // combatHeadHitboxScale
const SS_FACE     = Math.cos(75 * Math.PI / 180); // cos(75°) ≈ 0.259, facing gate threshold
const SS_POINT_DIST = 1.6;   // path recording granularity in px (MoneySlither POINT_DIST)
const SS_SEG_STEP = 4;       // path stride for H2B body samples (MoneySlither SEGMENT_SPACING_TICKS)
const SS_MIN_SIZE = 40;

// Server-authoritative physics constants (must match client exactly)
const SS_ARENA_R       = 3000;
const SS_MAX_TURN      = 0.274;   // rad/tick — client MAX_TURN
const SS_FOOD_TARGET   = 95;      // client FOOD_TARGET (30% fewer pebbles, was 135)
const SS_FOOD_GROW     = 2;       // client FOOD_GROW
const SS_BOOST_MIN     = 12;      // client BOOST_MIN
const SS_BOOST_DRAIN_A = 3.0;    // client BOOST_DRAIN_AMT
const SS_BOOST_DRAIN_T = 8;      // client BOOST_DRAIN
const SS_INIT_NS       = 17;     // client INIT_SECTIONS (join length)
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
const SS_BOOST_BURN    = 0.18984375; // size burn fraction /s while boosting (25% faster than 0.151875)
const SS_START_SIZE    = 100;      // size for a fresh snake (→ ns 26)
function ssSegForSize(size){ const sz=Math.max(SS_MIN_SIZE, Number(size)||SS_MIN_SIZE); let seg = 8 + (sz-40)*(26-8)/(100-40); if(sz>100) seg = 26 + (sz-100)*0.08; return Math.max(8, Math.round(seg)); }
function ssSizeFromNs(n){ n=Math.max(SS_MIN_NS, n); return n<=26 ? 40 + (n-8)*(100-40)/(26-8) : 100 + (n-26)/0.08; }
const SS_SHED_NE_MS    = 4000;   // client SHED_NOEAT_MS
const SS_FOOD_PICKUP_R      = 42;  // client FOOD_PICKUP_R (raised 29->42 for reliable pickup vs head-prediction desync)
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
// blue-noise spacing — pebbles spread evenly instead of clumping and leaving empty patches.
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
  const orbs = Math.max(2, Math.min(30, Math.round(ns / 4))); // ~1 orb per 4 length, hard cap 30
  const wPerOrb = (sn.usd || 0) / orbs;
  const EDGE = SS_ARENA_R - 30;    // keep every orb just inside the border, never beyond it
  // Only spread across the REAL body (head..tail = ns*SS_SEG_STEP path points); `path` is a
  // long buffer that trails far behind the tail, so using its full length dropped food way
  // behind the snake. Clamp to the actual body span.
  const bodyLen = Math.max(1, Math.min(path.length, (sn.ns || SS_MIN_NS) * SS_SEG_STEP));
  const step = bodyLen / orbs;     // evenly spaced along the body from head to tail
  for (let c = 0; c < orbs; c++) {
    const p = path[Math.min(bodyLen - 1, Math.floor(c * step))];
    let x = p.x + (Math.random() - 0.5) * 8; // small jitter so orbs don't perfectly overlap
    let y = p.y + (Math.random() - 0.5) * 8;
    const d = Math.sqrt(x * x + y * y);
    if (d > EDGE) { const s = EDGE / d; x *= s; y *= s; }
    sg.food.push(ssMakeFood(x, y, 1, wPerOrb));
  }
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
  const maxPath = Math.max(800, ns * SS_SEG_STEP + 200);
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
    tuning: { hbs: SS_HBS, hhbs: SS_HHBS, faceDeg: 75, rule: 'smallest_wins' }
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
  if (!sn || (!sn.alive && (!sn._killedAt || Date.now() - sn._killedAt > 2000))) {
    // First input OR dead snake rejoin (2s cooldown prevents revival from in-flight packets)
    sn = ssSpawnSnake(pid, (sn && sn.color) || d.color || '#FFD700', (sn && sn.name) || d.name || 'SNAKE', sg);
    if (d.ns && d.ns > SS_INIT_NS) { sn.ns = Math.min(SS_MAX_NS, d.ns); sn.size = ssSizeFromNs(sn.ns); sn.thick = ssThick(sn.ns); }
    if (d.usd != null && typeof d.usd === 'number' && sn.usd === 0) { sn.usd = Math.max(0, d.usd); sn.baseUsd = sn.usd; }
    sg.snakes.set(pid, sn);
    if (!sg.food || !sg.food.length) ssReconcileFood(sg);
    if (!sg.tickInterval) {
      sg.tickInterval = setInterval(() => ssTick(lid, io), TICK_MS);
      console.log(`[${lid}] ss game loop started`);
    }
    return;
  }
  if (!sn.alive) return; // within 2s death cooldown — ignore
  sn.lastTs = Date.now();
  if (d.circle) {
    sn.circling = true;
    sn.targetAngle = null;
  } else {
    sn.circling = false;
    if (typeof d.angle === 'number') sn.targetAngle = d.angle;
  }
  sn.boost = !!d.boost && sn.ns > SS_BOOST_MIN;
  if (d.color) sn.color = d.color;
  if (d.name)  sn.name  = d.name;
  // Store client's reported facing angle for H2H gate (client angle is lag-free vs server's 1-2 tick lag)
  if (typeof d.angle === 'number') sn.faceAngle = d.angle;
}

function ssPlayerLeft(lid, pid, io) {
  const sg = ssGames.get(lid);
  if (!sg) return;
  const sn = sg.snakes.get(pid);
  if (sn && sn.alive) {
    if (!sg.food) sg.food = [];
    ssSpawnKillFood(sg, sn);
    sg._foodDirty = true;
    sn.alive = false; sn._killedAt = Date.now(); sn.segs = []; sn.path = [];
  } else if (sn) { sn.segs = []; sn.path = []; }
  setTimeout(() => {
    const g = ssGames.get(lid);
    if (!g) return;
    g.snakes.delete(pid);
    if (g.snakes.size === 0) {
      clearInterval(g.tickInterval);
      ssGames.delete(lid);
      console.log(`[${lid}] ss game loop stopped`);
    }
  }, DISCONNECT_GRACE_MS);
}

// Growth cap by wager: snakes join at ns 17 (SS_INIT_NS) and grow +30 sections per full
// entry-wager carried above the entry — so carrying double the entry wager => cap 70.
// Free/no-wager snakes (baseUsd 0) keep a fixed 70 cap. Authoritative; client mirrors it.
function ssGrowCap(sn) {
  const base = sn.baseUsd || 0, usd = sn.usd || 0;
  if (base <= 0) return 70;
  return Math.max(40, Math.min(SS_MAX_NS, Math.round(40 + 30 * (usd / base - 1))));
}

// ── MoneySlither stepMovement port — ONE 60 Hz sub-step (verbatim from client.js) ──
// Continuous `size` is authoritative; ns/thickness derived. Chord-based path sampling.
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

  // Boost ramp: speed = BASE + (BOOST-BASE)*boostAmount
  if (sn.boost && sn.size > SS_MIN_SIZE) sn.boostAmount = Math.min(1, (sn.boostAmount || 0) + SS_BOOST_ACCEL * SS_DT);
  else                                   sn.boostAmount = Math.max(0, (sn.boostAmount || 0) - SS_BOOST_ACCEL * SS_DT);
  const speed = SS_BASE_SPEED + (SS_BOOST_SPEED - SS_BASE_SPEED) * sn.boostAmount;

  // Advance head
  sn.x += Math.cos(sn.angle) * speed * SS_DT;
  sn.y += Math.sin(sn.angle) * speed * SS_DT;
  if (sn.x * sn.x + sn.y * sn.y >= SS_ARENA_R * SS_ARENA_R) { ssKill(sn, null, lid, io); return; }

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
  const maxPath = Math.max(800, sn.ns * SS_SEG_STEP + 200);
  while (sn.path.length > maxPath) sn.path.pop();

  // Growth: drain growQueue (each unit = +1 segment worth of size) — preserves food economy.
  // Capped by wager (ssGrowCap): join at 17, +30 sections per entry-wager carried above entry.
  const _growCap = ssGrowCap(sn);
  while ((sn.growQueue || 0) > 0 && sn.ns < _growCap) {
    sn.growQueue--;
    sn.size += (ssSizeFromNs(sn.ns + 1) - ssSizeFromNs(sn.ns));
    sn.ns = ssSegForSize(sn.size);
  }

  // Boost burn: size -= size*BURN*DT (continuous) + shed a pellet per whole segment lost
  if (sn.boost) {
    if (sn.size <= SS_MIN_SIZE) { sn.boost = false; }
    else {
      const beforeNs = sn.ns;
      sn.size = Math.max(SS_MIN_SIZE, sn.size - sn.size * SS_BOOST_BURN * SS_DT);
      sn.ns = ssSegForSize(sn.size);
      sn._shed = (sn._shed || 0) + (beforeNs - sn.ns);
      while (sn._shed >= SS_FOOD_GROW) {
        sn._shed -= SS_FOOD_GROW;
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
// path the head swept this tick (up to ~21px at boost), not just its final point —
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

  // 1. Ghost timeout (network check, 30 Hz), then run the 60 Hz authoritative sim:
  //    SS_SUBSTEPS × (move every snake one 1/60 step, then check collisions).
  sg.snakes.forEach(sn => { if (sn.alive && now - sn.lastTs > SS_GHOST_MS) ssKill(sn, null, lid, io); });
  // Remember each head's pre-tick position so food pickup can test the swept segment.
  sg.snakes.forEach(sn => { if (sn.alive) { sn._phx = sn.x; sn._phy = sn.y; } });
  for (let _sub = 0; _sub < SS_SUBSTEPS; _sub++) {
    sg.snakes.forEach(sn => { if (sn.alive) ssStepMovement(sn, sg, lid, io, now); });
    ssCheckCollisions(sg, lid, io);
  }

  // 2. Food pickup — exact head position, no guessing
  sg.snakes.forEach(sn => {
    if (!sn.alive) return;
    for (let i = sg.food.length - 1; i >= 0; i--) {
      const f = sg.food[i];
      if (f.o === sn.pid && f.ne && now < f.ne) continue; // shed cooldown
      const pickR = f.k ? (sn.thick + SS_KILL_FOOD_PICKUP_R) : (sn.thick + SS_FOOD_PICKUP_R);
      const _ax = sn._phx != null ? sn._phx : sn.x, _ay = sn._phy != null ? sn._phy : sn.y;
      if (ssPtSegD2(f.x, f.y, _ax, _ay, sn.x, sn.y) < pickR * pickR) {
        sn.growQueue = (sn.growQueue || 0) + SS_FOOD_GROW;
        sn.score = (sn.score || 0) + (f.k ? 50 : 10);
        if (f.w) sn.usd = (sn.usd || 0) + f.w;
        sg.food.splice(i, 1);
        sg._foodDirty = true;
      }
    }
  });
  ssReconcileFood(sg);

  // Tick snapshot for collision kill-trace (non-behavioral)
  { if (!sg._history) sg._history = [];
    const snap = { tk: sg.tick, t: Date.now(), sn: {} };
    sg.snakes.forEach(sn => {
      if (!sn.alive) return;
      const p0 = sn.path && sn.path.length ? sn.path[0] : null;
      snap.sn[sn.pid] = { x: +sn.x.toFixed(1), y: +sn.y.toFixed(1),
        ang: +sn.angle.toFixed(3), face: sn.faceAngle != null ? +sn.faceAngle.toFixed(3) : null,
        tgt: sn.targetAngle != null ? +sn.targetAngle.toFixed(3) : null, circ: !!sn.circling,
        boost: !!sn.boost, ns: sn.ns, acc: +(sn._pathAcc||0).toFixed(3),
        p0: p0 ? { x: +p0.x.toFixed(1), y: +p0.y.toFixed(1) } : null, plen: sn.path ? sn.path.length : 0 };
    });
    sg._history.push(snap); if (sg._history.length > SS_REPLAY_HISTORY_TICKS) sg._history.shift(); }

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

  // 5. Broadcast state to all clients
  ssBroadcastState(sg, lid, io);
}

function ssBroadcastState(sg, lid, io) {
  if (!sg) return;
  const snakePkts = [];
  sg.snakes.forEach(sn => {
    if (!sn.alive) return;
    snakePkts.push({
      id: sn.pid, x: Math.round(sn.x), y: Math.round(sn.y),
      angle: sn.angle, ns: sn.ns, boost: sn.boost, circle: !!sn.circling,
      score: sn.score || 0, usd: sn.usd || 0,
      color: sn.color, name: sn.name
    });
  });
  const pkt = { snakes: snakePkts, t: Date.now(), tick: sg.tick || 0 };
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
    const idx = k * SS_SEG_STEP;
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
  const alive = [...sg.snakes.values()].filter(s => s.alive && s.path && s.path.length > 1);
  const died = new Set();
  const _evalOrder = alive.map(s => s.pid.slice(0, 8));
  let _h2hKilled = false;

  // ── Head-to-head: MoneySlither pipeline. Both snakes must face each other within faceDeg.
  // Gate fails → pair falls through to H2B only (no TYPE-2 fallback).
  // Gate passes → bigger snake wins; equal size → random.
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
      let winner, loser, reason;   // MoneySlither smallest_wins: bigger SIZE wins; equal → random
      if      (p.size > q.size) { winner = p; loser = q; reason = 'T1-bigger'; }
      else if (q.size > p.size) { winner = q; loser = p; reason = 'T1-bigger'; }
      else                      { winner = Math.random() < 0.5 ? p : q; loser = winner === p ? q : p; reason = 'T1-tie'; }
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
        const idx = k * SS_SEG_STEP;
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
            const _ii = _kk * SS_SEG_STEP;
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
}

function ssKill(victim, killer, lid, io, diag) {
  if (!victim.alive) return;
  victim.alive = false;
  victim._killedAt = Date.now();
  console.log(`[${lid}] KILL: ${victim.pid.slice(0,8)} by ${killer ? killer.pid.slice(0,8) : 'wall/size'}`);
  // ── DEATH_FRAME instrumentation + replay capture (logging only; no gameplay effect) ──
  if (diag) {
    diag.replayId = 'rp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    console.log('[DEATH_FRAME_SRV] ' + JSON.stringify(diag));
    try { ssSaveReplay(lid, victim, killer, diag); } catch (e) { console.warn('[REPLAY] ' + e.message); }
  }
  // Spawn kill food before clearing path
  const sg = ssGames.get(lid);
  if (sg) { if (!sg.food) sg.food = []; ssSpawnKillFood(sg, victim); sg._foodDirty = true; }
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
  // even knows to call settle/kill — closing the window where victim cashout races the kill.
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
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/counts', (_, res) => {
  const LOBBY_IDS = ['free-lobby', 'paid-lobby-1', 'paid-lobby-25'];
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
  pingTimeout: 20000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: false
});

io.on('connection', socket => {
  socket.walletAddress = (socket.handshake.auth && socket.handshake.auth.pid) || null;
  socket.playerName    = (socket.handshake.auth && socket.handshake.auth.name) || '';
  socket.joinedAt      = Date.now();

  const { gameToken, lobbyId, pid, name, color, wagerSol } = socket.handshake.auth;

  // Validate lobby
  if (!lobbyId) { socket.disconnect(); return; }
  const isPaid = lobbyId !== 'free-lobby' && lobbyId !== 'ss-free-lobby';

  const room = getOrCreateRoom(lobbyId);
  const existing = room.players.get(pid);

  // Paid lobby gate — fail CLOSED: no GAME_SECRET means misconfigured server, deny entry
  if (isPaid) {
    console.log(`[${lobbyId}] connection pid=${pid&&pid.slice(0,8)} hasToken=${!!gameToken} existing=${!!existing} gsSet=${!!GAME_SECRET}`);
    if (!GAME_SECRET) {
      socket.emit('err', 'Server not configured for paid lobbies — contact admin');
      socket.disconnect(); return;
    }
    // Reconnecting players (already in room) skip token re-check — their token was validated on first join
    if (!existing) {
      const tokenValid = validateGameToken(gameToken, lobbyId, pid);
      console.log(`[${lobbyId}] token valid=${tokenValid} alreadyUsed=${_usedGameTokens.has(gameToken)}`);
      if (!tokenValid) {
        socket.emit('err', 'Invalid entry token — pay to join');
        socket.disconnect(); return;
      }
      if (_usedGameTokens.has(gameToken)) {
        // Same player reconnecting after a drop — allow re-entry (token is HMAC-tied to this pid)
        console.log(`[${lobbyId}] allowing reconnect for pid=${pid&&pid.slice(0,8)} with previously-used token`);
      } else {
        _usedGameTokens.add(gameToken);
      }
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

  // ── In-game cashout (paid lobbies only) ───────────────────────
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
        body: JSON.stringify({ action: 'cashout', playerAddress: pid, wagerLamports: Number(wagerLamports) || 0 }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await resp.json().catch(() => ({}));
      if (resp.ok && !result.error) {
        // Paid — tell other players this player left voluntarily
        socket.to(lobbyId).emit('spectate', { id: pid });
        socket.emit('cashout-result', { ok: true, sig: result.sig, playerCut: result.playerCut, creatorCut: result.creatorCut, confirmed: result.confirmed });
      } else {
        // Settle rejected (dead flag, empty escrow, etc.) — don't restore; wager was already gone
        socket.emit('cashout-result', { error: result.error || 'Cashout failed — contact support' });
      }
    } catch (e) {
      // Network/timeout — restore player so they can retry
      p.alive = true;
      console.warn('[cashout] settle call error:', e.message);
      socket.emit('cashout-result', { error: 'Connection error — press SPACE to retry' });
    }
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
    } else {
      socket.to(lobbyId).emit('ssin', d);
    }
  });
  socket.on('ss-tune', (d) => {
    if (!lobbyId.startsWith('ss-') || !d) return;
    const sg = getSsGame(lobbyId); // auto-create so pre-game ss-tune from owner is not dropped
    if (typeof d.hbs === 'number') sg.tuning.hbs = Math.max(0.5, Math.min(3.0, d.hbs));
    if (typeof d.hhbs === 'number') sg.tuning.hhbs = Math.max(1.0, Math.min(3.0, d.hhbs));
    if (typeof d.faceDeg === 'number') sg.tuning.faceDeg = Math.max(0, Math.min(120, d.faceDeg));
    if (['smallest_wins','biggest_wins','both_die','random'].includes(d.rule)) sg.tuning.rule = d.rule;
    console.log(`[${lobbyId}] ss-tune: hbs=${sg.tuning.hbs} hhbs=${sg.tuning.hhbs} faceDeg=${sg.tuning.faceDeg} rule=${sg.tuning.rule}`);
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
  socket.on('disconnect', () => {
    const dp = room.players.get(pid);
    // Grace period: a brief network blip / heartbeat timeout shouldn't wipe the player.
    // Keep them frozen + non-collidable so they resume the SAME spot and score on
    // reconnect, instead of vanishing (looked like a cashout/kill) and respawning fresh.
    if (dp) {
      dp.disconnected = true;
      dp.dx = 0; dp.dy = 0; dp.nx = 0; dp.ny = 0; // freeze in place
      if (dp.dcTimer) clearTimeout(dp.dcTimer);
      dp.dcTimer = setTimeout(() => {
        const cur = room.players.get(pid);
        if (cur && cur.disconnected) {
          room.players.delete(pid);
          io.to(lobbyId).emit('leave', { id: pid });
          console.log(`[${lobbyId}] ${name} removed after ${DISCONNECT_GRACE_MS/1000}s grace`);
          if (room.players.size === 0) {
            clearInterval(room.interval); room.interval = null;
            rooms.delete(lobbyId);
            console.log(`[${lobbyId}] room closed`);
          }
        }
      }, DISCONNECT_GRACE_MS);
      console.log(`[${lobbyId}] ${name} disconnected — ${DISCONNECT_GRACE_MS/1000}s grace before removal`);
      // Snake rooms: freeze snake immediately; ssPlayerLeft removes after grace
      if (lobbyId.startsWith('ss-')) ssPlayerLeft(lobbyId, pid, io);
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
  const LOBBY_IDS = ['free-lobby','paid-lobby-1','paid-lobby-5','paid-lobby-25'];
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

