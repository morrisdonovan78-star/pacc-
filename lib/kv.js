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
/*
 * SAME TRAP AS kvSetNX BELOW — kvSet HAD IT TOO, AND IT WAS STILL LIVE.
 *
 * This appended `EX String(ttl)` unconditionally, so a call with no ttl sent the literal `EX
 * undefined` and Redis refused the whole command:
 *   [kv] SET rejected: HTTP 400 {"error":"ERR value is not an integer or out of range"}
 * _cmd swallows that and returns null, so the caller believed it had written the key. The one
 * caller doing it is settle.js's `kvSet('wref:' + wallet, code)` — the wallet→referral-code cache —
 * which therefore NEVER stored anything: every request for a wallet's code re-minted it and walked
 * the NX collision loop from scratch, and the "cached code held by another wallet, re-minting"
 * branch fired on codes that were simply never cached in the first place.
 *
 * A float ttl is rejected for exactly the same reason, so it is floored rather than passed through.
 * A key with no expiry is a legitimate thing to want; ask Redis for one properly.
 */

/*
 * Turns whatever a caller passed as a ttl into the `EX <seconds>` pair, or into nothing at all.
 * ONE definition, shared by kvSet and kvSetNX, so the two can never drift apart again — the whole
 * reason this bug outlived its own fix is that kvSetNX was corrected and kvSet was not.
 *
 * The rules, and why each exists:
 *   absent / null / '' / not a number  -> no EX. This is the "I want a permanent key" case that used
 *                                         to send `EX undefined` and get the command refused.
 *   <= 0                               -> no EX, NOT a 1-second key. Redis has no concept of a zero
 *                                         expiry, and admin.js already spells "forever" as 0
 *                                         (DURATIONS.perm). It routes perm bans to kvSetPerm today,
 *                                         so nothing reaches here with 0 — but silently turning a 0
 *                                         into a key that dies in one second is exactly the kind of
 *                                         trap this file keeps producing. Say what 0 means.
 *   0 < ttl < 1                        -> 1 second. Sub-second is meaningless to EX and flooring it
 *                                         would give 0, i.e. refused; a lock asked to be brief must
 *                                         still expire rather than becoming permanent.
 *   otherwise                          -> floored to a whole number of seconds.
 */
function _ex(ttl) {
  const n = Number(ttl);
  if (ttl === undefined || ttl === null || ttl === '' || !Number.isFinite(n) || n <= 0) return [];
  return ['EX', String(Math.max(1, Math.floor(n)))];
}

const kvSet      = (key, val, ttl)    => _cmd(['SET', key, String(val), ..._ex(ttl)]);
/*
 * TTL IS OPTIONAL, AND OMITTING IT USED TO SILENTLY BREAK THE CALLER.
 *
 * This always appended `EX String(ttl)`, so a call with no ttl sent `EX undefined`. Redis rejects
 * that as an invalid expire time, _cmd swallows the error and returns null, and every caller reads a
 * null NX result as "the lock is already held". The comment above this block warns about exactly
 * that failure mode; the helper itself was causing it.
 *
 * What that actually cost, all silently, all reporting success:
 *   kartpaid:   every kart race payout suppressed as a duplicate
 *   kartrefund: every kart refund suppressed
 *   evtpaid:    Bounty Hour prize payouts
 *   recpaid:    the weekly Recruiter of the Week prize
 *   refcode:    referral codes were NEVER written, so no invite link could ever bind a referee -
 *               which is why the platform recorded zero qualified recruits, ever
 *   refq:       the qualified-recruit flag
 *
 * A key with no expiry is a legitimate thing to want, so the fix is to ask for one properly rather
 * than to make every caller pass a ttl it does not need.
 */
// Shares _ex() with kvSet above — see the rules there. On THIS helper an invalid ttl costs money: the
// rejection returns null, null reads as "lock already held", and the payout it guards is suppressed
// as a duplicate. That is the failure the block above describes, so the two must stay identical.
const kvSetNX    = (key, val, ttl)    => _cmd(['SET', key, String(val), ..._ex(ttl), 'NX']);
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
