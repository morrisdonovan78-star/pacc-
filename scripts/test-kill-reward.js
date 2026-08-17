'use strict';
/*
 * A KILLER GETS PAID THE VICTIM'S STAKE.
 *
 * Owner, 2026-08-17: "ppl wasnt getting paid for kills in pac-arena", with money left over in escrow.
 *
 * THE BUG — a race between two paths that both CONSUMED the same key:
 *   * `elim-lock` (called by the game server the INSTANT a player dies) did
 *     `kvGetDel('pw:' + victim)` and DISCARDED the value.
 *   * `kill` (called by the killer's client, moments later) does its own `kvGetDel('pw:' + victim)` to
 *     size the reward.
 * elim-lock won essentially every time, so `kill` read 0 and answered "Victim had no recorded wager —
 * nothing to claim". The killer was never paid AND the victim's stake stayed in escrow as unattributed
 * surplus — both reported symptoms, one cause.
 *
 * THE FIX: elim-lock PRESERVES the stake as `victimstake:<victim>`; `kill` falls back to it with GETDEL,
 * so the reward is payable exactly once.
 *
 * This drives the REAL handlers in the REAL production order — elim-lock first, then kill — with a REAL
 * GAME_SECRET HMAC on both and a REAL wallet signature on the claim. The assertion that matters is the
 * LAMPORTS DECODED OUT OF THE SIGNED TRANSFER.
 *
 * Run: node scripts/test-kill-reward.js
 */
const crypto = require('crypto');
const nacl = require('tweetnacl');

const store = new Map();
const H = (k) => { const h = store.get(k); return (h && typeof h === 'object') ? h : null; };
const kvPath = require.resolve('../lib/kv.js');
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: {
  kvPing: async () => true,
  kvGet: async (k) => (store.has(k) && typeof store.get(k) !== 'object' ? store.get(k) : null),
  kvGetDel: async (k) => { const v = store.has(k) ? store.get(k) : null; store.delete(k); return v; },
  kvSet: async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetPerm: async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetNX: async (k, v) => { if (store.has(k)) return null; store.set(k, String(v)); return 'OK'; },
  kvDel: async (k) => { store.delete(k); return 1; },
  kvIncrby: async (k, d) => { const n = (Number(store.get(k)) || 0) + Number(d); store.set(k, String(n)); return n; },
  kvExpire: async () => 1, kvZadd: async () => 1, kvZrem: async () => 1, kvZrevrange: async () => [],
  kvHincrby: async (k, f, d) => { const h = H(k) || {}; h[f] = String((Number(h[f]) || 0) + Number(d)); store.set(k, h); return Number(h[f]); },
  kvHget: async (k, f) => { const h = H(k); return h && h[f] !== undefined ? h[f] : null; },
  kvHset: async (k, f, v) => { const h = H(k) || {}; h[f] = String(v); store.set(k, h); return 1; },
  kvHsetnx: async () => 1,
  kvHgetall: async (k) => { const h = H(k); return h ? { ...h } : null; },
  kvLpush: async () => 1, kvLtrim: async () => 'OK', kvLrange: async () => [],
  kvMget: async (keys) => keys.map((k) => (store.has(k) && typeof store.get(k) !== 'object' ? store.get(k) : null)),
  kvScan: async (p) => { const rx = new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return [...store.keys()].filter((k) => rx.test(k)); },
}};

const GAME_SECRET = 'test-game-secret-for-kills';
process.env.GAME_SECRET = GAME_SECRET;
process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';
const escKp = nacl.sign.keyPair();
process.env.ESCROW_SECRET = JSON.stringify(Array.from(escKp.secretKey));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const killer = nacl.sign.keyPair(); const KILLER = b58encode(killer.publicKey);
const killer2 = nacl.sign.keyPair(); const KILLER2 = b58encode(killer2.publicKey);
const victim = nacl.sign.keyPair(); const VICTIM = b58encode(victim.publicKey);

const net = { sends: 0, lastLamports: null };
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('coinbase')) return json({ data: { amount: '75.00' } });
  if (u.includes('coingecko') || u.includes('binance') || u.includes('discord') || u.includes('webhook')) return json({});
  let body = null; try { body = JSON.parse(opts && opts.body); } catch (_) {}
  const answer = (r) => {
    if (r.method === 'getBalance') return { value: 500_000_000_000 };
    if (r.method === 'getLatestBlockhash') return { value: { blockhash: '9'.repeat(43) } };
    if (r.method === 'sendTransaction') {
      net.sends++;
      try {
        const raw = Buffer.from(String(r.params[0]), 'base64');
        const amounts = [];
        for (let i = 0; i + 12 <= raw.length; i++) {
          if (raw.readUInt32LE(i) === 2) { const v = Number(raw.readBigUInt64LE(i + 4)); if (v > 0 && v < 1e15) amounts.push(v); }
        }
        net.lastLamports = amounts.length ? Math.max(...amounts) : null;
      } catch (_) {}
      return 'SiG' + net.sends + 'x'.repeat(40);
    }
    if (r.method === 'getSignatureStatuses') return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    return null;
  };
  if (Array.isArray(body)) return json(body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r) })));
  if (body && body.method) return json({ jsonrpc: '2.0', id: body.id, result: answer(body) });
  return json({});
};

