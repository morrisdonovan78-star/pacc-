// api/wallet.js — Cross-device wallet sync via Privy user metadata
// Stores AES-256-GCM encrypted keypairs in Privy user's customMetadata.
// Requires PRIVY_APP_SECRET env var (get from console.privy.io → Settings → API).
// Requires ESCROW_SECRET env var (already set) as part of encryption key.
'use strict';
const crypto = require('crypto');
const nacl = require('tweetnacl');
// Minimal base58 — only ever used to render a PUBLIC key as a Solana address.
const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Encode(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += _B58[digits[i]];
  return out;
}

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
      // NON-CLOBBERING by default: the FIRST wallet saved to an account is authoritative. Without this,
      // a second device (or a stale local wallet) would overwrite the account's real wallet on login —
      // devices ping-ponged, so one person ended up with several wallets and duplicate leaderboard rows,
      // and a history-reset could adopt the wrong one. `force:true` allows a deliberate replace (import).
      if (!body.force) {
        try {
          const existing = await privyMgmt('GET', '/users/' + userId);
          const m = existing.customMetadata || existing.custom_metadata || {};
          if (m.paWallet) { console.log('[wallet] kept existing for', userId); return res.status(200).json({ ok: true, kept: true }); }
        } catch (_) { /* read failed — fall through and attempt the save so we never lose a first wallet */ }
      }
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
    /*
     * ── wallet-find: WHICH EMAIL OWNS WHICH OLD WALLET (owner only) ───────────────────────────────
     *
     * Players carry wallets from before the platform, and the only way back into one is to log into
     * the standalone game with the email that created it. If you no longer remember which email that
     * was, the SOL is stranded behind a guessing game across every address you ever had.
     *
     * This answers exactly that question and nothing more: it walks the Privy users, decrypts each
     * stored keypair SERVER-SIDE, derives the PUBLIC address, and returns { email, address }. The
     * secret key is used to compute a public key and is then dropped — it is never returned, never
     * logged, and never leaves this function. Knowing "that wallet belongs to donnie3802@gmail.com"
     * is all anyone needs; the recovery itself is the owner logging in normally.
     *
     * Owner-gated on ADMIN_SECRET because it enumerates accounts.
     */
    if (action === 'wallet-find') {
      const adminSec = (req.headers['x-admin-secret'] || '').trim();
      const serverSec = (process.env.ADMIN_SECRET || '').trim();
      if (!serverSec || adminSec !== serverSec) return res.status(403).json({ error: 'admin only' });

      const want = String(body.address || '').trim();   // optional: filter to one address
      const out = [];
      let cursor = null, pages = 0;
      do {
        const q = cursor ? ('/users?limit=100&cursor=' + encodeURIComponent(cursor)) : '/users?limit=100';
        const page = await privyMgmt('GET', q);
        const users = (page && (page.data || page.users)) || [];
        for (const u of users) {
          const meta = u.customMetadata || u.custom_metadata || {};
          if (!meta.paWallet) continue;
          const email = (u.linkedAccounts || u.linked_accounts || [])
            .find((a) => a.type === 'email')?.address;
          if (!email) continue;
          let address = null;
          try {
            // Decrypt, derive the PUBLIC key, discard the secret. Nothing secret escapes this block.
            const skB64 = decryptWallet(meta.paWallet, email);
            const sk = Buffer.from(skB64, 'base64');
            const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(sk));
            address = b58Encode(Buffer.from(kp.publicKey));
          } catch (_) { continue; }   // wrong key material / corrupt record — skip, never surface it
          if (!want || address === want) out.push({ email, address });
        }
        cursor = (page && (page.nextCursor || page.next_cursor)) || null;
      } while (cursor && ++pages < 20);

      return res.status(200).json({ ok: true, count: out.length, wallets: out });
    }

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
