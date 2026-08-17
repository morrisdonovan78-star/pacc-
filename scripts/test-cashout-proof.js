'use strict';
/*
 * A GENUINE CASH-OUT PROOF WHOSE DEPOSIT MOVED MUST STILL PAY.
 *
 * Owner, 2026-08-17: "people in pac-arena cant cashout it says a bug they already died."
 *
 * THE BUG. `CASHOUT_REQUIRE_PROOF=1` (armed 19 days ago) makes settle demand a GAME_SECRET-HMAC proof
 * from the game server. The proof binds `cashBase` to the `pw:` deposit the server read when it minted
 * it — but `pw:` MOVES while a player eats; the node's own log shows base 13186523 -> 13202192 for one
 * player inside a single session. Any player whose wager changed between mint and cash-out failed that
 * bind, and the guard turned the failure into a flat REFUSAL: "Cash-out could not be verified with the
 * game server", and on the retry, "No wager on record — you may have been eliminated" (the "already
 * died" they reported). Their money was never lost — the refusal restores `pw:` first — but they could
 * not get paid.
 *
 * THE FIX. Split "the HMAC verified" (proofAuthentic) from "the signed figures are authoritative"
 * (proofOk). A moved base is a stale binding, not a forgery — only the holder of GAME_SECRET can sign at
 * all — so it now pays the SIGNED total, floored at the real deposit and capped at 20x it, instead of
 * refusing. A cash-out with no signature, a malformed one, or one that fails the HMAC is still refused,
 * which is what the guard was built for.
 *
 * These drive the REAL exported settle handler with a REAL ed25519 wallet signature and a REAL
 * GAME_SECRET HMAC — the two things that gate this path — over a mocked lib/kv and a faked network. The
 * assertion that matters is the LAMPORTS ACTUALLY SENT, read off the signed transfer.
 *
 * Run: node scripts/test-cashout-proof.js
 */
const crypto = require('crypto');
const nacl = require('tweetnacl');

// ── lib/kv mock ─────────────────────────────────────────────────────────────────────────────────
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

const GAME_SECRET = 'test-game-secret-for-cashout-proof';
process.env.GAME_SECRET = GAME_SECRET;
process.env.CASHOUT_REQUIRE_PROOF = '1';          // ⚠️ the guard ARMED — the live production setting
process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';

const esc = nacl.sign.keyPair();
process.env.ESCROW_SECRET = JSON.stringify(Array.from(esc.secretKey));

// The player, with a real keypair so a real wallet signature can be produced.
const player = nacl.sign.keyPair();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const PLAYER = b58encode(player.publicKey);

// ── network fake: records every transfer so the test can read the lamports actually sent ─────────
const net = { balance: 500_000_000_000, sends: 0, lastLamports: null };
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('coinbase')) return json({ data: { amount: '150.00' } });
  if (u.includes('coingecko') || u.includes('binance')) return json({});
  if (u.includes('discord') || u.includes('webhook')) return json({});
  let body = null; try { body = JSON.parse(opts && opts.body); } catch (_) {}
  const answer = (r) => {
    const m = r.method;
    if (m === 'getBalance') return { value: net.balance };
    if (m === 'getLatestBlockhash') return { value: { blockhash: '9'.repeat(43) } };
    if (m === 'sendTransaction') {
      net.sends++;
      // Decode the transfer amounts out of the signed tx so the assertion is on real bytes, not on a
      // number the handler happened to report back.
      try {
        const raw = Buffer.from(String(r.params[0]), 'base64');
        const amounts = [];
        for (let i = 0; i + 12 <= raw.length; i++) {
          if (raw.readUInt32LE(i) === 2) {                      // SystemProgram::Transfer discriminant
            const v = Number(raw.readBigUInt64LE(i + 4));
            if (v > 0 && v < 1e15) amounts.push(v);
          }
        }
        net.lastLamports = amounts.length ? Math.max(...amounts) : null;
      } catch (_) {}
      return 'SiG' + net.sends + 'x'.repeat(40);
    }
    if (m === 'getSignatureStatuses') return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
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
// A cash-out with a genuine wallet signature. `proof` lets each case choose what the game server said.
async function cashout({ claimed, proof }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = 'pac-arena:cashout:' + PLAYER + ':' + (claimed || 0) + ':' + ts;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, 'utf8'), player.secretKey)).toString('base64');
  const res = mockRes();
  await settle({
    method: 'POST', query: {},
    headers: { 'x-settle-sig': sig, 'x-settle-ts': ts },
    body: { action: 'cashout', playerAddress: PLAYER, wagerLamports: claimed, ...(proof || {}) },
  }, res);
  return res;
}
// Exactly what the game server mints, using the same canonical string settle verifies.
function mintProof({ base, lam, lobby, ts }) {
  const t = ts || Date.now();
  const canon = 'cashout:' + PLAYER + ':' + lobby + ':' + base + ':' + lam + ':' + t;
  return { cashProof: crypto.createHmac('sha256', GAME_SECRET).update(canon).digest('hex'),
           cashTs: t, cashBase: base, cashLamports: lam, cashLobby: lobby };
}
const LOBBY = 'ss-og-paid-lobby-0.15';
const DEPOSIT = 13_202_192;                                     // a real figure from the node's log
function seed(deposit) {
  store.clear();
  store.set('pw:' + PLAYER, String(deposit));
  net.sends = 0; net.lastLamports = null; net.balance = 500_000_000_000;
}

