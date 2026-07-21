'use strict';
// fetch-discord-clips.js — download every clip your game has posted to the Discord #clips channel.
//
// WHY A BOT TOKEN: the in-game clip button posts via a one-way webhook. Webhooks can only SEND —
// they cannot read a channel's history. Pulling the clips back out needs a bot with "Read Message
// History" on that channel. That token is a secret: this script reads it from a LOCAL FILE or env
// var so it never has to be pasted anywhere.
//
// SETUP (one time):
//   1. https://discord.com/developers/applications → New Application → Bot → Reset Token → copy it.
//      Under "Privileged Gateway Intents", enable "Message Content Intent".
//   2. Invite the bot to your server with the "Read Messages/View Channels" + "Read Message History"
//      permissions (OAuth2 → URL Generator → scopes: bot → those two perms → open the URL).
//   3. Save the token to a file next to this script named  discord_token.txt   (one line, nothing
//      else), OR set the env var DISCORD_BOT_TOKEN. The .gitignore keeps the file out of git.
//   4. Run:  node scripts/fetch-discord-clips.js
//
// The channel id is discovered automatically from the webhook already wired into the game, so you
// don't have to find it. Downloads land in  ./discord_clips/  , newest first, skipping any already
// pulled so you can re-run it to grab only what's new.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'discord_clips');
const TOKEN_FILE = path.join(__dirname, 'discord_token.txt');
// The webhook the game posts clips through — used ONLY to look up which channel that is. Public
// already (it ships in the client), and this reveals metadata (channel id), never message content.
const CLIP_WEBHOOK = 'https://discord.com/api/webhooks/1523452307268833333/zEoRKlhURKzFv-Q7pdDEVOGEPltlfSQjP8wA0s1W2C9FwCgZfze2Yv6rLFpXCZ06IYlU';

const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getToken() {
  const env = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  return '';
}

// Discord REST with automatic 429 back-off.
async function dapi(url, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Authorization: 'Bot ' + token, 'User-Agent': 'SnakePotClipFetch/1.0' } });
    if (r.status === 429) {
      const body = await r.json().catch(() => ({}));
      const wait = Math.ceil((body.retry_after || 1) * 1000) + 250;
      console.log('  rate-limited, waiting ' + wait + 'ms…');
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error('Discord API ' + r.status + ' ' + r.statusText + ' for ' + url + ' — ' + (await r.text().catch(() => '')).slice(0, 200));
    return r.json();
  }
  throw new Error('gave up after repeated rate limits');
}

async function discoverChannelId() {
  // GET on the webhook returns { channel_id, guild_id, ... } with no auth needed.
  const r = await fetch(CLIP_WEBHOOK);
  if (!r.ok) throw new Error('could not read the clip webhook (HTTP ' + r.status + ') — was it deleted/regenerated in Discord?');
  const d = await r.json();
  if (!d.channel_id) throw new Error('webhook did not return a channel_id');
  return d.channel_id;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  const token = getToken();
  if (!token) {
    console.error('\nNo bot token found.\n' +
      '  → put it in ' + TOKEN_FILE + ' (one line), or set DISCORD_BOT_TOKEN.\n' +
      '  See the setup steps at the top of this file.\n');
    process.exit(1);
  }

  console.log('Discovering the clips channel from the game webhook…');
  const channelId = await discoverChannelId();
  console.log('  channel id: ' + channelId);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const already = new Set(fs.readdirSync(OUT_DIR));

  console.log('Paging through the channel history…');
  let before = null, scanned = 0, saved = 0, savedBytes = 0, skipped = 0, pages = 0;
  const manifest = [];

  while (true) {
    const url = 'https://discord.com/api/v10/channels/' + channelId + '/messages?limit=100' + (before ? '&before=' + before : '');
    const msgs = await dapi(url, token);
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    pages++;

    for (const m of msgs) {
      scanned++;
      for (const att of (m.attachments || [])) {
        if (!att.url || !VIDEO_RE.test(att.filename || att.url.split('?')[0])) continue;
        // Stable, collision-proof name: message id + original filename.
        const base = (att.filename || 'clip.mp4').replace(/[^\w.\-]+/g, '_');
        const name = m.id + '__' + base;
        manifest.push({ name, ts: m.timestamp, author: (m.author && m.author.username) || 'unknown', size: att.size, url: att.url });
        if (already.has(name)) { skipped++; continue; }
        try {
          const bytes = await download(att.url, path.join(OUT_DIR, name));
          saved++; savedBytes += bytes;
          console.log('  ↓ ' + name + '  (' + (bytes / 1048576).toFixed(1) + ' MB, by ' + ((m.author && m.author.username) || '?') + ')');
        } catch (e) {
          console.warn('  ✗ ' + name + ' — ' + e.message + ' (Discord attachment links expire; re-run to refresh)');
        }
        await sleep(120); // gentle
      }
    }
    before = msgs[msgs.length - 1].id;
    if (pages % 5 === 0) console.log('  …scanned ' + scanned + ' messages so far');
  }

  // Write a manifest so we know who/when each clip is from (handy for crediting POVs in a montage).
  fs.writeFileSync(path.join(OUT_DIR, '_manifest.json'), JSON.stringify(manifest.sort((a, b) => (a.ts < b.ts ? 1 : -1)), null, 2));

  console.log('\nDone.');
  console.log('  scanned messages : ' + scanned);
  console.log('  clips found      : ' + manifest.length);
  console.log('  newly downloaded : ' + saved + '  (' + (savedBytes / 1048576).toFixed(1) + ' MB)');
  console.log('  already had      : ' + skipped);
  console.log('  saved to         : ' + OUT_DIR);
  console.log('\nNext: tell me to build the promo montage from ./discord_clips and I\'ll cut it with ffmpeg.');
})().catch(e => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1); });
