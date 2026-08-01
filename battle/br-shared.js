/*
 * SNAKEPOT BATTLE ROYALE — shared simulation module
 * ---------------------------------------------------------------------------
 * ONE file, required by the server (node) and loaded by the client (browser).
 * Everything two machines must agree on lives here and ONLY here: the map
 * geometry, the movement step, the weapon tables, the zone schedule.
 *
 * This is the kart lesson applied from the start: a hand-copied constant that
 * differs by one percent produces no error anywhere — just players rubber-
 * banding under correction and paid results their own screen disagreed with.
 * Never fork this file; the deploy step copies it verbatim to both ends.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Deterministic RNG ─────────────────────────────────────────────────────
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── World constants ───────────────────────────────────────────────────────
  const MAP_SIZE = 440;            // metres, square, centred on 0,0
  const HALF = MAP_SIZE / 2;
  const GRAVITY = 24;
  const JUMP_V = 8.4;
  const EYE = 1.62;                // eye height standing
  const EYE_CROUCH = 1.08;
  const R = 0.42;                  // player capsule radius
  const H_STAND = 1.78;
  const H_CROUCH = 1.2;
  const SPEED = { walk: 5.6, sprint: 8.2, crouch: 3.1, ads: 4.2, down: 1.6 };
  const ACCEL = 44;                // ground acceleration toward wish velocity
  const AIR_ACCEL = 10;
  const STEP_UP = 0.55;            // auto-step onto kerbs/stairs up to this
  const INTERACT_DIST = 2.4;

  const MAX_HP = 100, MAX_SHIELD = 100;
  const DOWN_HP = 100, DOWN_BLEED = 4.5;   // downed pool and drain per second
  const REVIVE_TIME = 6.0, REVIVE_DIST = 2.6;

  /*
   * WEAPONS. Hitscan with server-rolled spread. `tiers` scales damage by
   * rarity: common / rare / epic. Everything a balance pass would touch is
   * data here, so adding a weapon later is a table row, not a rewrite.
   */
  /*
   * The arsenal is balanced against Fortnite's late-Chapter-1 core loadout —
   * familiar roles and TTKs, original SnakePot identities, nothing overpowered.
   * Damage figures are the RARE (blue) baseline; rarity multiplies from there.
   */
  const WEAPONS = {
    melee:     { name: 'Harvest Blade',      slotIcon: '🗡', ammo: null,  dmg: 32, hsMult: 1.0, rate: 0.55, mag: 0, reload: 0, range: 2.6,  spread: 0,     pellets: 1, auto: false, melee: true },
    pistol:    { name: 'Pistol',    slotIcon: '🔫', ammo: 'light',  dmg: 24, hsMult: 2.0, rate: 0.24, mag: 16, reload: 1.3, range: 120, spread: 0.014, pellets: 1, auto: false },
    handcannon:{ name: 'Hand Cannon', slotIcon: '🔫', ammo: 'heavy',  dmg: 43, hsMult: 2.0, rate: 0.8, mag: 7,  reload: 2.1, range: 150, spread: 0.008, pellets: 1, auto: false },
    smg:       { name: 'SMG',     slotIcon: '💨', ammo: 'light',  dmg: 17, hsMult: 1.6, rate: 0.075, mag: 30, reload: 1.9, range: 80,  spread: 0.032, pellets: 1, auto: true },
    ar:        { name: 'Assault Rifle',        slotIcon: '🎯', ammo: 'medium', dmg: 30, hsMult: 1.5, rate: 0.18, mag: 30, reload: 2.3, range: 240, spread: 0.019, pellets: 1, auto: true },
    burst:     { name: 'Burst AR', slotIcon: '🎯', ammo: 'medium', dmg: 27, hsMult: 1.5, rate: 0.38, mag: 30, reload: 2.5, range: 220, spread: 0.013, pellets: 2, auto: true },
    tacshot:   { name: 'Tactical Shotgun',       slotIcon: '💥', ammo: 'shells', dmg: 9,  hsMult: 1.5, rate: 0.67, mag: 8,  reload: 2.6, range: 30,  spread: 0.07,  pellets: 8, auto: false },
    shotgun:   { name: 'Pump Shotgun',        slotIcon: '💥', ammo: 'shells', dmg: 9.5, hsMult: 1.8, rate: 1.05, mag: 5, reload: 3.0, range: 30,  spread: 0.08,  pellets: 10, auto: false },
    sniper:    { name: 'Bolt-Action Sniper',  slotIcon: '🔭', ammo: 'heavy',  dmg: 105, hsMult: 2.0, rate: 1.6, mag: 1,  reload: 2.9, range: 500, spread: 0.001, pellets: 1, auto: false },
  };
  // Fortnite's 5-rarity ladder: grey / green / blue / purple / gold.
  const TIER_MULT = { 0: 0.90, 1: 0.95, 2: 1.0, 3: 1.06, 4: 1.12 };
  const TIER_NAME = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
  // which rarities each weapon can drop at (min, max)
  const WEAPON_TIERS = {
    pistol: [0, 2], handcannon: [3, 4], smg: [0, 4], ar: [0, 4], burst: [1, 4],
    tacshot: [0, 3], shotgun: [1, 4], sniper: [2, 4],
  };

  const CONSUMABLES = {
    bandage:  { name: 'Bandage',      use: 3.0, heal: 15, cap: 75,  stack: 15 },
    medkit:   { name: 'Medkit',       use: 7.0, heal: 100, cap: 100, stack: 3 },
    shieldsm: { name: 'Venom Vial',   use: 2.5, shield: 25, shieldCap: 50, stack: 6 },
    shieldbig:{ name: 'Big Venom',    use: 5.0, shield: 50, shieldCap: 100, stack: 3 },
  };
  const AMMO_KINDS = ['light', 'medium', 'heavy', 'shells'];
  const AMMO_PICKUP = { light: 24, medium: 20, heavy: 6, shells: 8 };
  const AMMO_MAX = { light: 240, medium: 200, heavy: 36, shells: 60 };

  /*
   * THE ZONE. Phases: wait (circle shown, not moving) then shrink over
   * `move` seconds to `r` (fraction of the previous radius toward a new
   * centre inside the old circle). Damage per second outside grows.
   */
  /*
   * FORTNITE-S8-SHAPED PACING: the wall spends most of its life STANDING STILL.
   * The first cut had move windows longer than the waits (60s shrink vs 45s
   * wait), so the circle felt like it never stopped crawling — the owner called
   * it out. Now every phase waits longer than it moves, like the real storm:
   * a long static circle, a decisive shrink, another long stand. dps follows
   * the era too: 1 → 2 → 5 → 7 → 8 → 10, capped at 10 (never the old 14/16).
   */
  const ZONE_PHASES = [
    { wait: 60, move: 30, r: 0.62, dps: 1 },
    { wait: 40, move: 25, r: 0.58, dps: 2 },
    { wait: 30, move: 20, r: 0.52, dps: 5 },
    { wait: 25, move: 18, r: 0.45, dps: 7 },
    { wait: 20, move: 15, r: 0.40, dps: 8 },
    { wait: 15, move: 12, r: 0.10, dps: 10 },
  ];
  const ZONE_R0 = HALF * 1.25;     // opening circle covers most of the map

  // ── Map generation ────────────────────────────────────────────────────────
  /*
   * The map is a list of solid AABBs plus decorative + loot markers, all
   * derived from ONE seed. POIs are laid out on a fixed plan (so the map is
   * designed, not noise) with seeded variation inside each. Every solid the
   * server collides with, the client renders — nothing is only visual except
   * things the player can never touch (ground stains, skybox).
   *
   * Box: { x, y, z, w, h, d, kind } — x/z centre, y BOTTOM. kind drives the
   * client's material choice and nothing else.
   */
  function genMap(seed) {
    const rnd = mulberry32(seed >>> 0);
    const boxes = [];
    const chests = [];
    const floorLoot = [];
    const trees = [];
    const pads = [];

    function box(x, y, z, w, h, d, kind) { boxes.push({ x, y, z, w, h, d, kind: kind || 'wall' }); }
    function chest(x, z, y) { chests.push({ x, y: y || 0, z }); }

    /*
     * A building: hollow shell with a door gap, optional second floor with a
     * roof hatch landing, window slits, and a chest chance upstairs. All
     * solids; interiors are real (walls are 4 boxes with a gap, not a shell
     * the server treats as solid — players fight inside these).
     */
    function building(cx, cz, w, d, floors) {
      const wallT = 0.4, storey = 3.2;
      const doorW = 1.6;
      const stairW = 2.2;              // open channel along the left wall for the staircase
      for (let f = 0; f < floors; f++) {
        const y = f * storey;
        // front wall (+z): two segments leaving a door gap on the ground floor
        const off = (rnd() - 0.5) * Math.max(0, w - doorW - 1.2);
        if (f === 0) {
          const leftW = (w - doorW) / 2 + off, rightW = (w - doorW) / 2 - off;
          if (leftW > 0.3) box(cx - w / 2 + leftW / 2, y, cz + d / 2 - wallT / 2, leftW, storey, wallT, 'bwall');
          if (rightW > 0.3) box(cx + w / 2 - rightW / 2, y, cz + d / 2 - wallT / 2, rightW, storey, wallT, 'bwall');
        } else {
          box(cx, y, cz + d / 2 - wallT / 2, w, storey, wallT, 'bwall');
        }
        box(cx, y, cz - d / 2 + wallT / 2, w, storey, wallT, 'bwall');             // back
        box(cx - w / 2 + wallT / 2, y, cz, wallT, storey, d - wallT * 2, 'bwall'); // left
        box(cx + w / 2 - wallT / 2, y, cz, wallT, storey, d - wallT * 2, 'bwall'); // right
        if (f > 0) {
          // floor slab of the upper storey — covers everything EXCEPT the stair
          // channel along the left wall, which stays open floor to ceiling so a
          // climbing player never clips their head on it.
          box(cx + stairW / 2, y - 0.25, cz, w - stairW, 0.25, d, 'slab');
          // staircase: risers small enough that STEP_UP walks them (storey/6 ≈ 0.53)
          const rise = storey / 6, run = Math.max(0.8, (d - wallT * 2 - 1.2) / 6);
          for (let s = 0; s < 6; s++) {
            box(cx - w / 2 + wallT + stairW / 2 - 0.1, 0, cz - d / 2 + wallT + 0.6 + s * run,
                stairW - 0.4, (s + 1) * rise, run, 'stair');
          }
        }
      }
      // roof + parapet lips front/back
      box(cx, floors * storey, cz, w, 0.3, d, 'roof');
      box(cx, floors * storey + 0.3, cz + d / 2 - 0.15, w, 0.5, 0.3, 'bwall');
      box(cx, floors * storey + 0.3, cz - d / 2 + 0.15, w, 0.5, 0.3, 'bwall');
      if (rnd() < 0.75) chest(cx + (rnd() - 0.5) * (w - 3), cz + (rnd() - 0.5) * (d - 3));
      if (floors > 1 && rnd() < 0.5) chest(cx + stairW, cz, storey);   // upstairs, on the slab
      if (rnd() < 0.8) floorLoot.push({ x: cx + (rnd() - 0.5) * (w - 2), y: 0, z: cz + (rnd() - 0.5) * (d - 2) });
    }

    function crate(cx, cz, s, y) { box(cx, y || 0, cz, s, s * 0.8, s, 'crate'); if (rnd() < 0.35) floorLoot.push({ x: cx, y: (y || 0) + s * 0.8, z: cz }); }
    function tree(cx, cz) { trees.push({ x: cx, z: cz, s: 0.8 + rnd() * 0.7 }); box(cx, 0, cz, 0.7, 5.5, 0.7, 'trunk'); }

    /*
     * POI plan — eight districts on a ring plus a centre. Fixed placement,
     * seeded interiors: the map is recognisable match to match while the
     * loot and clutter move.
     */
    const POIS = [
      { x: 0, z: 0, name: 'The Pit', type: 'center' },
      { x: -140, z: -140, name: 'Coil Yard', type: 'warehouse' },
      { x: 150, z: -130, name: 'Fang Town', type: 'town' },
      { x: 145, z: 140, name: 'Venom Works', type: 'factory' },
      { x: -150, z: 135, name: 'Nest Village', type: 'town' },
      { x: 0, z: -165, name: 'Scale Farm', type: 'farm' },
      { x: 170, z: 5, name: 'Rattle Ridge', type: 'ridge' },
      { x: -170, z: 0, name: 'Shed Rows', type: 'sheds' },
      { x: 5, z: 165, name: 'Basket Market', type: 'market' },
    ];

    for (const p of POIS) {
      if (p.type === 'center') {
        // sunken arena feel: ring of crates + 4 towers + open middle with chests
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2 + Math.PI / 4;
          building(p.x + Math.cos(a) * 26, p.z + Math.sin(a) * 26, 8 + rnd() * 3, 8 + rnd() * 3, 2, 0);
        }
        for (let i = 0; i < 10; i++) { const a = rnd() * Math.PI * 2, r0 = 10 + rnd() * 8; crate(p.x + Math.cos(a) * r0, p.z + Math.sin(a) * r0, 1.6 + rnd() * 1.2); }
        chest(p.x, p.z); chest(p.x + 4, p.z - 3); chest(p.x - 4, p.z + 3);
      } else if (p.type === 'town' ) {
        const n = 5 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          const bx = p.x + (rnd() - 0.5) * 60, bz = p.z + (rnd() - 0.5) * 60;
          building(bx, bz, 7 + rnd() * 5, 7 + rnd() * 5, rnd() < 0.45 ? 2 : 1, 0);
        }
        for (let i = 0; i < 5; i++) crate(p.x + (rnd() - 0.5) * 70, p.z + (rnd() - 0.5) * 70, 1.4 + rnd());
        for (let i = 0; i < 6; i++) tree(p.x + (rnd() - 0.5) * 90, p.z + (rnd() - 0.5) * 90);
      } else if (p.type === 'warehouse' || p.type === 'factory') {
        building(p.x, p.z, 24, 16, 1, 0);              // one big hall
        building(p.x + 24, p.z + 14, 9, 9, 2, 0);
        for (let i = 0; i < 12; i++) crate(p.x + (rnd() - 0.5) * 46, p.z + (rnd() - 0.5) * 36, 1.7 + rnd() * 1.3);
        // catwalk stack: climbable crates
        for (let s = 0; s < 3; s++) crate(p.x - 8 + s * 2.2, p.z - 4, 2.2, s * 1.7);
        chest(p.x, p.z); chest(p.x + 24, p.z + 14);
      } else if (p.type === 'farm') {
        building(p.x, p.z, 12, 9, 1, 0);
        building(p.x + 22, p.z + 8, 8, 8, 1, 0);
        // barn: big open box with high walls and a wide gap
        box(p.x - 20, 0, p.z - 12, 0.5, 5, 14, 'bwall'); box(p.x - 8, 0, p.z - 12, 0.5, 5, 14, 'bwall');
        box(p.x - 14, 0, p.z - 18.7, 12.5, 5, 0.5, 'bwall'); box(p.x - 14, 4.6, p.z - 12, 12.5, 0.4, 14, 'roof');
        for (let i = 0; i < 8; i++) crate(p.x + (rnd() - 0.5) * 60, p.z + (rnd() - 0.5) * 50, 1.3 + rnd());
        for (let i = 0; i < 10; i++) tree(p.x + (rnd() - 0.5) * 90, p.z + (rnd() - 0.5) * 80);
        chest(p.x - 14, p.z - 12);
      } else if (p.type === 'ridge') {
        // terraced high ground: stacked platforms with a chest on top
        for (let t = 0; t < 4; t++) box(p.x, t * 1.9, p.z, 30 - t * 6.5, 2.0, 26 - t * 5.5, 'rock');
        chest(p.x, p.z, 4 * 1.9);
        for (let i = 0; i < 6; i++) crate(p.x + (rnd() - 0.5) * 50, p.z + (rnd() - 0.5) * 44, 1.5 + rnd());
        for (let i = 0; i < 7; i++) tree(p.x + (rnd() - 0.5) * 70, p.z + (rnd() - 0.5) * 66);
      } else if (p.type === 'sheds') {
        for (let i = 0; i < 7; i++) building(p.x + (rnd() - 0.5) * 55, p.z + (rnd() - 0.5) * 55, 5.5 + rnd() * 2, 5.5 + rnd() * 2, 1, 0);
        for (let i = 0; i < 6; i++) crate(p.x + (rnd() - 0.5) * 66, p.z + (rnd() - 0.5) * 66, 1.4 + rnd());
      } else if (p.type === 'market') {
        // stall rows: low cover lanes
        for (let r0 = 0; r0 < 3; r0++) for (let c = 0; c < 4; c++) {
          box(p.x - 24 + c * 16, 0, p.z - 16 + r0 * 16, 6, 2.4, 3, 'stall');
          if (rnd() < 0.4) floorLoot.push({ x: p.x - 24 + c * 16, y: 2.4, z: p.z - 16 + r0 * 16 });
        }
        building(p.x + 32, p.z, 9, 9, 2, 0);
        chest(p.x, p.z); chest(p.x + 32, p.z);
      }
    }

    // scattered wilderness between POIs
    for (let i = 0; i < 46; i++) {
      const x = (rnd() - 0.5) * (MAP_SIZE - 30), z = (rnd() - 0.5) * (MAP_SIZE - 30);
      let near = false;
      for (const p of POIS) if ((x - p.x) ** 2 + (z - p.z) ** 2 < 55 * 55) { near = true; break; }
      if (near) { continue; }
      if (rnd() < 0.62) tree(x, z);
      else if (rnd() < 0.5) crate(x, z, 1.4 + rnd() * 1.4);
      else box(x, 0, z, 2.5 + rnd() * 3, 1.1 + rnd() * 1.4, 2.5 + rnd() * 3, 'rock');
    }
    for (let i = 0; i < 10; i++) {
      const x = (rnd() - 0.5) * (MAP_SIZE - 60), z = (rnd() - 0.5) * (MAP_SIZE - 60);
      let near = false;
      for (const p of POIS) if ((x - p.x) ** 2 + (z - p.z) ** 2 < 60 * 60) { near = true; break; }
      if (!near) chest(x, z);
    }

    // 16 spawn pads around the perimeter (teams drop on these, spaced)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pads.push({ x: Math.cos(a) * (HALF - 26), z: Math.sin(a) * (HALF - 26), a: a + Math.PI });
    }

    // map border: 4 walls so nobody walks off the world
    box(0, 0, -HALF, MAP_SIZE, 10, 1, 'border'); box(0, 0, HALF, MAP_SIZE, 10, 1, 'border');
    box(-HALF, 0, 0, 1, 10, MAP_SIZE, 'border'); box(HALF, 0, 0, 1, 10, MAP_SIZE, 'border');

    return { seed, boxes, chests, floorLoot, trees, pads, pois: POIS };
  }

  // ── Collision + movement ──────────────────────────────────────────────────
  function aabbOverlapXZ(px, pz, r, b) {
    const dx = Math.max(Math.abs(px - b.x) - b.w / 2, 0);
    const dz = Math.max(Math.abs(pz - b.z) - b.d / 2, 0);
    return (dx * dx + dz * dz) < r * r;
  }

  /*
   * One fixed simulation step for one player. `p` is mutated. `input` is the
   * latest control packet: { f, s (forward/strafe -1..1), yaw, sprint,
   * crouch, jump }. The same function runs on the server (authoritative) and
   * on the owning client (prediction) — identical or the game rubber-bands.
   */
  function stepPlayer(p, input, dt, map) {
    const down = p.state === 'down';
    const crouch = !!input.crouch && !down;
    const h = crouch ? H_CROUCH : H_STAND;
    let f = Math.max(-1, Math.min(1, Number(input.f) || 0));
    let s = Math.max(-1, Math.min(1, Number(input.s) || 0));
    const mag = Math.hypot(f, s);
    if (mag > 1) { f /= mag; s /= mag; }
    const yaw = Number(input.yaw) || 0;

    let speed = SPEED.walk;
    if (down) speed = SPEED.down;
    else if (input.aim) speed = SPEED.ads;
    else if (crouch) speed = SPEED.crouch;
    else if (input.sprint && f > 0.2 && !input.aim) speed = SPEED.sprint;
    if (p.useT > 0) speed = Math.min(speed, SPEED.crouch);   // using an item slows you
    if (p.reviveT > 0) speed = 0;                             // holding a revive roots you

    // wish velocity in world space from camera yaw
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wx = (s * cos - f * sin) * speed;
    const wz = (-f * cos - s * sin) * speed;

    const grounded = p.grounded;
    const acc = grounded ? ACCEL : AIR_ACCEL;
    p.vx += Math.max(-acc * dt, Math.min(acc * dt, wx - p.vx));
    p.vz += Math.max(-acc * dt, Math.min(acc * dt, wz - p.vz));

    if (input.jump && grounded && !down && p.jumpLock !== true) { p.vy = JUMP_V; p.grounded = false; }
    p.jumpLock = !!input.jump;

    p.vy -= GRAVITY * dt;
    if (p.vy < -55) p.vy = -55;

    // integrate + resolve, axis by axis so sliding along walls works
    const solids = map.boxes;
    // X
    let nx = p.x + p.vx * dt;
    for (const b of solids) {
      const top = b.y + b.h, bot = b.y;
      if (p.y >= top - 0.001 || p.y + h <= bot) continue;
      if (aabbOverlapXZ(nx, p.z, R, b)) {
        // try step-up
        if (grounded && top - p.y <= STEP_UP && !collidesAt(nx, top, p.z, h, R, solids)) { p.y = top; continue; }
        nx = p.x + Math.sign(p.x - b.x) * 0.0001;
        const pushed = b.x + Math.sign(nx - b.x) * (b.w / 2 + R + 0.001);
        nx = Math.abs(pushed - p.x) < Math.abs(p.vx * dt) + 0.5 ? pushed : p.x;
        p.vx = 0;
      }
    }
    p.x = Math.max(-HALF + R, Math.min(HALF - R, nx));
    // Z
    let nz = p.z + p.vz * dt;
    for (const b of solids) {
      const top = b.y + b.h, bot = b.y;
      if (p.y >= top - 0.001 || p.y + h <= bot) continue;
      if (aabbOverlapXZ(p.x, nz, R, b)) {
        if (grounded && top - p.y <= STEP_UP && !collidesAt(p.x, top, nz, h, R, solids)) { p.y = top; continue; }
        const pushed = b.z + Math.sign(nz - b.z) * (b.d / 2 + R + 0.001);
        nz = Math.abs(pushed - p.z) < Math.abs(p.vz * dt) + 0.5 ? pushed : p.z;
        p.vz = 0;
      }
    }
    p.z = Math.max(-HALF + R, Math.min(HALF - R, nz));
    // Y
    let ny = p.y + p.vy * dt;
    p.grounded = false;
    if (ny <= 0) { ny = 0; p.vy = 0; p.grounded = true; }
    for (const b of solids) {
      if (!aabbOverlapXZ(p.x, p.z, R, b)) continue;
      const top = b.y + b.h, bot = b.y;
      if (p.vy <= 0 && p.y >= top - 0.35 && ny < top) { ny = top; p.vy = 0; p.grounded = true; }
      else if (p.vy > 0 && p.y + h <= bot + 0.05 && ny + h > bot) { ny = bot - h - 0.001; p.vy = 0; }
    }
    p.y = ny;
    p.crouching = crouch;
    return p;
  }

  function collidesAt(x, y, z, h, r, solids) {
    for (const b of solids) {
      if (y >= b.y + b.h - 0.001 || y + h <= b.y) continue;
      if (aabbOverlapXZ(x, z, r, b)) return true;
    }
    return false;
  }

  /*
   * Ray vs the world's AABBs — used by the server to occlude shots and by the
   * client to clip tracers. Returns nearest hit distance or Infinity.
   */
  function rayWorld(ox, oy, oz, dx, dy, dz, maxDist, solids) {
    let best = maxDist;
    for (const b of solids) {
      const minx = b.x - b.w / 2, maxx = b.x + b.w / 2;
      const miny = b.y, maxy = b.y + b.h;
      const minz = b.z - b.d / 2, maxz = b.z + b.d / 2;
      let t0 = 0, t1 = best;
      let ok = true;
      const p = [ox, oy, oz], dir = [dx, dy, dz], mn = [minx, miny, minz], mx = [maxx, maxy, maxz];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dir[i]) < 1e-9) { if (p[i] < mn[i] || p[i] > mx[i]) { ok = false; break; } continue; }
        let ta = (mn[i] - p[i]) / dir[i], tb = (mx[i] - p[i]) / dir[i];
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
      if (ok && t0 < best && t0 > 0) best = t0;
    }
    return best;
  }

  // Ray vs a player capsule (approximated as a vertical cylinder + head sphere).
  // Returns { d, head } or null.
  function rayPlayer(ox, oy, oz, dx, dy, dz, maxDist, px, py, pz, crouching, down) {
    const h = down ? 0.8 : crouching ? H_CROUCH : H_STAND;
    const headY = py + h - 0.18;
    // cylinder: solve in XZ
    const rx = ox - px, rz = oz - pz;
    const a = dx * dx + dz * dz;
    let d = Infinity;
    if (a > 1e-9) {
      const bq = 2 * (rx * dx + rz * dz);
      const c = rx * rx + rz * rz - R * R * 1.21;
      const disc = bq * bq - 4 * a * c;
      if (disc >= 0) {
        const t = (-bq - Math.sqrt(disc)) / (2 * a);
        if (t > 0 && t < maxDist) {
          const hy = oy + dy * t;
          if (hy >= py && hy <= py + h) d = t;
        }
      }
    }
    // head sphere
    const hx = ox - px, hy2 = oy - headY, hz = oz - pz;
    const b2 = 2 * (hx * dx + hy2 * dy + hz * dz);
    const c2 = hx * hx + hy2 * hy2 + hz * hz - 0.075;
    const disc2 = b2 * b2 - 4 * c2;
    if (disc2 >= 0) {
      const t2 = (-b2 - Math.sqrt(disc2)) / 2;
      if (t2 > 0 && t2 < maxDist && t2 <= d) return { d: t2, head: true };
    }
    if (d < maxDist) return { d, head: false };
    return null;
  }

  return {
    mulberry32, genMap, stepPlayer, collidesAt, rayWorld, rayPlayer,
    MAP_SIZE, HALF, GRAVITY, JUMP_V, EYE, EYE_CROUCH, R, H_STAND, H_CROUCH,
    SPEED, STEP_UP, INTERACT_DIST,
    MAX_HP, MAX_SHIELD, DOWN_HP, DOWN_BLEED, REVIVE_TIME, REVIVE_DIST,
    WEAPONS, TIER_MULT, TIER_NAME, WEAPON_TIERS, CONSUMABLES, AMMO_KINDS, AMMO_PICKUP, AMMO_MAX,
    ZONE_PHASES, ZONE_R0,
  };
});