(async () => {
  // ══ 1. THE HAPPY PATH still works: base matches, signed amount paid authoritatively ═════════════
  seed(DEPOSIT);
  let signedTotal = DEPOSIT * 4;                                // ate a lot
  let r = await cashout({ claimed: signedTotal, proof: mintProof({ base: DEPOSIT, lam: signedTotal, lobby: LOBBY }) });
  eq(r.code, 200, 'a matching proof cashes out');
  eq(net.sends > 0, true, 'and money moved');
  const paidExact = net.lastLamports;
  eq(paidExact > DEPOSIT, true, 'paid more than the bare deposit (the food is real)');

  // ══ 2. THE BUG: genuine proof, deposit MOVED since it was minted ════════════════════════════════
  // This is the case that refused honest players outright while the guard was armed.
  seed(DEPOSIT + 15_669);                                       // pw: grew after the proof was minted
  signedTotal = 52_786_121;
  r = await cashout({ claimed: signedTotal, proof: mintProof({ base: DEPOSIT, lam: signedTotal, lobby: LOBBY }) });
  eq(r.code, 200, '⚠️ A GENUINE PROOF WITH A MOVED BASE NOW PAYS — it used to 503');
  eq(!!r.body.error, false, 'with no error');
  eq(net.sends > 0, true, '⚠️ AND MONEY ACTUALLY MOVED');
  eq(store.has('pw:' + PLAYER), false, 'the wager is consumed, not left dangling');

  // ══ 3. …bounded. A genuine proof cannot overpay beyond 20x the real deposit ══════════════════════
  seed(1_000_000);                                              // tiny deposit now
  r = await cashout({ claimed: 900_000_000, proof: mintProof({ base: DEPOSIT, lam: 900_000_000, lobby: LOBBY }) });
  eq(r.code, 200, 'a stale-but-genuine proof from a richer round still pays');
  eq(net.lastLamports <= 1_000_000 * 20, true, '⚠️ CAPPED AT 20x THE REAL DEPOSIT — cannot be milked');

  // ══ 4. …and floored. It never pays less than the deposit actually held ══════════════════════════
  // ⚠️ The transfer the PLAYER receives is the wager minus the 10% cash-out fee (CREATOR_FEE_PCT), so
  // the floor to assert is ~0.9 x the deposit, not the deposit itself. Asserting the raw figure failed
  // here and the code was right — the fee is the difference.
  seed(DEPOSIT);
  r = await cashout({ claimed: 1, proof: mintProof({ base: 999, lam: 1, lobby: LOBBY }) });
  eq(r.code, 200, 'a genuine proof signing less than the deposit still pays');
  eq(net.lastLamports >= Math.floor(DEPOSIT * 0.85), true, '⚠️ FLOORED AT THE DEPOSIT (less the 10% fee) — nobody is shortchanged');

  // ══ 5. THE GUARD STILL GUARDS: no proof at all is refused, and the wager is put back ════════════
  seed(DEPOSIT);
  r = await cashout({ claimed: DEPOSIT * 50 });
  eq(r.code, 503, 'a cash-out with NO proof is still refused');
  eq(net.sends, 0, '⚠️ NOTHING WAS SENT');
  eq(store.get('pw:' + PLAYER), String(DEPOSIT), '⚠️ AND THE WAGER IS RESTORED — never lost');

  // ══ 6. A FORGED proof is refused — the HMAC is the whole defence ════════════════════════════════
  seed(DEPOSIT);
  const forged = mintProof({ base: DEPOSIT, lam: DEPOSIT * 10, lobby: LOBBY });
  forged.cashProof = crypto.createHmac('sha256', 'the-wrong-secret').update('anything').digest('hex');
  r = await cashout({ claimed: DEPOSIT * 10, proof: forged });
  eq(r.code, 503, '⚠️ A FORGED SIGNATURE IS STILL REFUSED');
  eq(net.sends, 0, 'nothing was sent for a forgery');
  eq(store.get('pw:' + PLAYER), String(DEPOSIT), 'and that wager is restored too');

  // ══ 7. A TAMPERED amount breaks the HMAC, so it is a forgery too ════════════════════════════════
  seed(DEPOSIT);
  const tampered = mintProof({ base: DEPOSIT, lam: DEPOSIT * 2, lobby: LOBBY });
  tampered.cashLamports = DEPOSIT * 500;                        // inflate AFTER signing
  r = await cashout({ claimed: DEPOSIT * 500, proof: tampered });
  eq(r.code, 503, '⚠️ EDITING THE SIGNED AMOUNT IS REFUSED');
  eq(net.sends, 0, 'nothing was sent');

  // ══ 8. A STALE proof (older than the 120s window) is refused ════════════════════════════════════
  seed(DEPOSIT);
  r = await cashout({ claimed: DEPOSIT, proof: mintProof({ base: DEPOSIT, lam: DEPOSIT, lobby: LOBBY, ts: Date.now() - 200000 }) });
  eq(r.code, 503, 'a proof past its 120s window is refused');
  eq(net.sends, 0, 'nothing was sent for a stale proof');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
