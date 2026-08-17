'use strict';
/*
 * NO EVENT PAYS THE SAME PLACE TWICE.
 *
 * Owner, 2026-08-17: the Recruiter-of-the-Week prize was PAID TWICE FOR THE SAME WEEK — "make sure no
 * events do this". This suite is the guard for the mechanism that allowed it.
 *
 * THE BUG, precisely. A payout takes an NX pay-lock so it can run at most once. On failure the lock was
 * DELETED, so the next trigger could retry — which is right when the money definitely did not move (an
 * unfunded float), and wrong when it might have. `wgPayOne` returned a bare `{ok:false}` for both, and
 * a failed `sendTransaction` cannot be told apart from a LOST RESPONSE to a transaction already in the
 * mempool. Combined with the recruiter board's trigger — an UNAUTHENTICATED read every client fired
 * when the referral panel opened — a lost response was retried within seconds by the next player to
 * look, and the same week paid out twice.
 *
 * WHAT IS TESTED. The real shipped `settleBounty` and `wgPayOne`, reached through `_payInternals`, with
 * ONLY the network faked (`global.fetch`) and lib/kv mocked. Every decision under test — the solvency
 * read, the send, the confirm poll, the lock take, the lock release — is the real code path. A test that
 * reimplemented the lock rules would have stayed green through the whole double payment, which is the
 * lesson from a 28/28 suite that was green while `rotEditFrame` was missing from an export list.
 *
 * The load-bearing assertion in each case is the COUNT OF sendTransaction CALLS: that, not a returned
 * flag, is what "paid twice" actually means.
 *
 * Run: node scripts/test-double-pay.js
 */

const nacl = require('tweetnacl');

// ── lib/kv mock, injected before settle.js loads ─────────────────────────────────────────────────
const store = new Map();
const H = (k) => { const h = store.get(k); return (h && typeof h === 'object') ? h : null; };
const kvPath = require.resolve('../lib/kv.js');
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: {
  kvPing:      async () => true,
  kvGet:       async (k) => (store.has(k) && typeof store.get(k) !== 'object' ? store.get(k) : null),
  kvGetDel:    async (k) => { const v = store.get(k) ?? null; store.delete(k); return v; },
  kvSet:       async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetPerm:   async (k, v) => { store.set(k, String(v)); return 'OK'; },
  kvSetNX:     async (k, v) => { if (store.has(k)) return null; store.set(k, String(v)); return 'OK'; },
  kvDel:       async (k) => { store.delete(k); return 1; },
  kvIncrby:    async (k, d) => { const n = (Number(store.get(k)) || 0) + Number(d); store.set(k, String(n)); return n; },
  kvExpire:    async () => 1,
  kvZadd:      async () => 1,
  kvZrem:      async () => 1,
  kvZrevrange: async () => [],
  kvHincrby:   async (k, f, d) => { const h = H(k) || {}; h[f] = String((Number(h[f]) || 0) + Number(d)); store.set(k, h); return Number(h[f]); },
  kvHget:      async (k, f) => { const h = H(k); return h && h[f] !== undefined ? h[f] : null; },
  kvHset:      async (k, f, v) => { const h = H(k) || {}; h[f] = String(v); store.set(k, h); return 1; },
  kvHsetnx:    async () => 1,
  kvHgetall:   async (k) => { const h = H(k); return h ? { ...h } : null; },
  kvLpush:     async () => 1,
  kvLtrim:     async () => 'OK',
  kvLrange:    async () => [],
  // Must return real values: sumWagerLiability reads `pw:*` through MGET, and a mock that always
  // answered null pinned player liability at 0 forever — which silently made the "solvency refuses
  // AFTER the lock was taken" case (4b below) unreachable, the one case that decides whether a
  // legitimately-blocked payout can ever be retried.
  kvMget:      async (keys) => keys.map((k) => (store.has(k) && typeof store.get(k) !== 'object' ? store.get(k) : null)),
  kvScan:      async (pattern) => {
    const rx = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...store.keys()].filter((k) => rx.test(k));
  },
}};

