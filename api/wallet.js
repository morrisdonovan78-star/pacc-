// api/wallet.js — Cross-device wallet sync via Privy user metadata
// Stores AES-256-GCM encrypted keypairs in Privy user's customMetadata.
// Requires PRIVY_APP_SECRET env var (get from console.privy.io → Settings → API).
// Requires ESCROW_SECRET env var (already set) as part of encryption key.
'use strict';
const crypto = require('crypto');

const PRIVY_APP_ID = 'cmq1eo6uz004b0cl8pvk7aakk';

// ── JWT helpers (no signature verify — already authenticated by Privy OTP flow) ─
function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    // base64url → base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

// ── Encryption: AES-256-GCM, key = SHA-256(escrow_bytes + email) ────────────────
function deriveKey(email) {
  const raw = (process.env.ESCROW_SECRET || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('ESCROW_SECRET not set');
  const arr = JSON.parse(raw);
  return crypto.createHash('sha256')
    .update(Buffer.from(arr.slice(0, 32)))
    .update(email.toLowerCase().trim())
    .digest(); // 32-byte key
}

function encryptWallet(secretKeyB64, email) {
  const key = deriveKey(email);
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(secretKeyB64, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: 12-byte IV + 16-byte tag + ciphertext, all base64
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptWallet(encrypted, email) {
  const key = deriveKey(email);
  const buf = Buffer.from(encrypted, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Privy Management API call ────────────────────────────────────────────────────
async function privyMgmt(method, path, body) {
  const secret = process.env.PRIVY_APP_SECRET;
  if (!secret) throw new Error('PRIVY_APP_SECRET not configured — add it to Vercel env vars');
  const auth = Buffer.from(PRIVY_APP_ID + ':' + secret).toString('base64');
  const r = await fetch('https://auth.privy.io/api/v1' + path, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Basic ' + auth,
      'privy-app-id':  PRIVY_APP_ID,
      'origin':        'https://pac-arena.vercel.app',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Privy API ' + r.status + ': ' + text.slice(0, 200));
  return JSON.parse(text);
}

// ── Main handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).end(); return; }

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'Bad JSON' }); }
  body = body || {};

  const { action, email, jwt, secretKeyB64 } = body;
  if (!email || !jwt) return res.status(400).json({ error: 'email and jwt required' });

  // Decode JWT — get user DID and check expiry
  const claims = parseJwt(jwt);
  if (!claims) return res.status(401).json({ error: 'Invalid JWT' });
  if (claims.exp && Math.floor(Date.now() / 1000) > claims.exp) {
    return res.status(401).json({ error: 'Session expired — log in again to sync wallet' });
  }
  const userId = claims.sub;
  if (!userId) return res.status(401).json({ error: 'No user ID in JWT' });

  try {
    // ── save: encrypt keypair and store in Privy user metadata ──────────────────
    if (action === 'save') {
      if (!secretKeyB64) return res.status(400).json({ error: 'secretKeyB64 required' });
      const encrypted = encryptWallet(secretKeyB64, email);
      // Try PATCH first, fall back to PUT (Privy API version differences)
      try {
        await privyMgmt('PATCH', '/users/' + userId, { customMetadata: { paWallet: encrypted } });
      } catch (e1) {
        if (e1.message.includes('405') || e1.message.includes('404')) {
          await privyMgmt('PUT', '/users/' + userId, { customMetadata: { paWallet: encrypted } });
        } else throw e1;
      }
      console.log('[wallet] saved for', userId);
      return res.status(200).json({ ok: true });
    }

    // ── load: retrieve from Privy metadata and decrypt ──────────────────────────
    if (action === 'load') {
      const user = await privyMgmt('GET', '/users/' + userId);
      const meta = user.customMetadata || user.custom_metadata || {};
      const encrypted = meta.paWallet;
      if (!encrypted) return res.status(404).json({ error: 'No wallet on server for this account' });
      const sk = decryptWallet(encrypted, email);
      console.log('[wallet] loaded for', userId);
      return res.status(200).json({ secretKeyB64: sk });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[wallet]', e.message);
    // Don't return the full error if it contains the secret
    const msg = e.message.includes('not configured') ? e.message : 'Wallet sync error — ' + e.message.slice(0, 100);
    return res.status(500).json({ error: msg });
  }
};