const settle = require('../api/settle.js');

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
};
function mockRes() {
  const r = { code: 200, body: null };
  r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r;
  return r;
}
const LOBBY = 'ss-og-paid-lobby-1';
const STAKE = 13_202_192;                              // the $1 lobby figure from the live node log

// Exactly what the game server sends the instant a player dies.
async function elimLock(vic, kil) {
  const ts = Date.now();
  const proof = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + vic + ':' + (kil || '') + ':' + ts).digest('hex');
  const res = mockRes();
  await settle({ method: 'POST', query: {}, headers: { 'x-game-proof': proof, 'x-game-ts': String(ts) },
    body: { action: 'elim-lock', victimAddress: vic, killerAddress: kil, lobbyId: LOBBY } }, res);
  return res;
}
// What the killer's client sends to collect.
async function claimKill(kil, kp, vic, claimed) {
  const kts = Date.now();
  const killProof = crypto.createHmac('sha256', GAME_SECRET).update(`${kil}:${vic}:${kts}`).digest('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = 'pac-arena:kill:' + kil + ':' + claimed + ':' + ts;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey)).toString('base64');
  const res = mockRes();
  await settle({ method: 'POST', query: {}, headers: { 'x-settle-sig': sig, 'x-settle-ts': ts },
    body: { action: 'kill', playerAddress: kil, wagerLamports: claimed,
            killProof, killTs: kts, victimAddress: vic } }, res);
  return res;
}
function seedRound() {
  store.clear();
  net.sends = 0; net.lastLamports = null;
  store.set('pw:' + VICTIM, String(STAKE));            // victim is in a paid lobby
  store.set('pw:' + KILLER, String(STAKE));            // killer must hold a deposit to claim
  store.set('pw:' + KILLER2, String(STAKE));
}

(async () => {
  // ══ 1. THE REAL ORDER: elim-lock fires first, then the killer claims ════════════════════════════
  seedRound();
  let r = await elimLock(VICTIM, KILLER);
  eq(r.code, 200, 'elim-lock succeeds');
  eq(store.has('pw:' + VICTIM), false, "the victim's wager is consumed (they cannot cash out)");
  eq(store.get('victimstake:' + VICTIM), String(STAKE), '⚠️ THE STAKE IS PRESERVED FOR THE KILLER');

  r = await claimKill(KILLER, killer, VICTIM, STAKE);
  eq(r.code, 200, '⚠️ THE KILLER IS PAID — it used to answer "Victim had no recorded wager"');
  eq(String(r.body && r.body.error || '').includes('no recorded wager'), false, 'no "nothing to claim"');
  eq(net.sends > 0, true, '⚠️ MONEY ACTUALLY MOVED');
  eq(net.lastLamports > 0 && net.lastLamports <= STAKE, true, "and it is sized by the victim's stake");

  // ══ 2. EXACTLY ONCE: a second killer cannot be paid for the same corpse ═════════════════════════
  const sendsAfterFirst = net.sends;
  r = await claimKill(KILLER2, killer2, VICTIM, STAKE);
  eq(r.code, 403, '⚠️ A SECOND CLAIM ON THE SAME VICTIM IS REFUSED');
  eq(net.sends, sendsAfterFirst, '⚠️ AND NOTHING IS PAID TWICE');
  eq(store.has('victimstake:' + VICTIM), false, 'the preserved stake was consumed by the first claim');

  // ══ 3. The same killer cannot double-claim by retrying either ══════════════════════════════════
  seedRound();
  await elimLock(VICTIM, KILLER);
  r = await claimKill(KILLER, killer, VICTIM, STAKE);
  eq(r.code, 200, 'first claim paid');
  const sends2 = net.sends;
  r = await claimKill(KILLER, killer, VICTIM, STAKE);
  eq(net.sends, sends2, '⚠️ A REPEAT CLAIM BY THE SAME KILLER PAYS NOTHING EXTRA');

  // ══ 4. A killer with no stake of their own still cannot claim ══════════════════════════════════
  // The anti-drain rule: you must be in the game with real money to collect a kill.
  seedRound();
  store.delete('pw:' + KILLER);
  await elimLock(VICTIM, KILLER);
  const sends3 = net.sends;
  r = await claimKill(KILLER, killer, VICTIM, STAKE);
  eq(r.code, 403, 'a killer with no deposit is refused');
  eq(net.sends, sends3, 'and is paid nothing');

  // ══ 5. A forged kill proof is refused — the HMAC is the gate ════════════════════════════════════
  seedRound();
  await elimLock(VICTIM, KILLER);
  const kts = Date.now();
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = 'pac-arena:kill:' + KILLER + ':' + STAKE + ':' + ts;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), killer.secretKey)).toString('base64');
  const res = mockRes();
  const sends4 = net.sends;
  await settle({ method: 'POST', query: {}, headers: { 'x-settle-sig': sig, 'x-settle-ts': ts },
    body: { action: 'kill', playerAddress: KILLER, wagerLamports: STAKE,
            killProof: crypto.createHmac('sha256', 'wrong-secret').update('x').digest('hex'),
            killTs: kts, victimAddress: VICTIM } }, res);
  eq(res.code, 403, '⚠️ A FORGED KILL PROOF IS REFUSED');
  eq(net.sends, sends4, 'nothing was sent for a forgery');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
