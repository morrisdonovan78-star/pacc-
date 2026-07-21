'use strict';
// Verifies the Discord win-post: it stays silent when unconfigured or below threshold, and builds a
// correct embed (with the on-chain proof link) when it should fire. Stubs global.fetch so nothing
// leaves the machine. Sets the webhook env BEFORE requiring settle.js so the module picks it up.
process.env.DISCORD_WINS_WEBHOOK = 'https://discord.test/webhook/AAA';

const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  // Price sources → return a fixed SOL price so USD renders; webhook → capture the body.
  const u = String(url);
  if (u.includes('coinbase'))  return { ok: true, json: async () => ({ data: { amount: '150.00' } }) };
  if (u.includes('coingecko')) return { ok: true, json: async () => ({ solana: { usd: 150.0 } }) };
  if (u.includes('binance'))   return { ok: true, json: async () => ({ price: '150.00' }) };
  calls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({}) };
};

const settle = require('../api/settle.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL ' + m); } };

(async () => {
  // 1. Above threshold with a name → one webhook call, correct content
  calls.length = 0;
  await settle.postWinToDiscord(20_000_000, 'EMINEM', 'SIG123'); // 0.02 SOL → $3.00
  ok(calls.length === 1, 'fires one webhook when above threshold');
  const e = calls[0] && calls[0].body.embeds[0];
  ok(!!e, 'embed present');
  ok(e && e.title.includes('EMINEM'), 'title names the winner');
  ok(e && e.description.includes('$3.00'), 'shows USD from price');
  ok(e && e.description.includes('0.020 SOL'), 'shows SOL amount');
  ok(e && e.description.includes('explorer.solana.com/tx/SIG123'), 'includes on-chain proof link');
  ok(e && e.description.includes('snakepot.com/play'), 'includes play link');

  // 2. Below the $1.50 USD gate → silent (price stub is $150/SOL)
  calls.length = 0;
  await settle.postWinToDiscord(1_000_000, 'SMALL', 'SIGX'); // 0.001 SOL = $0.15
  ok(calls.length === 0, 'silent below $1.50');

  // 2b. Just under $1.50 → silent; exactly $1.50 → posts (boundary at $150/SOL)
  calls.length = 0;
  await settle.postWinToDiscord(9_000_000, 'A', 'S'); // 0.009 SOL = $1.35
  ok(calls.length === 0, '$1.35 stays silent');
  calls.length = 0;
  await settle.postWinToDiscord(10_000_000, 'B', 'S'); // 0.010 SOL = $1.50
  ok(calls.length === 1, '$1.50 posts');

  // 3. No name → falls back to "A player"
  calls.length = 0;
  await settle.postWinToDiscord(20_000_000, '', 'SIGY');
  ok(calls[0] && calls[0].body.embeds[0].title.includes('A player'), 'falls back to generic name');

  // 4. Unconfigured webhook → silent even above threshold
  delete process.env.DISCORD_WINS_WEBHOOK;
  delete require.cache[require.resolve('../api/settle.js')];
  const settle2 = require('../api/settle.js');
  calls.length = 0;
  await settle2.postWinToDiscord(20_000_000, 'NAME', 'SIGZ');
  ok(calls.length === 0, 'silent when DISCORD_WINS_WEBHOOK unset');

  global.fetch = realFetch;
  console.log((fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
