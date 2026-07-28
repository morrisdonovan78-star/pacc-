'use strict';
// api/admin.js — All mod panel endpoints in one function (Hobby plan: 12 function limit)
// Routes via ?do= query param:
//   POST ?do=auth            → password login → signed session token
//   GET  ?do=checkban        → ban status check (called by game server)
//   POST (no do / action=…)  → authenticated mod actions
//
// Required env vars (set in Vercel dashboard → Settings → Environment Variables):
//   ADMIN_PASSWORD — the password mods type to log in
//   ADMIN_SECRET   — secret used to sign tokens AND authenticate game-server calls
//                    (set the SAME value in PM2 env on Vultr: ADMIN_SECRET=...)
const crypto = require('crypto');
const { kvGet, kvSet, kvSetPerm, kvDel, kvHgetall, kvHset,
        kvZadd, kvZrevrange, kvZrem, kvScan,
        kvLpush, kvLtrim, kvLrange } = require('../lib/kv');

// ── Shared helpers ────────────────────────────────────────────────────────────
function getSecret()   { return (process.env.ADMIN_SECRET   || '').trim(); }
function getPassword() { return (process.env.ADMIN_PASSWORD || '').trim(); }

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');
}

// ── Token ─────────────────────────────────────────────────────────────────────
const TOKEN_TTL_S = 8 * 3600;

function makeToken() {
  const secret  = getSecret();
  const payload = { sub: 'mod', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return encoded + '.' + sig;
}

function verifyToken(token) {
  const secret = getSecret();
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  try {
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
    const sBuf = Buffer.from(sig.padEnd(64, '0'), 'hex');
    const eBuf = Buffer.from(expected, 'hex');
    if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) return null;
    const p = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (p.sub !== 'mod' || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch (_) { return null; }
}

// ── Ban helpers ───────────────────────────────────────────────────────────────
const DURATIONS = { '1h': 3600, '3h': 10800, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000, 'perm': 0 };

function parseBanRecord(raw) {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b.type === 'temp' && b.until > 0 && Date.now() > b.until) return null;
    return b;
  } catch (_) { return null; }
}

async function writeBan(listKey, recordKey, address, durationKey, reason) {
  const ttlSec = DURATIONS[durationKey] ?? 3600;
  const until  = durationKey === 'perm' ? 0 : Date.now() + ttlSec * 1000;
  const rec    = JSON.stringify({ type: durationKey === 'perm' ? 'perm' : 'temp', until, reason: reason || '', at: Date.now() });
  if (durationKey === 'perm') { await kvSetPerm(recordKey, rec); }
  else                        { await kvSet(recordKey, rec, ttlSec); }
  await kvZadd(listKey, Date.now(), address);
}

async function removeBan(listKey, recordKey, address) {
  await kvDel(recordKey);
  await kvZrem(listKey, address);
}

// ── Mod log ───────────────────────────────────────────────────────────────────
async function logAction(action, target, detail) {
  try {
    const entry = JSON.stringify({ ts: Date.now(), action, target: target || '', detail: detail || '' });
    await kvLpush('admin:log', entry);
    await kvLtrim('admin:log', 0, 199);
  } catch (_) {}
}

// ── Game server calls ─────────────────────────────────────────────────────────
const SERVERS = [
  { url: process.env.GAME_SERVER_URL    || 'http://149.28.119.247:3001', label: '🇺🇸 CHICAGO (NA)', key: 'NA' },
  { url: process.env.GAME_SERVER_EU_URL || 'http://136.244.81.138:3001', label: '🇩🇪 FRANKFURT (EU)', key: 'EU' },
].filter(s => s.url);

