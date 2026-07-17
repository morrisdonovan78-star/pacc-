'use strict';
const fs   = require('fs');
const path = require('path');

let _cached        = null;
let _adminCached   = null;
let _bgCached      = null;
let _slitherCached = null;

// OG preview image — served at /og so it stays within the 12-function Hobby limit
const OG_SVG = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="gg" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="cg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="eg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <radialGradient id="bg" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="#0e0e1c"/><stop offset="100%" stop-color="#07070f"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g opacity="0.1" fill="#FFD700">${Array.from({length:132},(_,i)=>`<circle cx="${(i%12)*100+50}" cy="${Math.floor(i/12)*55+27}" r="3"/>`).join('')}</g>
  <rect x="6" y="6" width="1188" height="618" fill="none" stroke="#FFD700" stroke-width="2.5" rx="18" opacity="0.45" filter="url(#gg)"/>
  <path d="M 230,315 L 361,233 A 155,155 0 1,0 361,397 Z" fill="#FFD700" filter="url(#gg)"/>
  <circle cx="262" cy="222" r="14" fill="#07070f"/>
  <circle cx="420" cy="315" r="9" fill="#FFD700" opacity="0.95" filter="url(#gg)"/>
  <circle cx="478" cy="315" r="9" fill="#FFD700" opacity="0.7"/>
  <circle cx="532" cy="315" r="9" fill="#FFD700" opacity="0.5"/>
  <circle cx="582" cy="315" r="9" fill="#FFD700" opacity="0.3"/>
  <g transform="translate(645,248)" opacity="0.7"><path d="M 0,132 Q 10,117 20,132 Q 30,117 40,132 Q 50,117 60,132 L 60,0 Q 30,-26 0,0 Z" fill="#FF69B4"/><circle cx="20" cy="40" r="12" fill="white"/><circle cx="22" cy="42" r="6" fill="#07070f"/><circle cx="40" cy="40" r="12" fill="white"/><circle cx="42" cy="42" r="6" fill="#07070f"/></g>
  <text x="745" y="175" font-family="'Courier New',Courier,monospace" font-size="90" font-weight="bold" fill="#FFD700" text-anchor="middle" letter-spacing="6" filter="url(#gg)">PAC ARENA</text>
  <text x="745" y="248" font-family="'Courier New',Courier,monospace" font-size="26" fill="#00FFFF" text-anchor="middle" letter-spacing="5" filter="url(#cg)">PVP PAC-MAN ON SOLANA</text>
  <line x1="520" y1="278" x2="970" y2="278" stroke="rgba(255,215,0,0.25)" stroke-width="1"/>
  <text x="745" y="336" font-family="'Courier New',Courier,monospace" font-size="22" fill="#e0e0ff" text-anchor="middle" opacity="0.85">Wager real SOL &#183; Winner takes 90% of the pot</text>
  <text x="745" y="402" font-family="'Courier New',Courier,monospace" font-size="30" font-weight="bold" fill="#39FF14" text-anchor="middle" filter="url(#eg)">FREE &#183; $1 &#183; $5 LOBBIES</text>
  <text x="745" y="462" font-family="'Courier New',Courier,monospace" font-size="20" fill="rgba(200,200,255,0.55)" text-anchor="middle">No download &#183; Plays in any browser &#183; Instant wallet</text>
  <rect x="585" y="510" width="320" height="52" rx="26" fill="rgba(255,215,0,0.08)" stroke="rgba(255,215,0,0.35)" stroke-width="1.5"/>
  <text x="745" y="544" font-family="'Courier New',Courier,monospace" font-size="19" fill="#FFD700" text-anchor="middle" opacity="0.9">pac-arena.vercel.app</text>
