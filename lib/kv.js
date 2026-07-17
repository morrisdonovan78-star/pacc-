'use strict';
// Thin wrapper around Vercel KV (Upstash Redis) REST API.
// Requires KV_REST_API_URL + KV_REST_API_TOKEN env vars (set automatically when you
// connect a KV store to this project in the Vercel dashboard → Storage).
// If env vars are missing every function returns null — game degrades gracefully.

async function _cmd(cmd) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(cmd),
      signal:  AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;
  } catch (_) { return null; }
}

const kvGet      = (key)              => _cmd(['GET', key]);
const kvGetDel   = (key)              => _cmd(['GETDEL', key]);
const kvSet      = (key, val, ttl)    => _cmd(['SET', key, String(val), 'EX', String(ttl)]);
const kvSetNX    = (key, val, ttl)    => _cmd(['SET', key, String(val), 'EX', String(ttl), 'NX']);
const kvDel      = (key)              => _cmd(['DEL', key]);
const kvSetPerm  = (key, val)         => _cmd(['SET', key, String(val)]);
const kvZadd     = (key, score, mbr)  => _cmd(['ZADD', key, String(score), mbr]);
const kvZrevrange= (key, s, e)        => _cmd(['ZREVRANGE', key, s, e, 'WITHSCORES']);

// Hash field operations — atomic, no read-modify-write races.
// All player stats use ph:{address} hash keys so concurrent updates never clobber each other.
const kvHincrby  = (key, field, delta) => _cmd(['HINCRBY', key, field, String(delta)]);
const kvHget     = (key, field)        => _cmd(['HGET', key, field]);
const kvHset     = (key, field, val)   => _cmd(['HSET', key, field, String(val)]);
const kvHsetnx   = (key, field, val)   => _cmd(['HSETNX', key, field, String(val)]);

// List + sorted-set extras used by the admin panel
const kvLpush    = (key, val)          => _cmd(['LPUSH', key, String(val)]);
const kvLtrim    = (key, s, e)         => _cmd(['LTRIM', key, String(s), String(e)]);
const kvLrange   = (key, s, e)         => _cmd(['LRANGE', key, String(s), String(e)]);
const kvZrem     = (key, member)       => _cmd(['ZREM', key, String(member)]);

// Atomic counters for the betting ledgers (betLiability / accruedFee live in ONE hash key so a
// single HGETALL reads the whole ledger and HINCRBY updates are race-free).
const kvIncrby   = (key, delta)        => _cmd(['INCRBY', key, String(delta)]);
const kvExpire   = (key, ttl)          => _cmd(['EXPIRE', key, String(ttl)]);

// MGET — bulk value fetch. Returns an array aligned with `keys` (null for missing). Used to sum
// all outstanding player wager deposits (pw:*) for the solvency invariant without N round-trips.
async function kvMget(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const r = await _cmd(['MGET', ...keys]);
  return Array.isArray(r) ? r : keys.map(() => null);
}

// SCAN — cursor-based key enumeration (non-blocking, unlike KEYS). Loops until the cursor returns
// to '0', collecting every key matching `pattern`. READ-ONLY. Used to (a) sum wager liability across
// all `pw:*` deposits and (b) enumerate a market's individual bets (`bet:<mkt>:*`) at resolve time.
// Hard-capped at maxKeys so a pathological keyspace can never hang a payout.
async function kvScan(pattern, maxKeys = 20000) {
  const out = [];
  let cursor = '0';
  let guard = 0;
  do {
    const r = await _cmd(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']);
    if (!Array.isArray(r) || r.length < 2) break;
    cursor = String(r[0]);
    const batch = Array.isArray(r[1]) ? r[1] : [];
    for (const k of batch) { out.push(k); if (out.length >= maxKeys) return out; }
    if (++guard > 200) break; // absolute safety: never loop forever
  } while (cursor !== '0');
  return out;
}

// HGETALL returns alternating [field, value, ...] array from Upstash REST API.
// Parsed into a plain object here.
async function kvHgetall(key) {
  const arr = await _cmd(['HGETALL', key]);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

module.exports = { kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrevrange,
                   kvHincrby, kvHget, kvHset, kvHsetnx, kvHgetall,
                   kvLpush, kvLtrim, kvLrange, kvZrem,
                   kvIncrby, kvExpire, kvMget, kvScan };
