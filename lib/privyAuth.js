'use strict';
// lib/privyAuth.js — verify a Privy access-token JWT (ES256) against the app's public JWKS.
// Returns the token's claims ({ sub, ... }) only if the SIGNATURE is genuine, the alg is ES256
// (rejects alg:none / algorithm-confusion), and it isn't expired. Returns null otherwise.
// Used by the money endpoints so a forged token can't repoint a player's wallet or read their keys.
const crypto = require('crypto');

const PRIVY_APP_ID = 'cmq1eo6uz004b0cl8pvk7aakk';
const JWKS_URL = 'https://auth.privy.io/api/v1/apps/' + PRIVY_APP_ID + '/jwks.json';

let _jwks = null, _jwksAt = 0;
async function _getKeys() {
  if (_jwks && Date.now() - _jwksAt < 3600000) return _jwks;   // cache 1h (Privy rotates slowly)
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('jwks fetch ' + r.status);
  const d = await r.json();
  const keys = (d && d.keys) || [];
  if (!keys.length) throw new Error('jwks empty');
  _jwks = keys; _jwksAt = Date.now();
  return _jwks;
}

function _dec(seg) {
  const s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - s.length % 4) % 4), 'base64');
}

// Verify + decode. FAIL-CLOSED: any parse/fetch/signature error returns null (request is rejected).
async function verifyPrivyJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const header = JSON.parse(_dec(h).toString('utf8'));
    if (header.alg !== 'ES256') return null;                    // reject alg:none and non-ES256
    const keys = await _getKeys();
    const jwk = keys.find(k => k.kid === header.kid) || keys.find(k => k.alg === 'ES256' && k.kty === 'EC');
    if (!jwk) return null;
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(h + '.' + p),
      { key: pub, dsaEncoding: 'ieee-p1363' }, _dec(s));         // JWT sig is raw r||s, not DER
    if (!ok) return null;
    const claims = JSON.parse(_dec(p).toString('utf8'));
    if (!claims || !claims.sub) return null;
    if (claims.exp && Math.floor(Date.now() / 1000) > claims.exp) return null;
    return claims;
  } catch (_) { return null; }
}

module.exports = { verifyPrivyJwt };
