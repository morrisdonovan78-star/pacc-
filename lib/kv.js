'use strict';
// Thin wrapper around Vercel KV (Upstash Redis) REST API.
// Requires KV_REST_API_URL + KV_REST_API_TOKEN env vars (set automatically when you
// connect a KV store to this project in the Vercel dashboard → Storage).
// If env vars are missing every function returns null — game degrades gracefully.

// RETRY TRANSIENT FAILURES. This used to be a single attempt on a 3s deadline that swallowed every
// error into null. A dropped command therefore became "no such key" — which reads as an empty
// leaderboard, a zeroed stat row, or (worst) a failed SET NX that the cashout handler interprets as
// "a payout is already in progress", so a player's winnings silently fail while the store is fine.
// Timeouts, 5xx and 429 are transient by definition, so they are retried with backoff instead; only
// a genuine 4xx or a final exhausted retry returns null, and that case is logged so an outage is
// visible in the function logs rather than masquerading as ordinary empty data.
async function _cmd(cmd, _attempt = 0) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(cmd),
      signal:  AbortSignal.timeout(6000),
    });
    // 429 (rate limited) and 5xx are worth another go; 4xx auth/shape errors never are.
    if (!r.ok) {
      if (r.status === 429 || r.status >= 500) throw new Error('kv-http-' + r.status);
      // Include the provider's own message — Upstash reports plan-limit exhaustion as a 400 with a
      // descriptive body, which is otherwise indistinguishable from a malformed command.
      let why = '';
      try { why = (await r.text()).slice(0, 200); } catch (_) {}
      console.error('[kv] ' + cmd[0] + ' rejected: HTTP ' + r.status + ' ' + why);
      return null;
    }
    const d = await r.json();
    return d.result ?? null;
  } catch (e) {
    if (_attempt < 2) {
      await new Promise(res => setTimeout(res, 150 * Math.pow(2, _attempt)));
      return _cmd(cmd, _attempt + 1);
    }
    console.error('[kv] ' + cmd[0] + ' failed after 3 attempts — ' + ((e && e.message) || e));
    return null;
  }
}

// Liveness probe. Every helper above collapses "no such key" and "the store is unreachable" into
// the same null, which is harmless for reads but dangerous for SET NX: a kvSetNX that failed
// because KV was down is indistinguishable from a lock that is genuinely held. Any caller gating
// MONEY on a falsy NX result must ping first, or an outage silently becomes "already in progress"
// and every payout on the platform fails with a message that sends players away to retry forever.
async function kvPing() { return (await _cmd(['PING'])) !== null; }

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

module.exports = { kvPing,
                   kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrevrange,
                   kvHincrby, kvHget, kvHset, kvHsetnx, kvHgetall,
                   kvLpush, kvLtrim, kvLrange, kvZrem,
                   kvIncrby, kvExpire, kvMget, kvScan };