</svg>`;

module.exports = function handler(req, res) {
  const reqPath = (req.url || '/').split('?')[0];

  // ── Version endpoint (absorbed from api/version.js to stay within 12-fn limit)
  if (reqPath === '/api/version') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ v: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || 'dev' });
  }

  // ── Domain routing: snakepot.com is the snake game's own domain ──────────────
  // Same Vercel project serves both games; on snakepot.com the ROOT is the snake
  // game (slither-snakes.html), not the PAC ARENA index.
  const host = String(req.headers.host || '').toLowerCase();
  const isSnakepot = host === 'snakepot.com' || host.endsWith('.snakepot.com');

  // ── Slither Snakes game ───────────────────────────────────────────────────────
  if (reqPath === '/slither-snakes' || reqPath === '/slither-snakes.html' || reqPath === '/slither-snakes/') {
    try {
      if (!_slitherCached) _slitherCached = fs.readFileSync(path.resolve('slither-snakes.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).send(_slitherCached);
    } catch (e) { return res.status(500).send('Slither Snakes not found: ' + e.message); }
  }

  // ── Admin panel ───────────────────────────────────────────────────────────────
  if (reqPath === '/admin' || reqPath === '/admin/') {
    try {
      if (!_adminCached) _adminCached = fs.readFileSync(path.resolve('admin.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('X-Robots-Tag', 'noindex,nofollow');
      return res.status(200).send(_adminCached);
    } catch (e) { return res.status(500).send('Admin panel not found: ' + e.message); }
  }

  // ── Arena background image ────────────────────────────────────────────────────
  if (reqPath === '/arena-bg.png') {
    try {
      if (!_bgCached) _bgCached = fs.readFileSync(path.resolve('arena-bg.png'));
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=604800, immutable');
      return res.status(200).send(_bgCached);
    } catch (e) { return res.status(404).send('Not found'); }
  }

  // ── OG preview image ─────────────────────────────────────────────────────────
  if (reqPath === '/og' || reqPath === '/og-image') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.status(200).send(OG_SVG);
  }

  // ── Cache-bust redirect ──────────────────────────────────────────────────────
  // The problem: browsers may have the old HTML cached from before we started
  // serving via this function.  A cached response is served without hitting the
  // server at all, so no amount of server-side headers can evict it.
  //
  // Solution: every unversioned URL (/, /pac-arena.html, etc.) is redirected to
  // /?_v=<current-deployment-id>.  Browsers have never cached that URL, so they
  // MUST make a fresh request and get the latest HTML.  On the next deploy the
  // deployment ID changes → new URL → cache busted again automatically.
  // The redirect itself has no-store so it can never be cached.
  // On snakepot.com every remaining path (including "/") IS the snake game —
  // same headers as the /slither-snakes route above, no cache-bust redirect
  // needed (the snake page has always been served no-store with no _v scheme).
  if (isSnakepot) {
    try {
      if (!_slitherCached) _slitherCached = fs.readFileSync(path.resolve('slither-snakes.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).send(_slitherCached);
    } catch (e) { return res.status(500).send('Slither Snakes not found: ' + e.message); }
  }

  const deployId = process.env.VERCEL_DEPLOYMENT_ID
                || process.env.VERCEL_GIT_COMMIT_SHA
                || 'dev';
  const url = req.url || '/';

  if (!url.includes('_v=')) {
    res.setHeader('Cache-Control',          'no-store');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    res.setHeader('CDN-Cache-Control',      'no-store');
    return res.redirect(302, '/?_v=' + encodeURIComponent(deployId));
  }

  // ── Serve HTML ───────────────────────────────────────────────────────────────
  try {
    if (!_cached) {
      _cached = fs.readFileSync(path.resolve('index.html'), 'utf8');
    }
    res.setHeader('Content-Type',           'text/html; charset=utf-8');
    res.setHeader('Cache-Control',          'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    res.setHeader('CDN-Cache-Control',      'no-store');
    res.setHeader('Pragma',                 'no-cache');
    res.setHeader('Expires',               '0');
    res.status(200).send(_cached);
  } catch (e) {
    res.status(500).send('Error loading app: ' + e.message);
  }
};