// A real keypair — getEscrow parses and signs with it, so it has to be genuine 64 bytes.
const kp = nacl.sign.keyPair();
process.env.ESCROW_SECRET = JSON.stringify(Array.from(kp.secretKey));
process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';   // single fake node → one fetch per rpc call

// ── network fake ─────────────────────────────────────────────────────────────────────────────────
// Behaviour is switched per scenario. `sends` counts sendTransaction calls, including the rebroadcasts
// sendAndConfirm makes — the number that decides whether anybody got paid twice.
const net = { balance: 5_000_000_000, sendMode: 'ok', statusMode: 'confirmed', sends: 0 };
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('coinbase')) return json({ data: { amount: '150.00' } });
  if (u.includes('coingecko') || u.includes('binance')) return json({});
  if (u.includes('discord') || u.includes('webhook')) return json({});
  let body = null;
  try { body = JSON.parse(opts && opts.body); } catch (_) {}
  const answer = (req) => {
    const m = req.method;
    if (m === 'getBalance')         return { value: net.balance };
    if (m === 'getLatestBlockhash') return { value: { blockhash: '9'.repeat(43) } };
    if (m === 'sendTransaction') {
      net.sends++;
      if (net.sendMode === 'throw') return { __error: { code: -32603, message: 'node unreachable' } };
      return 'SiG' + net.sends + 'x'.repeat(40);
    }
    if (m === 'getSignatureStatuses') {
      if (net.statusMode === 'onchain-err') return { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
      if (net.statusMode === 'never')       return { value: [null] };
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    }
    return null;
  };
  if (Array.isArray(body)) {                                  // batched (fetchBalAndHash)
    return json(body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r) })));
  }
  if (body && body.method) {
    const res = answer(body);
    if (res && res.__error) return json({ jsonrpc: '2.0', id: body.id, error: res.__error });
    return json({ jsonrpc: '2.0', id: body.id, result: res });
  }
  return json({});
};

process.env.GAME_SECRET   = 'test-game-secret';
process.env.ADMIN_SECRET  = 'test-admin-secret';

const crypto = require('crypto');
const settle = require('../api/settle.js');
const { settleBounty, wgPayOne, releasePayLock } = settle._payInternals;

