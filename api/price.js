// api/price.js — Real-time SOL/USD price with multi-source fallback + server-side caching.
// Clients call GET /api/price instead of hitting CoinGecko directly.
// The server caches the price for 30 seconds so hundreds of concurrent players
// don't each spam external APIs (and hit rate limits).
//
// ── THIS ROUTE IS CDN-CACHED FOR 30s ON SUCCESS ONLY ────────────────────────────────────────────
// (The header is set below, per response. vercel.json only stops forcing no-store onto this path;
//  it is strict-schema JSON and cannot carry a comment, so the reasoning lives here.)
//
// It is the ONLY /api route safe to cache, and it is safe because it is display-only: the payout
// maths never reads it. api/settle.js has its own solUsdQuick() that queries the exchanges directly,
// so no money figure descends from this response — it drives the $ amounts on screen.
//
// Why bother: measured on production, over a 23-second window the request mix was settle 40%,
// rpc 39%, price 12%, join 9%, at 4+ req/s sustained. This route was ~1 in 8 of every function
// invocation on a project that is already over its Fluid Active CPU allowance and gets THROTTLED —
// and throttling is not cosmetic, it can time out the payout-confirmation step. The 30s in-memory
// cache below only helps within one warm instance; every cold start and every other instance paid
// again for the same public number.
//
// The CDN TTL matches CACHE_TTL exactly, so it adds no staleness that this file did not already
// accept. Three header rules exist rather than two because the catch-all sets
// Vercel-CDN-Cache-Control: no-store, which would keep the CDN out of it entirely; the negative
// lookaheads make sure exactly ONE rule matches this path, so nothing depends on which rule wins.
//
// Only a SUCCESS is cached, which is why the header is set here and not in vercel.json: a config
// header is applied whatever the status, so an all-sources-down 502 would be pinned in front of
// every player for 30 seconds. Same reason the platform's /api/event route caches only its success.

let _cached = null;   // last known good price
let _cacheTs = 0;     // timestamp of last successful fetch
const CACHE_TTL = 30_000; // 30-second server cache

// Sources tried in order — first success wins.
//
// ⚠️ BINANCE IS GONE, AND MUST NOT COME BACK. It was first in this list, and from here it can only
// ever fail: `api.binance.com` geo-blocks the United States with HTTP 451, and this function is
// pinned to `iad1` (see vercel.json) — Virginia. Every single cache miss therefore spent a full
// round trip on a request that was guaranteed to be refused before falling through to Coinbase,
// which is what filled the logs with `[price] Binance failed: HTTP 451` every ~35 seconds forever.
// Nothing was ever broken for players (Coinbase answered and the price was right), but it added
// latency to every refresh and buried real errors under noise. Coinbase leads now.
const SOURCES = [
  {
    name: 'Coinbase',
    url:  'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    parse: d => parseFloat(d?.data?.amount),
  },
  {
    name: 'Jupiter',
    url:  'https://price.jup.ag/v6/price?ids=SOL',
    parse: d => d?.data?.SOL?.price,
  },
  {
    name: 'CoinGecko',
    url:  'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    parse: d => d?.solana?.usd,
  },
  {
    name: 'CoinPaprika',
    url:  'https://api.coinpaprika.com/v1/tickers/sol-solana',
    parse: d => d?.quotes?.USD?.price,
  },
];

async function trySource(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const r = await fetch(src.url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const p = src.parse(d);
    if (!p || isNaN(p) || p <= 0) throw new Error(`bad value: ${p}`);
    return p;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // CDN cache, matched to CACHE_TTL. Applied per-response so it lands on a real price and never on
  // an outage — a 502 keeps no-store and is re-tried immediately instead of being pinned for 30s.
  const cacheable = () => {
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=30, stale-while-revalidate=120');
  };

  // Return cached price if still fresh
  const now = Date.now();
  if (_cached && now - _cacheTs < CACHE_TTL) {
    cacheable();
    return res.status(200).json({
      price:  _cached,
      source: 'cache',
      age:    Math.round((now - _cacheTs) / 1000),
    });
  }

  // Try each source in order
  let lastErr;
  for (const src of SOURCES) {
    try {
      const price = await trySource(src);
      _cached  = price;
      _cacheTs = Date.now();
      console.log(`[price] ${src.name} → $${price.toFixed(4)}`);
      cacheable();
      return res.status(200).json({ price, source: src.name, age: 0 });
    } catch (e) {
      console.error(`[price] ${src.name} failed: ${e.message}`);
      lastErr = e;
    }
  }

  // All live sources failed — return stale cache rather than breaking the UI
  if (_cached) {
    console.warn('[price] all sources failed — returning stale cache');
    // Still cacheable: it is the last good price, and pinning it briefly is far better than every
    // player independently retrying five dead upstreams.
    cacheable();
    return res.status(200).json({
      price:  _cached,
      source: 'stale',
      age:    Math.round((now - _cacheTs) / 1000),
    });
  }

  res.status(502).json({ error: 'All price sources unavailable: ' + lastErr?.message });
};
