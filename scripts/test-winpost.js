'use strict';
// Verifies the Discord win-post: it stays silent when unconfigured or below threshold, and builds a
// correct embed (with the on-chain proof link) when it should fire. Stubs global.fetch so nothing
// leaves the machine. Sets the webhook env BEFORE requiring settle.js so the module picks it up.
process.env.DISCORD_WINS_WEBHOOK = 'https://discord.test/webhook/AAA';

const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  // Price source → return a fixed SOL price; webhook → capture the body.
  if (String(url).includes('binance')) return { ok: true, json: async () => ({ price: '150.00' }) };
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

  // 2. Below threshold → silent (no dust spam)
  calls.length = 0;
  await settle.postWinToDiscord(1_000_000, 'SMALL', 'SIGX'); // 0.001 SOL
  ok(calls.length === 0, 'silent below threshold');

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