// Drive the real HTTP handler for the blackjack/coinflip paths — they are reached through the router and
// their GAME_SECRET proof, and the thing under test is the RESPONSE (`retry`) as much as the lock.
function mockRes() {
  const r = { code: 200, body: null };
  r.setHeader = () => {};
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const callSettle = async (body, proofPayload) => {
  const res = mockRes();
  const ts = Date.now();
  const headers = {};
  if (proofPayload) {
    headers['x-game-ts'] = String(ts);
    headers['x-game-proof'] = crypto.createHmac('sha256', process.env.GAME_SECRET)
      .update(proofPayload.replace('{TS}', String(ts))).digest('hex');
  }
  await settle({ method: 'POST', query: {}, headers, body }, res);
  return res;
};

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error('  FAIL ' + msg + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
};

const WINNER = 'So11111111111111111111111111111111111111112';
// A test-only occurrence. Deliberately NOT bounty-2026-07-25: that id is hard short-circuited in
// settleBounty (2nd place was paid by hand out-of-band) and would never reach a payout at all.
const EV = { id: 'bounty-2099-01-01', day: '2099-01-01', start: 1, end: 2 };

function seedBoard() {
  store.clear();
  store.set('evtk:' + EV.id, { [WINNER]: '9' });               // one winner, 9 kills → 1st place
  net.sends = 0; net.balance = 5_000_000_000; net.sendMode = 'ok'; net.statusMode = 'confirmed';
}
const lockHeld = () => store.has('evtpaid:' + EV.id + ':1');

(async () => {
  // ══ 1. wgPayOne classifies its own failures ═════════════════════════════════════════════════════
  // The flag every caller's lock decision reads. Checked directly first, so a failure here points at
  // the classifier rather than at the lock logic downstream.
  seedBoard();
  const esc = { pubkeyB58: 'Esc' + '1'.repeat(41), secretKey: kp.secretKey, publicKey: kp.publicKey };

  let r = await wgPayOne(esc, WINNER, 0, 'test:zero');
  eq(r.ok, false, 'a zero payout fails');
  eq(r.mayHavePaid, false, 'a zero payout cannot have paid — safe to release a lock');

  net.balance = 1000;                                          // below rent + payout → refused
  r = await wgPayOne(esc, WINNER, 1_000_000_000, 'test:insolvent');
  eq(r.ok, false, 'an insolvent payout fails');
  eq(r.mayHavePaid, false, 'a refused payout never reached the network — safe to release');
  eq(net.sends, 0, 'and nothing was broadcast');

  net.balance = 5_000_000_000; net.sendMode = 'throw';
  r = await wgPayOne(esc, WINNER, 1_000_000, 'test:sendfail');
  eq(r.ok, false, 'a failed submit fails');
  eq(r.mayHavePaid, true, '⚠️ A FAILED SUBMIT MAY HAVE LANDED — never release the lock');

  net.sendMode = 'ok'; net.statusMode = 'onchain-err';
  r = await wgPayOne(esc, WINNER, 1_000_000, 'test:rejected');
  eq(r.ok, false, 'an on-chain rejection fails');
  eq(r.mayHavePaid, false, 'a rejected tx moved no lamports — safe to release');

  net.statusMode = 'never';
  r = await wgPayOne(esc, WINNER, 1_000_000, 'test:unconfirmed');
  eq(r.ok, true, 'an unconfirmed-but-broadcast send is reported as SUCCESS, so its lock is kept');
  eq(r.confirmed, false, 'and is flagged unconfirmed');

  // ══ 2. THE HEADLINE: a paid place is never paid again ════════════════════════════════════════════
  seedBoard();
  let res = await settleBounty(EV, { dryRun: false });
  eq(res.ok, true, 'the first settle pays');
  eq(res.result.winners[0].ok, true, '1st place is paid');
  eq(lockHeld(), true, 'the pay-lock is held after a successful payout');
  const sendsAfterFirst = net.sends;

  res = await settleBounty(EV, { dryRun: false });              // run it again, same event
  eq(res.result.winners[0].already, true, 'a second settle reports the place as already paid');
  eq(net.sends, sendsAfterFirst, '⚠️ RUNNING THE SETTLE TWICE SENDS NO SECOND TRANSACTION');

  // ══ 3. A send that MAY have landed holds its lock — the recruiter bug ═══════════════════════════
  seedBoard();
  net.sendMode = 'throw';
  res = await settleBounty(EV, { dryRun: false });
  eq(res.result.winners[0].ok, false, 'the payout is reported as failed');
  eq(res.result.winners[0].heldForReview, true, 'and flagged as held for review');
  eq(lockHeld(), true, '⚠️ THE LOCK IS HELD, not released');

  // The retry that paid the recruiter a second time. It must not send anything.
  net.sendMode = 'ok';                                          // the network recovers
  const sendsBeforeRetry = net.sends;
  res = await settleBounty(EV, { dryRun: false });
  eq(net.sends, sendsBeforeRetry, '⚠️ THE RETRY SENDS NOTHING — this is the double payment, prevented');
  eq(res.result.winners[0].already, true, 'the retry reports it as already locked');

  // ══ 4. …but a payout that definitely did NOT happen still retries ═══════════════════════════════
  // The release exists for the ordinary case: the float was not funded. Breaking that would mean a
  // winner could never be paid after one failed attempt, so it is asserted just as hard.
  seedBoard();
  net.balance = 1000;                                           // float empty → refused, nothing sent
  res = await settleBounty(EV, { dryRun: false });
  eq(res.ok, false, 'an unfunded settle does not pay');
  eq(lockHeld(), false, 'no lock is left behind when nothing was sent');

  net.balance = 5_000_000_000;                                  // owner funds the float
  res = await settleBounty(EV, { dryRun: false });
  eq(res.ok, true, 'and the retry now pays');
  eq(res.result.winners[0].ok, true, 'the winner is paid exactly once, after the float was funded');

  // ══ 4b. Solvency refusing AFTER the lock is taken must ALSO release it ═══════════════════════════
  // Case 4 above never reaches wgPayOne: planBountyPayout compares the bare balance against the rent
  // floor and bails before any lock exists. This is the case that does reach it — the balance is ample,
  // so the plan is fine, but the money is OWED TO PLAYERS (`pw:` liability), so assertSolvency refuses
  // once the lock is already held. If that lock were not released, a transient liability spike would
  // block the winner's prize permanently and need a hand-clear.
  seedBoard();
  store.set('pw:' + WINNER, '4900000000');                      // nearly the whole balance is players'
  res = await settleBounty(EV, { dryRun: false });
  eq(res.result.winners[0].ok, false, 'a payout refused by the solvency gate does not pay');
  eq(res.result.winners[0].reason, 'insolvent', 'and reports why');
  eq(res.result.winners[0].heldForReview, false, 'a refusal is unambiguous — nothing was sent');
  eq(net.sends, 0, 'nothing was broadcast');
  eq(lockHeld(), false, 'so its lock IS released and the prize can still be paid later');

  store.delete('pw:' + WINNER);                                 // players cash out
  res = await settleBounty(EV, { dryRun: false });
  eq(res.result.winners[0].ok, true, 'and once escrow is free again the winner is paid');
  eq(net.sends > 0, true, 'exactly one send happened on the retry');

  // ══ 5. An on-chain rejection also stays retryable ═══════════════════════════════════════════════
  seedBoard();
  net.statusMode = 'onchain-err';
  res = await settleBounty(EV, { dryRun: false });
  eq(res.result.winners[0].ok, false, 'a rejected payout is reported failed');
  eq(res.result.winners[0].heldForReview, false, 'a rejection is not ambiguous, so it is not held');
  eq(lockHeld(), false, 'its lock is released so it can be retried');

  // ══ 7. THE HELPER ITSELF — one rule, fourteen call sites ════════════════════════════════════════
  // Every payout path delegates the release decision here, so this is the single thing that has to be
  // right. Tested directly as well as through the paths, because a subtle inversion here would be a
  // double payment in blackjack, coinflip, kart and the bounty simultaneously.
  store.clear();
  store.set('lk:test', '1');
  eq(await releasePayLock('lk:test', { ok: false, mayHavePaid: false, reason: 'insolvent' }, 't'), true,
     'a definitely-unpaid failure releases the lock');
  eq(store.has('lk:test'), false, 'and the key is actually gone');
  store.set('lk:test2', '1');
  eq(await releasePayLock('lk:test2', { ok: false, mayHavePaid: true, reason: 'Send failed: x' }, 't'), false,
     '⚠️ a maybe-paid failure HOLDS the lock');
  eq(store.has('lk:test2'), true, 'and the key is still there');

  // ══ 8. BLACKJACK — the hottest path, because the client retries by itself ════════════════════════
  // A seat's ante refund. The game server calls this on a loop with no human in it, so the `retry` field
  // is load-bearing: telling it to retry against a HELD lock makes it hammer a lock that never opens,
  // and releasing the lock when the transfer may have landed refunds the ante twice.
  const HAND = 'hand-test-1';
  // ⚠️ Must be a REAL base58 32-byte key. An invented 44-char string decodes to 33 bytes, buildTx throws
  // 'recipient must be 32 bytes', and case 8a then passed for entirely the wrong reason — a build error
  // rather than a send failure. This is the system program id: 32 zero bytes.
  const SEAT = '11111111111111111111111111111111';
  const bjSeed = () => {
    store.clear();
    store.set('bjdep:' + HAND + ':' + SEAT, JSON.stringify({ addr: SEAT, lamports: 50_000_000 }));
    net.sends = 0; net.balance = 5_000_000_000; net.sendMode = 'ok'; net.statusMode = 'confirmed';
  };
  const bjLock = () => store.has('bjpaid:' + HAND + ':' + SEAT);

  // 8a. A send that may have landed: lock HELD and the client is told NOT to retry.
  bjSeed();
  net.sendMode = 'throw';
  let r2 = await callSettle({ action: 'bj-refund', handId: HAND, address: SEAT },
                            'bj-refund:' + HAND + ':' + SEAT + ':{TS}');
  eq(r2.code, 409, 'an unresolved bj refund answers 409, not 503');
  eq(r2.body.retry, false, '⚠️ THE SELF-RETRYING CLIENT IS TOLD NOT TO RETRY');
  eq(r2.body.held, true, 'and it is reported as held');
  eq(bjLock(), true, '⚠️ the ante lock is HELD, so the refund cannot go out twice');

  const bjSendsBefore = net.sends;
  net.sendMode = 'ok';                                          // network recovers, server retries anyway
  r2 = await callSettle({ action: 'bj-refund', handId: HAND, address: SEAT },
                        'bj-refund:' + HAND + ':' + SEAT + ':{TS}');
  eq(net.sends, bjSendsBefore, '⚠️ A RETRY SENDS NOTHING — the double refund, prevented');
  eq(r2.body.already, true, 'the retry is reported as already handled');

  // 8b. …and an unambiguous failure still frees the refund to be retried.
  bjSeed();
  /* ⚠️ Getting this refusal to actually happen took three attempts, and each failure was the test
   * quietly PAYING instead of refusing:
   *   1. `pw:` liability does nothing here — wgPayWinnerAndFee asserts solvency WITHOUT protectPlayers,
   *      and checkInvariant deliberately leaves wagerLiability out of that gate.
   *   2. High betLiability alone does nothing either, because the gate is
   *      `max(0, betLiability − payout)`: a refund RETIRES the very claim it is paying, so it is
   *      correctly allowed.
   * What refuses is escrow being short against OTHER bettors' claims: 200,000,000 on hand against
   * 4,990,000,000 owed. */
  net.balance = 200_000_000;
  store.set('betledger', { betLiability: '4990000000', accruedFee: '0' });
  r2 = await callSettle({ action: 'bj-refund', handId: HAND, address: SEAT },
                        'bj-refund:' + HAND + ':' + SEAT + ':{TS}');
  eq(r2.body.retry, true, 'a refused refund DOES tell the client to retry');
  eq(bjLock(), false, 'and its lock is released');
  eq(net.sends, 0, 'nothing was sent');

  net.balance = 5_000_000_000;                                  // escrow funded again
  store.set('betledger', { betLiability: '0', accruedFee: '0' });
  r2 = await callSettle({ action: 'bj-refund', handId: HAND, address: SEAT },
                        'bj-refund:' + HAND + ':' + SEAT + ':{TS}');
  eq(r2.body.ok, true, 'and once escrow is free the ante is refunded');
  eq(net.sends > 0, true, 'exactly one send happened');

  // ══ 6. A dry run never takes a lock or sends ════════════════════════════════════════════════════
  seedBoard();
  res = await settleBounty(EV, { dryRun: true });
  eq(res.dryRun, true, 'dry run returns a plan');
  eq(net.sends, 0, 'DRY RUN SENDS NOTHING');
  eq(lockHeld(), false, 'DRY RUN TAKES NO LOCK');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