async function callAllServers(path, method, body, serverKey) {
  const secret = getSecret();
  const targets = serverKey ? SERVERS.filter(s => s.key === serverKey) : SERVERS;
  return Promise.all(targets.map(async srv => {
    try {
      const r = await fetch(srv.url + '/admin/' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return { server: srv.label, key: srv.key, error: 'HTTP ' + r.status };
      return { server: srv.label, key: srv.key, ...(await r.json()) };
    } catch (e) { return { server: srv.label, key: srv.key, error: e.message, offline: true }; }
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex,nofollow');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const doParam = (req.query && req.query.do) || '';

  // ── POST ?do=auth — password login ─────────────────────────────────────────
  if (doParam === 'auth') {
    if (req.method !== 'POST') return res.status(405).end();
    const password = getPassword();
    const secret   = getSecret();
    if (!password || !secret) return res.status(503).json({ error: 'Admin not configured — set ADMIN_PASSWORD and ADMIN_SECRET env vars' });

    const ip      = clientIp(req);
    const lockKey = 'admin:fail:' + ip;
    const attempts = parseInt(await kvGet(lockKey)) || 0;
    if (attempts >= 5) return res.status(429).json({ error: 'Too many failed attempts. Wait 15 minutes.' });

    const { password: submitted } = req.body || {};
    if (!submitted) return res.status(400).json({ error: 'Password required' });

    let match = false;
    try {
      const a = Buffer.from(String(submitted).trim().padEnd(128));
      const b = Buffer.from(password.padEnd(128));
      match = crypto.timingSafeEqual(a, b) && String(submitted).trim() === password;
    } catch (_) {}

    if (!match) {
      const next = attempts + 1;
      await kvSet(lockKey, String(next), 900);
      const left = 5 - next;
      console.warn('[admin/auth] Bad password from', ip, '— attempt', next);
      if (left <= 0) return res.status(429).json({ error: 'Locked out for 15 minutes.' });
      return res.status(401).json({ error: `Wrong password. ${left} attempt${left===1?'':'s'} remaining.` });
    }

    await kvDel(lockKey).catch(() => {});
    console.log('[admin/auth] Login from', ip);
    return res.status(200).json({ token: makeToken(), ttl: TOKEN_TTL_S });
  }

  // ── GET ?do=checkban — lightweight ban check for game server ───────────────
  if (doParam === 'checkban') {
    if (req.method !== 'GET') return res.status(405).end();
    const reqSecret = (req.headers['x-admin-secret'] || req.query.secret || '').trim();
    const secret    = getSecret();
    if (!secret || reqSecret !== secret) return res.status(403).json({ error: 'Forbidden' });
    const address = (req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: 'address required' });
    const raw = await kvGet('ban:' + address);
    const ban = parseBanRecord(raw);
    return res.json({ banned: !!ban, ban: ban || undefined });
  }

  // ── POST (action in body) — authenticated mod actions ──────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers['x-admin-token'] || '').trim();
  if (!verifyToken(token)) return res.status(403).json({ error: 'Invalid or expired session. Log in again.' });

  const { action, address, reason, duration, message, lobbyId, socketId } = req.body || {};

  if (action === 'status') {
    return res.json({ servers: await callAllServers('status', 'GET') });
  }

  /*
   * ── wallet-find: which EMAIL owns an old pre-platform wallet ─────────────────────────────────
   *
   * Players carry wallets from before the platform, and the ONLY way back into one is to log into the
   * standalone game with the email that created it. Forget that email and the SOL is stranded behind
   * a guessing game across every address the person ever had.
   *
   * It lives here, behind the panel's own login, because the alternative was handing the operator an
   * ADMIN_SECRET they cannot read: Vercel marks it Sensitive, which is write-only by design. Asking
   * someone to rotate a production secret just to answer a question is the wrong trade.
   *
   * The implementation is imported, not copied - it decrypts key material, so there is exactly one
   * copy to audit. It returns { email, address } only; the secret key derives a public key and is
   * then dropped, never returned and never logged.
   */
  if (action === 'wallet-find') {
    try {
      const { walletFind } = require('./wallet.js');
      const wallets = await walletFind(address);   // blank address = list them all
      return res.json({ ok: true, count: wallets.length, wallets });
    } catch (e) {
      return res.status(500).json({ error: (e && e.message) || 'lookup failed' });
    }
  }

  // ── Referral codes (invite-only) ────────────────────────────────────────────
  // Owner-minted only: a code exists in KV only because the owner created it here, so nobody but
  // the people the owner hands a code to can ever earn a referral reward. See accrueReferral in
  // api/join.js (accrues) and the ref-claim action in api/settle.js (pays out, solvency-gated).
  if (action === 'ref-mint') {
    const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    const referrer = String(req.body.referrer || '').trim();
    if (!code || code.length < 3) return res.status(400).json({ error: 'code must be 3–24 letters/digits' });
    if (!referrer) return res.status(400).json({ error: 'referrer wallet required' });
    const existing = await kvGet('refcode:' + code);
    if (existing && existing !== referrer) return res.status(409).json({ error: 'code already assigned to ' + existing });
    await kvSetPerm('refcode:' + code, referrer);
    await logAction('ref-mint', referrer, code);
    return res.json({ ok: true, code, referrer, link: 'https://snakepot.com/play?ref=' + code });
  }

  if (action === 'ref-list') {
    // Enumerate every minted code with its referrer + live stats, for the owner's dashboard.
    const keys = await kvScan('refcode:*');
    const out = [];
    for (const k of keys) {
      const codeName = k.slice('refcode:'.length);
      const referrer = await kvGet(k);
      const stats = (await kvHgetall('refstats:' + referrer)) || {};
      const owed = Number(await kvGet('refbal:' + referrer)) || 0;
      out.push({ code: codeName, referrer, players: Number(stats.players) || 0,
                 joins: Number(stats.joins) || 0, accrued: Number(stats.accrued) || 0, owedLamports: owed });
    }
    return res.json({ ok: true, codes: out });
  }

  if (action === 'ref-void') {
    const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    if (!code) return res.status(400).json({ error: 'code required' });
    await kvDel('refcode:' + code);
    await logAction('ref-void', '', code);
    return res.json({ ok: true, voided: code });
  }

  if (action === 'kick') {
    if (!address && !socketId) return res.status(400).json({ error: 'address required' });
    const results = await callAllServers('kick', 'POST', { walletAddress: address, socketId, reason });
    await logAction('kick', address || socketId, reason);
    return res.json({ ok: true, results });
  }

  if (action === 'warn') {
    if ((!address && !socketId) || !message) return res.status(400).json({ error: 'address and message required' });
    const results = await callAllServers('warn', 'POST', { walletAddress: address, socketId, message });
    await logAction('warn', address || socketId, message);
    return res.json({ ok: true, results });
  }

  if (action === 'endgame') {
    if (!lobbyId) return res.status(400).json({ error: 'lobbyId required' });
    const results = await callAllServers('endgame', 'POST', { lobbyId, reason }, req.body.serverKey || null);
    await logAction('endgame', lobbyId, reason);
    return res.json({ ok: true, results });
  }

  if (action === 'broadcast') {
    if (!message) return res.status(400).json({ error: 'message required' });
    const results = await callAllServers('broadcast', 'POST', { message, lobbyId: lobbyId || null });
    await logAction('broadcast', lobbyId || 'ALL', message);
    return res.json({ ok: true, results });
  }

  if (action === 'ban') {
    if (!address || !duration) return res.status(400).json({ error: 'address and duration required' });
    await writeBan('admin:banlist', 'ban:' + address, address, duration, reason);
    await callAllServers('kick', 'POST', { walletAddress: address, reason: 'Banned: ' + (reason || 'rule violation') });
    await logAction('ban:' + duration, address, reason);
    return res.json({ ok: true });
  }

  if (action === 'unban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    await removeBan('admin:banlist', 'ban:' + address, address);
    await logAction('unban', address, reason);
    return res.json({ ok: true });
  }

  if (action === 'voiceban') {
    if (!address || !duration) return res.status(400).json({ error: 'address and duration required' });
    await writeBan('admin:vbanlist', 'voiceban:' + address, address, duration, reason);
    await logAction('voiceban:' + duration, address, reason);
    return res.json({ ok: true });
  }

  if (action === 'unvoiceban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    await removeBan('admin:vbanlist', 'voiceban:' + address, address);
    await logAction('unvoiceban', address, reason);
    return res.json({ ok: true });
  }

  if (action === 'checkban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    const [gameBanRaw, voiceBanRaw, playerHash] = await Promise.all([
      kvGet('ban:'      + address),
      kvGet('voiceban:' + address),
      kvHgetall('ph:'   + address),
    ]);
    return res.json({ gameBan: parseBanRecord(gameBanRaw), voiceBan: parseBanRecord(voiceBanRaw), player: playerHash });
  }

  if (action === 'getplayer') {
    if (!address) return res.status(400).json({ error: 'address required' });
    const [h, gameBanRaw, voiceBanRaw] = await Promise.all([
      kvHgetall('ph:' + address),
      kvGet('ban:'      + address),
      kvGet('voiceban:' + address),
    ]);
    return res.json({ player: h, gameBan: parseBanRecord(gameBanRaw), voiceBan: parseBanRecord(voiceBanRaw) });
  }

  if (action === 'getbans' || action === 'getvoicebans') {
    const listKey = action === 'getbans' ? 'admin:banlist' : 'admin:vbanlist';
    const recPfx  = action === 'getbans' ? 'ban:'          : 'voiceban:';
    try {
      const raw = await kvZrevrange(listKey, 0, 99);
      if (!Array.isArray(raw) || !raw.length) return res.json({ bans: [] });
      const addrs   = [];
      for (let i = 0; i < raw.length; i += 2) addrs.push(raw[i]);
      const records = await Promise.all(addrs.map(a => kvGet(recPfx + a)));
      const bans = addrs.map((a, i) => {
        const rec = parseBanRecord(records[i]);
        return rec ? { address: a, ...rec } : null;
      }).filter(Boolean);
      return res.json({ bans });
    } catch (e) { return res.json({ bans: [], error: e.message }); }
  }

  if (action === 'getlogs') {
    try {
      const raw  = await kvLrange('admin:log', 0, 99);
      const logs = (raw || []).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      return res.json({ logs });
    } catch (e) { return res.json({ logs: [], error: e.message }); }
  }

  if (action === 'resetLbStats') {
    // Zero out gameplay stats for all players — preserves earned/wagered/name
    const raw = await kvZrevrange('lb:earned', 0, -1);
    const addrs = [];
    for (let i = 0; i < (raw || []).length; i += 2) addrs.push(raw[i]);
    const STAT_FIELDS = ['kills', 'deaths', 'wins', 'losses', 'games'];
    await Promise.all(addrs.flatMap(addr =>
      STAT_FIELDS.map(f => kvHset('ph:' + addr, f, '0').catch(() => {}))
    ));
    await kvHset('ph:global', 'gamesPlayed', '0').catch(() => {});
    await logAction('resetLbStats', 'ALL', 'Zeroed kills/deaths/wins/losses/games for ' + addrs.length + ' players');
    return res.json({ ok: true, playersReset: addrs.length });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
