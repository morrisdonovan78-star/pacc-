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
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://solana.public-rpc.com',
    'https://solana-mainnet.g.alchemy.com/v2/demo',
    'https://api.mainnet-beta.solana.com', // retry official once more
  ];

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
