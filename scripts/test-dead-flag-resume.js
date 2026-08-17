'use strict';
/*
 * "CANNOT CASHOUT — YOU WERE ELIMINATED" WHILE ALIVE.
 *
 * Owner, 2026-08-17, on a $1 lobby, on stream, with his snake alive on screen: "i never died".
 *
 * THE BUG. `dead:<wallet>` is set when a player is eliminated, with a 600s TTL, and settle refuses any
 * cash-out while it exists. api/join.js clears it on a new paid join — but only on the FRESH path, ~35
 * lines after the RESUME path returns. A resume happens whenever a join's response was lost and the
 * client retries with the same deposit inside RESUME_WINDOW_MS. So: die, rejoin, and for up to TEN
 * MINUTES every cash-out is refused as "you were eliminated" even though the new round is live.
 *
 * These drive the REAL exported join and settle handlers over a mocked lib/kv, with a REAL ed25519 wallet
 * signature on the cash-out. The proof is the ORDER of operations: resume, then attempt to cash out.
 *
 * Run: node scripts/test-dead-flag-resume.js
 */
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

process.env.GAME_SECRET = 'test-game-secret';
process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';
const escKp = nacl.sign.keyPair();
process.env.ESCROW_SECRET = JSON.stringify(Array.from(escKp.secretKey));

const player = nacl.sign.keyPair();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const PLAYER = b58encode(player.publicKey);

const net = { sends: 0 };
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('coinbase')) return json({ data: { amount: '75.00' } });
  if (u.includes('coingecko') || u.includes('binance') || u.includes('discord') || u.includes('webhook')) return json({});
  let body = null; try { body = JSON.parse(opts && opts.body); } catch (_) {}
  const answer = (r) => {
    if (r.method === 'getBalance') return { value: 500_000_000_000 };
    if (r.method === 'getLatestBlockhash') return { value: { blockhash: '9'.repeat(43) } };
    if (r.method === 'sendTransaction') { net.sends++; return 'SiG' + net.sends + 'x'.repeat(40); }
    if (r.method === 'getSignatureStatuses') return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    return null;
  };
  if (Array.isArray(body)) return json(body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r) })));
  if (body && body.method) return json({ jsonrpc: '2.0', id: body.id, result: answer(body) });
  return json({});
};

const settle = require('../api/settle.js');
const join = require('../api/join.js');

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
async function tryCashout(claimed) {
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = 'pac-arena:cashout:' + PLAYER + ':' + claimed + ':' + ts;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), player.secretKey)).toString('base64');
  const res = mockRes();
  await settle({ method: 'POST', query: {},
    headers: { 'x-settle-sig': sig, 'x-settle-ts': ts },
    body: { action: 'cashout', playerAddress: PLAYER, wagerLamports: claimed } }, res);
  return res;
}

const DEPOSIT = 13_202_192;                                   // the $1 lobby figure from the live node log
const TXSIG = 'DepositTxSignature1111111111111111111111111111111111111111111111';
const LOBBY = 'ss-og-paid-lobby-1';

// The state a RESUME sees: the entry and its opening deposit already recorded, moments old.
function seedResumable() {
  store.clear();
  net.sends = 0;
  store.set('pw:' + PLAYER, String(DEPOSIT));
  store.set('pwtx:' + PLAYER, TXSIG);
  store.set('tx:' + TXSIG, JSON.stringify({ w: PLAYER, l: DEPOSIT, t: Date.now() - 1000 }));
}
async function resumeJoin() {
  const res = mockRes();
  // join also demands a real wallet signature, over action 'join' — same scheme as settle's.
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = 'pac-arena:join:' + PLAYER + ':' + DEPOSIT + ':' + ts;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), player.secretKey)).toString('base64');
  await join({ method: 'POST', query: {}, headers: { 'x-settle-sig': sig, 'x-settle-ts': ts },
    // ⚠️ The field is `wagerLamports` — `lamports` is silently ignored and the join 400s on
    // "wagerLamports must be positive", which looks like the resume path refusing rather than a typo.
    body: { walletAddress: PLAYER, lobbyId: LOBBY, txSig: TXSIG, wagerLamports: DEPOSIT } }, res);
  return res;
}

(async () => {
  // ══ 1. Baseline: an alive player with a deposit can cash out ═════════════════════════════════════
  seedResumable();
  let r = await tryCashout(DEPOSIT);
  eq(r.code, 200, 'an alive player cashes out normally');
  eq(net.sends > 0, true, 'and money moved');

  // ══ 2. A dead flag correctly blocks a cash-out — the guard must keep working ═════════════════════
  seedResumable();
  store.set('dead:' + PLAYER, '1');
  r = await tryCashout(DEPOSIT);
  eq(r.code, 403, 'a genuinely eliminated player is still refused');
  eq(String(r.body.error).includes('eliminated'), true, 'with the eliminated message');
  eq(net.sends, 0, 'and nothing is sent');

  // ══ 3. THE BUG: died, then REJOINED via the resume path, and is still called eliminated ══════════
  seedResumable();
  store.set('dead:' + PLAYER, '1');                           // died in the round just finished
  const jr = await resumeJoin();
  eq(jr.code, 200, 'the resume join succeeds');
  eq(jr.body.resumed, true, '⚠️ IT REALLY TOOK THE RESUME PATH — the one that returns early');
  eq(store.has('dead:' + PLAYER), false, '⚠️ THE RESUME CLEARS THE DEAD FLAG (it used to leave it set)');

  r = await tryCashout(DEPOSIT);
  eq(r.code, 200, '⚠️ AND THE REJOINED PLAYER CAN CASH OUT — no "you were eliminated"');
  eq(String(r.body && r.body.error || '').includes('eliminated'), false, 'the message is gone');
  eq(net.sends > 0, true, '⚠️ MONEY ACTUALLY MOVED');

  // ══ 4. A stale cash-out lock must not survive the rejoin either ══════════════════════════════════
  // Same class of leftover: `lock:co:` from an ended session answers "cashout already in progress" to
  // every attempt in the new one.
  seedResumable();
  store.set('lock:co:' + PLAYER, '1');
  await resumeJoin();
  eq(store.has('lock:co:' + PLAYER), false, '⚠️ THE RESUME CLEARS THE STALE CASH-OUT LOCK');
  r = await tryCashout(DEPOSIT);
  eq(r.code, 200, 'so the cash-out is not refused as already-in-progress');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
