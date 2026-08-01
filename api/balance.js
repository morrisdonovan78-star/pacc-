// Vercel serverless — fetches Solana balance server-side.
// No CORS issues, no browser rate-limits. Tries multiple RPC endpoints.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const address = req.query.address || '';
  if (!address) {
    res.status(400).json({ error: 'address required' });
    return;
  }

  // Ankr removed free access — use official Solana RPC (works server-side)
  // solana.public-rpc.com fails TLS and the Alchemy demo key is shared/throttled — both measured
  // dead or unreliable on 2026-08-01. publicnode is free, keyless and healthy.
  const rpcs = [
    process.env.HELIUS_RPC_URL,
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
  ].filter(Boolean);

  const INFRA_CODES = new Set([-32052, -32055, -32029, -32603]);

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getBalance',
    params: [address, { commitment: 'confirmed' }]
  });

  let lastError = 'unknown';
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      const data = await r.json();
      if (data.error && INFRA_CODES.has(data.error.code)) {
        lastError = data.error.message;
        continue;
      }
      if (typeof data?.result?.value === 'number') {
        res.status(200).json({ lamports: data.result.value, rpc });
        return;
      }
      lastError = data?.error?.message || 'no result.value';
    } catch (e) {
      lastError = e.message;
    }
  }

  res.status(502).json({ error: 'All RPCs failed', detail: lastError });
};
