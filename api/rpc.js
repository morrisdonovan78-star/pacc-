// Vercel serverless — proxies ALL Solana JSON-RPC calls server-side.
// Fixes 403/CORS blocks that happen when browsers hit Solana RPCs directly.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).end(); return; }

  // Ankr now requires a paid API key — removed.
  // api.mainnet-beta.solana.com works fine from Vercel (server-to-server).
  // ⚠️ HELIUS_RPC_URL FIRST. This endpoint carries the ENTIRE deposit path — getLatestBlockhash,
  // sendTransaction, getSignatureStatuses — for every paid join and every bet. It used to run purely
  // on free public nodes, and those are frequently rate-limited or outright broken (measured: 2 of
  // the 3 returned non-JSON garbage). When they fail, a player's transaction is built on a stale
  // blockhash or never broadcast: they are NOT charged, nothing confirms, /api/join cannot find the
  // tx, and the join dies after retrying — the "long wait, verified 4 times, never let in, never
  // charged" report. api/settle.js already prefers Helius; this path was left behind.
  // Set HELIUS_RPC_URL in the Vercel env (free tier, 50 req/s) — without it this stays flaky.
  // Endpoint list, best first. HELIUS_RPC_URL is optional — the two public entries below were
  // MEASURED healthy on 2026-07-18 and need no API key, so the deposit path is no longer riding on a
  // single node. The three that used to be here were verified BROKEN the same day and are removed:
  //   solana.public-rpc.com          -> non-JSON garbage
  //   solana-mainnet.g.alchemy.com/v2/demo -> demo key, unusable under load
  //   solana.drpc.org                -> "chain is not available on freetier"
  // Adding HELIUS_RPC_URL still helps (dedicated 50 req/s, no shared rate limit) but is no longer
  // required for a working join.
  const rpcs = [
    process.env.HELIUS_RPC_URL,                      // best when configured (dedicated capacity)
    process.env.SOLANA_RPC_URL,                      // optional second private endpoint
    'https://solana-rpc.publicnode.com',             // free, no key, verified healthy
    'https://api.mainnet-beta.solana.com',           // official, rate-limited under load
  ].filter(Boolean);

  // RPC error codes that mean "this node can't help us" — that node is discarded and we take
  // whichever OTHER node answers. Legitimate errors (insufficient funds, bad tx, etc.) pass through.
  const INFRA_CODES = new Set([-32052, -32055, -32029, -32603, 403, 429]);

  const body = JSON.stringify(req.body);

  // RACE every endpoint instead of walking them one-by-one.
  //
  // This used to be a sequential loop with a 20s timeout per node: if the first RPC was merely SLOW
  // (not down), the caller sat there for 20s before the second was even tried — up to ~80s for all
  // four. That is exactly what made joining a paid lobby hang on "Signing…" for a minute or more,
  // because the join flow proxies getLatestBlockhash → sendTransaction → getSignatureStatuses
  // through here. Public Solana nodes are frequently slow rather than dead, so racing them means the
  // fastest healthy node sets the pace and one stalled node costs nothing. Same approach api/settle.js
  // already uses for its own RPC calls. Per-node timeout is also cut 20s → 8s.
  const attempt = async (url) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    const data = await r.json();
    // Treat an infrastructure error as a failure of THIS node so Promise.any moves to another.
    if (data.error && INFRA_CODES.has(data.error.code)) {
      throw new Error(data.error.message || `RPC error ${data.error.code}`);
    }
    return data;
  };

  // ── getLatestBlockhash needs the FRESHEST node, not the fastest ────────────────────────────────
  // Racing and taking whoever answers first is wrong here: a node that replies quickly but is a few
  // slots BEHIND hands back an old blockhash. The wallet then signs a transaction that Solana drops
  // as expired — so the player is never charged, nothing ever confirms, /api/join can't find the tx,
  // and the join dies after retrying. That is the "long wait, verified 4 times, never let in, never
  // charged" report. Collect the answers and take the one with the highest lastValidBlockHeight.
  // Resolved early once we have a couple of opinions (or a short deadline) so this stays fast.
  if (req.body && req.body.method === 'getLatestBlockhash') {
    const freshness = d => {
      const v = d && d.result && (d.result.value || d.result);
      return (v && Number(v.lastValidBlockHeight)) || (d && d.result && d.result.context && Number(d.result.context.slot)) || 0;
    };
    const got = [];
    const best = await new Promise(resolve => {
      let left = rpcs.length, settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(got.slice()); } };
      const timer = setTimeout(finish, 1500);          // don't wait on a slow node
      for (const url of rpcs) {
        attempt(url).then(d => { if (d && d.result) got.push(d); })
          .catch(() => {})
          .finally(() => {
            // Two independent answers is enough to spot a laggard; otherwise wait for the rest.
            if (got.length >= 2 || --left === 0) { clearTimeout(timer); finish(); }
          });
      }
      if (!left) { clearTimeout(timer); finish(); }
    });
    if (best.length) {
      best.sort((a, b) => freshness(b) - freshness(a));
      res.status(200).json(best[0]);
      return;
    }
    res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'All RPC endpoints failed (blockhash)' }, id: null });
    return;
  }

  // ── getSignatureStatuses needs "first node that FOUND it", not "first node to answer" ──────────
  // A node that hasn't indexed the signature yet replies with a perfectly valid {value:[null]} —
  // "not found". Racing and taking the fastest answer would keep returning that null even though a
  // slower node already has the transaction, so the client polls until it times out: the reported
  // "stuck on Confirming on-chain" when joining a paid lobby. Resolve as soon as ANY node reports a
  // real status; only fall back to a "not found" once every node has answered.
  if (req.body && req.body.method === 'getSignatureStatuses') {
    const found = await new Promise((resolve) => {
      let pending = rpcs.length;
      let firstOk = null;
      if (!pending) return resolve(null);
      for (const url of rpcs) {
        attempt(url).then((d) => {
          if (!firstOk) firstOk = d;
          const v = d && d.result && Array.isArray(d.result.value) ? d.result.value[0] : null;
          if (v) resolve(d);                    // this node actually has the tx — take it
        }).catch(() => {}).finally(() => {
          if (--pending === 0) resolve(firstOk); // everyone answered "not found" (or failed)
        });
      }
    });
    if (found) { res.status(200).json(found); return; }
    res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'All RPC endpoints failed (status check)' }, id: null });
    return;
  }

  // ── sendTransaction needs "first node that ACCEPTED it", not "first node to answer" ─────────────
  // The tx is broadcast to every RPC at once (a transfer is idempotent by signature, so multi-send is
  // safe and gives it the best chance of landing). But preflight runs independently on each node, and a
  // node that is a few slots BEHIND doesn't have our fresh blockhash yet — its preflight fails with
  //   { error: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } }
  // -32002 is NOT an INFRA_CODE, so a plain race (Promise.any) treats that error as a valid answer and,
  // if the laggard replies first, returns it to the caller. The join then dies with "Transaction
  // simulation failed" — EVEN THOUGH a fresher node in the same race accepted and broadcast the very
  // same tx, so the player's SOL already left their wallet into escrow. They aren't credited, they
  // retry, they deposit again: that is the "wallet drains to zero / transaction simulation failed /
  // can't join" report. Fix: take the FIRST node that returns a real signature; only surface an error
  // once every node has errored (a genuine failure like insufficient funds fails on all of them, so it
  // still passes through cleanly).
  if (req.body && req.body.method === 'sendTransaction') {
    const chosen = await new Promise((resolve) => {
      let pending = rpcs.length;
      let firstErr = null;
      if (!pending) return resolve({ ok: false, data: null });
      for (const url of rpcs) {
        attempt(url).then((d) => {
          if (d && typeof d.result === 'string' && d.result && !d.error) {
            resolve({ ok: true, data: d });               // this node accepted + broadcast — the signature is truth
          } else if (d && d.error && !firstErr) {
            firstErr = d;                                  // hold a real RPC error (e.g. insufficient funds) in case ALL fail
          }
        }).catch(() => {}).finally(() => {
          if (--pending === 0) resolve({ ok: false, data: firstErr });  // nobody accepted it
        });
      }
    });
    if (chosen.ok) { res.status(200).json(chosen.data); return; }
    if (chosen.data) { res.status(200).json(chosen.data); return; }     // consistent, genuine error across all nodes
    res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'All RPC endpoints failed (send)' }, id: null });
    return;
  }

  // Two quick rounds: a transient blip across all nodes still recovers, but we never spend
  // anywhere near the old worst case.
  let lastError = 'no endpoints tried';
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 400));
    try {
      const data = await Promise.any(rpcs.map(attempt));
      res.status(200).json(data);
      return;
    } catch (e) {
      lastError = (e && e.errors ? e.errors.map(x => x.message).join(' | ') : e.message) || 'unknown';
      console.error('[rpc proxy] round', round + 1, 'failed →', lastError);
    }
  }

  res.status(502).json({
    jsonrpc: '2.0',
    error: { code: -32603, message: 'All RPC endpoints failed: ' + lastError },
    id: null,
  });
};
