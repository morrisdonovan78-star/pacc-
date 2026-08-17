// api/settle.js — tweetnacl only, no @solana/web3.js (ESM/runtime issues)
'use strict';
const nacl    = require('tweetnacl');
const crypto  = require('crypto');
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
// Flip to '1' once BOTH game nodes are confirmed minting cash-out proofs. Until then a cashout with no
// valid proof falls back to the old client-claimed-and-capped figure, so a stale cached client can
// still get paid instead of being stranded with its money in escrow. With it set, an unproven cashout
// is refused outright and the wager is left on record to retry — see the cashout path.
const REQUIRE_CASH_PROOF = (process.env.CASHOUT_REQUIRE_PROOF || '') === '1';
/* Printed on every cold start, because THE FLAG'S VALUE CANNOT BE READ BACK. This project stores env
 * vars as "sensitive", so `vercel env ls` and the REST API both return "" for the value whatever it
 * actually is — which means the only honest way to know whether the guard is armed in production is
 * for production to say so. It was already set once with an EMPTY value and a deploy titled "so
 * CASHOUT_REQUIRE_PROOF=1 takes effect", and nothing on the outside could tell the difference. Also
 * prints whether GAME_SECRET is present at all, since no secret means no proof can ever verify and
 * every cash-out would be refused with the guard on. Values are never printed, only their state. */
console.log('[settle] boot REQUIRE_CASH_PROOF=' + (REQUIRE_CASH_PROOF ? 'ON (proof mandatory)' : 'OFF (client claim, capped 20x)') +
            ' GAME_SECRET=' + (GAME_SECRET ? 'present(' + GAME_SECRET.length + ' chars)' : 'MISSING'));
const { kvPing, kvGet, kvGetDel, kvSet, kvSetNX, kvDel, kvSetPerm, kvZadd, kvZrem, kvZrevrange, kvHincrby,
        kvLpush, kvLtrim, kvLrange, kvHget, kvHset, kvHgetall, kvIncrby, kvExpire, kvMget, kvScan } = require('../lib/kv');
// Pure pari-mutuel engine (spectator betting). All money math lives here so it is unit-tested
// offline; this file only does auth, KV, and the on-chain transfers. See lib/betting.js.
const BET = require('../lib/betting');
const PAYOUT = require('../lib/eventpayout');   // pure winner/amount planning (unit-tested offline)

/*
 * Appends a timestamped point to the player-profile chart history.
 *
 * TWO series, because one cannot do both jobs:
 *   ph:<game>:hist:<addr>  a LIST of the last HIST_MAX raw events - full detail, recent only.
 *   phd:<game>:<addr>      a HASH, one field per UTC day, holding that day's LAST cumulative totals.
 *
 * The raw list was capped at 200, which sounds generous and is not: every entry, cash-out and kill
 * reward writes a point, so an active player burns 200 in a single evening. The chart's 1M/6M/1Y
 * timeframes then all showed the same three hours, with both axis labels reading the same date, which
 * looks exactly like a broken chart. The cap is 2000 now, and the daily rollup means the long
 * timeframes keep working however far back you go - one field per day is ~400 fields a year, and it is
 * overwritten within a day rather than appended, so it costs no growth.
 *
 * The rollup carries the same cumulative e/w as the raw points, so the two series concatenate onto one
 * axis with no rescaling - see the merge in api/leaderboard.js.
 *
 * ⚠️ `e` ALONE CANNOT DRAW A PROFIT CHART. It is CUMULATIVE GROSS PAYOUTS, which only ever rises —
 * so a player who lost money still got a line sloping cheerfully upward. The chart needs
 * cumulative WAGERED too, because net = e - w, and that is the number that dips when someone loses.
 *
 * Records now carry:
 *   e  cumulative earned (gross payouts)   — as before
 *   w  cumulative wagered                  — NEW; net profit is e - w
 *   ty event type ('join' | 'cashout' | 'kill')
 *   a  THIS event's amount, for the hover tooltip
 *
 * Pre-existing records have no `w`; the chart deliberately ignores those rather than mixing scales
 * (see PlayerCard.jsx) — there is no way to reconstruct historical wagered-at-time-T after the fact.
 */
const HIST_MAX = 2000;          // raw per-event points kept per player per game
async function pushEarningsPoint(game, address, earned, meta) {
  const key = 'ph:' + game + ':hist:' + address;
  const rec = { t: Date.now(), e: Number(earned) || 0 };
  if (meta) {
    if (meta.wagered != null) rec.w  = Number(meta.wagered) || 0;
    if (meta.type)            rec.ty = String(meta.type).slice(0, 12);
    if (meta.amount != null)  rec.a  = Number(meta.amount) || 0;
  }
  await kvLpush(key, JSON.stringify(rec));
  await kvLtrim(key, 0, HIST_MAX - 1);
  /* Day rollup. Overwrites the same field all day, so it lands on that day's final totals. Wrapped and
   * swallowed on purpose: this is a chart nicety attached to the cash-out and kill paths, and it must
   * never be the reason a payout response fails. */
  try {
    const day = new Date(rec.t).toISOString().slice(0, 10);
    await kvHset('phd:' + game + ':' + address, day, JSON.stringify(rec));
  } catch (_) {}
}

// ── Ed25519 wallet signature verification ─────────────────────────────────────
// The client signs: "pac-arena:{action}:{playerAddress}:{wagerLamports}:{unixTs}"
// using their Solana wallet private key (tweetnacl detached signature).
// Only the real wallet owner can produce a valid signature — forged cashouts are impossible.
function verifyPlayerSig(sig, ts, action, playerAddress, wagerLamports) {
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!sig || !ts) return false;
    if (Math.abs(now - Number(ts)) > 120) return false; // 2-minute window
    const msg = 'pac-arena:' + action + ':' + (playerAddress||'') + ':' + (wagerLamports||0) + ':' + ts;
    const msgBytes  = Buffer.from(msg, 'utf8');
    const sigBytes  = Buffer.from(sig, 'base64');
    const pubBytes  = b58Decode(playerAddress);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  } catch (_) { return false; }
}

const CREATOR_WALLET  = '2ZLqQww5koLr2J7PU54UwA7yNX4DRmMHMLAQjm411E7a';
const CREATOR_FEE_PCT = 0.10;
// ── Scheduled kill-scoring events ("Bounty Hour"). Only kills landed inside one of these UTC
// windows, in a PAID lobby, accrue to the event board (evtk:<id> hash, field = killer wallet).
// Kills come only from the GAME_SECRET-authed elim-lock below, so the board can't be client-inflated.
// KEEP THE WINDOWS IN SYNC with the 'bounty' entries of window.SNAKE_EVENTS in slither-snakes.html.
/* Events run on a Saturday 2 PM ET slot (Bounty Hour 2–4 PM, Free Entry Grind 4–5 PM straight
 * after), but ONLY on the Saturdays listed in SCHEDULED_SATURDAYS below. The slot arithmetic is
 * generated so an occurrence can never be half-defined; the SCHEDULE is explicit so an event can
 * never run — or pay out — on a week the operator didn't put there.
 *
 * This used to generate every week forever. That auto-scheduled a Bounty Hour the operator had not
 * announced, pushed a countdown to it onto the homescreen, and would have opened a live scoring
 * window that auto-pays $40 of prize money out of the float. Prize money does not get committed by
 * a for-loop. Add a date here to schedule the next one; remove/omit it and nothing runs.
 *
 * Occurrence ids stay 'bounty-YYYY-MM-DD' / 'grind-YYYY-MM-DD', unchanged, because they key the
 * payout idempotency locks (evtk:<id>, per-place NX) and the already-settled Jul 25 event must keep
 * resolving to the same id it was paid under.
 *
 * KEEP IN SYNC with the 'grind' schedule in api/join.js and window.SNAKE_EVENTS in
 * slither-snakes.html (the in-game card).
 *
 * Recruiter of the Week used to be exempt from this rule ("a rolling weekly contest that always
 * runs"). That exemption is the exact hole this whole comment warns about: on 2026-08-07 it paid an
 * unscheduled $10 out of escrow mid-match and stranded a player's cash-out. It was first put behind
 * its own explicit schedule and then, on 2026-08-17, removed altogether. Bounty Hour and the Free
 * Entry Grind are what is left, and the rule they are held to is unchanged — prize money is
 * committed one occurrence at a time, by hand, or it is not committed. */
const SCHEDULED_SATURDAYS = ['2026-07-25'];                // ← the only Saturdays an event exists on
const SATURDAY_ANCHOR = Date.UTC(2026, 6, 25, 18, 0, 0);   // Sat Jul 25 2026 14:00 ET
const SAT_UTC_HOUR    = 18;                                // time-of-day of SATURDAY_ANCHOR, in UTC
const WEEK_MS_EV      = 7 * 24 * 3600 * 1000;

// One scheduled day → one occurrence window. Date.parse of 'YYYY-MM-DDT18:00:00Z' is exactly
// SATURDAY_ANCHOR + n whole weeks for any Saturday in the list, so this and the week arithmetic below
// can never disagree about when an event starts.
function evFromDay(day, kind, durMs, offsetMs) {
  const start = Date.parse(day + 'T' + SAT_UTC_HOUR + ':00:00.000Z');
  if (!Number.isFinite(start)) return null;                // typo'd date in the schedule → no event
  return { id: kind + '-' + day, day, start: start + (offsetMs || 0), end: start + (offsetMs || 0) + durMs };
}
// The occurrence in the week containing `now` (may be later that same week), or null when that
// Saturday isn't on the schedule — meaning there is no event that week, at all.
function evOccurrence(now, kind, durMs, offsetMs) {
  const i = Math.floor((now - SATURDAY_ANCHOR) / WEEK_MS_EV);
  const day = new Date(SATURDAY_ANCHOR + i * WEEK_MS_EV).toISOString().slice(0, 10);
  if (SCHEDULED_SATURDAYS.indexOf(day) < 0) return null;
  return evFromDay(day, kind, durMs, offsetMs);
}
// EVERY scheduled occurrence, oldest first — driven by the schedule itself, not a sliding window of
// weeks around `now`. A window would eventually roll off the oldest event, and the "last event's
// results" board on the homescreen would silently empty out months after the fact.
function evSeries(kind, durMs, offsetMs) {
  return SCHEDULED_SATURDAYS.map(d => evFromDay(d, kind, durMs, offsetMs))
                            .filter(Boolean).sort((a, b) => a.start - b.start);
}
const KILL_EVENTS_DUR  = 2 * 3600 * 1000;   // 2h: 2–4 PM ET
const GRIND_EVENT_DUR  = 1 * 3600 * 1000;   // 1h: 4–5 PM ET, straight after Bounty
const GRIND_OFFSET_MS  = 2 * 3600 * 1000;   // starts when Bounty ends
// Kept as a function-backed view so a long-lived serverless instance can never serve a stale window.
function killEvents() { return evSeries('bounty', KILL_EVENTS_DUR, 0); }
function activeKillEvent(now) { now = now || Date.now();
  const e = evOccurrence(now, 'bounty', KILL_EVENTS_DUR, 0);
  return (e && now >= e.start && now < e.end) ? e : null; }
// Free Entry Grind windows — mirror api/join.js. 10 paid $5 games in a window → 1 credit.
const GRIND_TARGET = 10;
function activeGrindEvent(now) { now = now || Date.now();
  const e = evOccurrence(now, 'grind', GRIND_EVENT_DUR, GRIND_OFFSET_MS);
  return (e && now >= e.start && now < e.end) ? e : null; }

/* ── Recruiter of the Week: REMOVED, 2026-08-17 ──────────────────────────────────────
 *
 * Owner: take it out of snakepot.com completely, no trace of it whatsoever. Gone from here are the
 * rolling week arithmetic (RECRUIT_ANCHOR / recruitWeek), the paying-week schedule
 * (SCHEDULED_RECRUIT_WEEKS), the derived all-time totals (allTimeRecruits + its recruitall: cache),
 * the settleRecruiter payout, and the recruiter-board / recruiter-settle / recruit-migrate actions.
 * lib/eventpayout.js lost planRecruiterPayout with them, so no code path in the platform can now
 * turn a referral count into a transfer.
 *
 * ⚠️ REFERRALS THEMSELVES STAY — that was the explicit instruction. The invite link, the first-touch
 * bind (refby:), the per-referrer stats (refstats:) and the exactly-once qualify flag (refq:) are all
 * untouched, and my-refcode below still serves a player their link and their all-time count.
 *
 * The count moved from `recruit:<weekId>` hashes to one `refstats:<ref>` field, `qualified`. With no
 * contest there is no week, so there is nothing to bucket by and no anchor that can renumber a
 * bucket — the failure mode that cost two sessions. Writers are api/join.js (accrual, +1) and
 * api/admin.js (ref-bind +1 / ref-unbind -1), the same two that already maintain `players` beside it.
 *
 * ⚠️ The old `recruit:rw*` hashes are LEFT IN KV, not deleted. They hold counts earned before this
 * change, and admin.html has a one-shot `ref-qualified-import` that folds them into
 * refstats.qualified so nobody watches their number drop to zero. Run it once after deploy; it is
 * NX-guarded, so a second run is a no-op. Delete the buckets only after that has run. */

// Stable 6-char code from a wallet (no I/O/0/1 → unambiguous, human-typeable).
function refCodeFor(seed) {
  const h = crypto.createHash('sha256').update('refcode|' + seed).digest();
  const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 6; i++) c += AL[h[i] % 32];
  return c;
}
// Ensure a wallet has a registered referral code; returns it. Collision-safe (salts on clash).
async function ensureRefCode(wallet) {
  let code = await kvGet('wref:' + wallet).catch(() => null);
  if (code) {
    /*
     * HEAL A CODE THAT WAS NEVER ACTUALLY REGISTERED.
     *
     * kvSetNX used to send `EX undefined` when called without a ttl, which Redis rejects — so every
     * refcode: write below FAILED while wref: (a plain SET) succeeded. That left wallets holding a
     * code that resolves to nothing: the invite link looks fine, and api/join.js reads
     * kvGet('refcode:<CODE>') as null and refuses the bind. It is why the platform has never recorded
     * a single qualified recruit.
     *
     * Returning the cached code alone would leave those links dead forever, because this branch never
     * reaches the registration below. So verify the mapping actually exists and write it if it does
     * not. Only ever claims the code for THIS wallet if nobody else holds it.
     */
    const owner = await kvGet('refcode:' + code).catch(() => null);
    if (owner === wallet) return code;
    if (!owner) {
      const claimed = await kvSetNX('refcode:' + code, wallet);
      if (claimed) { console.log('[ref] healed unregistered code', { code, wallet: String(wallet).slice(0, 8) }); return code; }
    }
    // Someone else legitimately holds it — fall through and mint a fresh one for this wallet.
    console.warn('[ref] cached code held by another wallet, re-minting', { code });
  }
  code = refCodeFor(wallet);
  let ok = await kvSetNX('refcode:' + code, wallet);
  let tries = 0;
  while (!ok && tries < 6) {
    const ex = await kvGet('refcode:' + code).catch(() => null);
    if (ex === wallet) { ok = true; break; }
    code = refCodeFor(wallet + ':' + (++tries));
    ok = await kvSetNX('refcode:' + code, wallet);
  }
  await kvSet('wref:' + wallet, code).catch(() => {});
  return code;
}

// Best-effort Discord announce of event winners via the existing wins webhook. @-pings any winner who
// has linked their Discord (discord:<wallet>). Never throws — a Discord hiccup must not fail a payout.
async function postEventWinners(title, winners) {
  const url = DISCORD_WINS_WEBHOOK; if (!url) return;
  const ids = [];
  const lines = await Promise.all(winners.map(async w => {
    const medal = ['🥇', '🥈', '🥉'][w.place - 1] || (w.place + '.');
    let who = w.name || (String(w.addr).slice(0, 4) + '…' + String(w.addr).slice(-4));
    try { const did = await kvGet('discord:' + w.addr); if (did) { who = '<@' + did + '>'; ids.push(String(did)); } } catch (_) {}
    return medal + ' ' + who + ' — **$' + w.usd + '**' + (w.ok === false ? ' _(payout pending)_' : '');
  }));
  const body = { content: title + '\n' + lines.join('\n') + '\n💰 Paid in SOL. GG! 🐍',
    allowed_mentions: { parse: [], users: ids.slice(0, 50) } };
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
}

// Settle a Bounty-Hour event. Prizes are paid via wgPayOne, whose assertSolvency guard means prize
// money can ONLY come from genuine escrow surplus (the owner-funded float) — never player/bettor
// funds. Per-place NX locks make each payout run at most once; a failed send releases its lock so a
// later trigger retries (e.g. once the float is funded). dryRun computes + returns the plan only.
async function settleBounty(ev, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const h = (await kvHgetall('evtk:' + ev.id).catch(() => null)) || {};
  const board = Object.keys(h).map(a => ({ addr: a, kills: parseInt(h[a]) || 0 }))
                      .filter(r => r.kills > 0).sort((a, b) => b.kills - a.kills);
  for (const r of board.slice(0, 2)) { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }
  const price = await solUsdQuick();
  let esc, bal = 0;
  try { esc = getEscrow(); const bh = await fetchBalAndHash(esc.pubkeyB58); bal = bh.bal; }
  catch (e) { return { ok: false, reason: 'escrow load: ' + (e && e.message) }; }
  const plan = PAYOUT.planBountyPayout({ board, solPriceUsd: price || 0, escrowLamports: bal,
    floorLamports: RENT_MIN, prizes: { first: 25, second: 15, bump: 35 }, bumpMinPlayers: 10 });
  // One-off (bounty-2026-07-25): the 1st-place finisher was the operator, who entered and won fairly
  // but DECLINED their own prize — pay ONLY 2nd place. Applied to plan.winners here so the dry-run
  // PREVIEW, the real payout, and the Discord results post are all consistent (only 2nd shown/paid).
  // Scoped by event id → every other/future bounty still pays 1st+2nd. 2nd's $15 is unchanged.
  if (ev.id === 'bounty-2026-07-25') {
    plan.winners = plan.winners.filter(w => w.place !== 1);
    // RE-VERIFY solvency for the reduced set. plan.ok/totalLamports/shortfall from planBountyPayout
    // reflect the FULL 1st+2nd sum, which the float may NOT cover even when it covers 2nd alone — so
    // without this the !plan.ok guard below would bail and pay NOBODY. Mirror finalizePlan exactly
    // (spendable = escrow − floor; no TX_FEE here, wgPayOne's assertSolvency does the on-chain check).
    plan.totalLamports = plan.winners.reduce((s, w) => s + w.lamports, 0);
    const _spendable = Math.max(0, bal - RENT_MIN);
    plan.ok = plan.totalLamports > 0 && plan.totalLamports <= _spendable;
    plan.reason = plan.ok ? 'ok' : (plan.totalLamports > 0 ? 'insufficient float' : 'zero payout');
    if (plan.ok) delete plan.shortfall; else plan.shortfall = plan.totalLamports - _spendable;
    // 2nd place ($15) was PAID MANUALLY (a direct SOL transfer outside the settle system) after the
    // event, so the per-place NX pay-lock was never taken. Now that EVENT_AUTOPAY is gone and any poll
    // triggers a real settle, the automated path would try to pay him AGAIN → double-pay. Short-circuit
    // the REAL settle for this one event to prevent it. The dry-run above still returns the info plan.
    if (!dryRun) return { ok: true, id: ev.id, reason: 'settled-manually (2nd paid out-of-band)', winners: [] };
  }
  if (dryRun) return { dryRun: true, id: ev.id, solPriceUsd: price || 0, escrowSol: bal / 1e9,
    players: board.length, plan };
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };   // no lock taken → retries later
  const paid = [];
  for (const w of plan.winners) {
    const lk = await kvSetNX('evtpaid:' + ev.id + ':' + w.place, String(Date.now()));
    if (!lk) { paid.push({ place: w.place, addr: w.addr, name: w.name, usd: w.usd, already: true }); continue; }
    const r = await wgPayOne(esc, w.addr, w.lamports, 'bounty:' + ev.id + ':' + w.place, { protectPlayers: true });
    /* ⚠️ THE LOCK IS ONLY RELEASED WHEN NOTHING CAN HAVE MOVED. See the note on wgPayOne: a failure
     * whose transaction may already be in the mempool must KEEP its lock, or the next run pays the same
     * place a second time — which is exactly how the recruiter prize went out twice for one week. The
     * ordinary failure (an unfunded float) still releases and still retries, which is what the release
     * was for. A held lock is reported, alerted, and clearable from the admin panel. */
    let held = false;
    if (!r.ok) {
      held = !(await releasePayLock('evtpaid:' + ev.id + ':' + w.place, r,
                                    'bounty:' + ev.id + ' place ' + w.place + ' -> ' + String(w.addr).slice(0, 8)));
    }
    paid.push({ place: w.place, addr: w.addr, name: w.name, usd: w.usd, lamports: w.lamports, ok: r.ok,
                sig: r.sig || null, reason: r.reason || null, heldForReview: held });
  }
  const result = { id: ev.id, ts: Date.now(), bumped: plan.bumped, winners: paid };
  await kvSetPerm('evtresult:' + ev.id, JSON.stringify(result)).catch(() => {});
  try { await postEventWinners('🏆 **BOUNTY HOUR RESULTS**', paid); } catch (_) {}
  return { ok: true, result };
}

// Minimum accrued referral balance a referrer can withdraw. Keeps a single payout worth many times
// its own ~5000-lamport network fee instead of dribbling out cent-sized transactions. ~0.002 SOL.
const REF_MIN_CLAIM   = 2_000_000;
// ⚠️ KEEP IN SYNC with REFERRAL_REWARDS_ENABLED in api/join.js — that flag stops rewards accruing,
// this one stops them being withdrawn from escrow. Both must be true for the program to run at all;
// leaving either half on is what would let money keep moving after the owner switched it off.
const REFERRAL_REWARDS_ENABLED = false;

// ── Discord "wall of winners" ─────────────────────────────────────────────────────────────────
// When a paid cashout confirms, we post a small embed to a Discord channel via an incoming webhook.
// It turns every real win into free, on-chain-proven social proof that recruits players. The
// webhook URL lives ONLY in this env var (never shipped to the client) so nobody can spam the
// channel. If the var is unset the whole feature is silently off — nothing changes. Set it in
// Vercel: DISCORD_WINS_WEBHOOK = the URL from Discord → channel → Integrations → Webhooks.
const DISCORD_WINS_WEBHOOK = (process.env.DISCORD_WINS_WEBHOOK || '').trim();
const DISCORD_BOT_TOKEN    = (process.env.DISCORD_BOT_TOKEN || '').trim();          // clip bot — reads link codes
const DISCORD_LINK_CHANNEL = (process.env.DISCORD_LINK_CHANNEL || '1523824631914696916').trim();
const WIN_POST_MIN_USD = 1.50;          // only announce cashouts worth at least this many dollars
const WIN_POST_MIN_SOL_FALLBACK = 0.02; // ~$1.50 at a typical SOL price — used only if the price
                                        // feed is momentarily unavailable, so a price hiccup neither
                                        // spams the channel nor silently suppresses every win

// Best-effort SOL/USD for the embed. Tries multiple sources in order (first success wins) so the
// USD figure reliably shows. ORDER MATTERS: Binance geo-blocks US IPs and Vercel functions run in
// the US, so Binance-first silently returned null and every post fell back to SOL-only — Coinbase
// and CoinGecko answer fine from US, so they go first. Short per-source timeout; null only if every
// source fails (embed then shows SOL). Never throws — a price hiccup must never touch the payout.
async function solUsdQuick() {
  const sources = [
    { url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot', pick: d => parseFloat(d && d.data && d.data.amount) },
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', pick: d => d && d.solana && d.solana.usd },
    { url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', pick: d => parseFloat(d && d.price) },
  ];
  for (const s of sources) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) continue;
      const p = s.pick(await r.json());
      if (p > 0) return p;
    } catch (_) { /* try next source */ }
  }
  return null;
}

// Post a single win to the Discord channel. Fully best-effort: any failure is swallowed so it can
// NEVER affect the player's payout or the API response. `grossLamports` is what the player cashed
// out (wager + winnings) — the figure they actually saw, and the honest social-proof number.
async function postWinToDiscord(grossLamports, name, sig) {
  if (!DISCORD_WINS_WEBHOOK) return;
  const sol = grossLamports / 1e9;
  const price = await solUsdQuick();
  const usdVal = price ? sol * price : null;
  // USD gate: only announce cashouts >= $1.50. When the price feed is up we compare real dollars;
  // if it's momentarily down we fall back to an approximate SOL floor so a hiccup doesn't misbehave.
  if (usdVal != null) { if (usdVal < WIN_POST_MIN_USD) return; }
  else { if (sol < WIN_POST_MIN_SOL_FALLBACK) return; }
  try {
    const usd = usdVal != null ? '$' + usdVal.toFixed(2) : null;
    const who = (name && String(name).trim()) ? String(name).trim().slice(0, 20) : 'A player';
    const amount = usd ? (usd + '  (' + sol.toFixed(3) + ' SOL)') : (sol.toFixed(3) + ' SOL');
    const explorer = 'https://explorer.solana.com/tx/' + sig;
    const body = {
      username: 'SNAKE POT',
      embeds: [{
        title: '🐍 ' + who + ' just cashed out!',
        description: '**' + amount + '** paid straight to their wallet.\n\n' +
                     '[✅ View on-chain proof](' + explorer + ')  •  [🎮 Play now](https://snakepot.com/play)',
        color: 0x39FF14,
        timestamp: new Date().toISOString(),
      }],
    };
    await fetch(DISCORD_WINS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* social proof is best-effort; never let it matter */ }
}
/* ── Discord BET SLIPS ────────────────────────────────────────────────────────────────────────────
 * A settled P2P wager posted as a real slip: the market, both sides, the stake, the payout, and an
 * on-chain link to the transaction that paid it. Public channel, not a DM — this is the sportsbook
 * equivalent of a winning ticket photo, and it is the cheapest advertising the betting exchange has.
 *
 * Channel: DISCORD_SLIPS_WEBHOOK if set, otherwise it rides along in the existing wall-of-winners
 * channel (DISCORD_WINS_WEBHOOK) so it works with NO new configuration. Set the dedicated var to split
 * them apart. Unset both and the feature is silently off, exactly like postWinToDiscord.
 *
 * Best-effort throughout, and called only AFTER the payout has landed: every failure is swallowed, so
 * a Discord outage can never affect a settlement or the API response. */
const DISCORD_SLIPS_WEBHOOK = (process.env.DISCORD_SLIPS_WEBHOOK || '').trim();
async function postBetSlipToDiscord(w) {
  const url = DISCORD_SLIPS_WEBHOOK || DISCORD_WINS_WEBHOOK;
  if (!url || !w) return;
  try {
    const t = P2P.getBetType(w.type);
    const lam = n => Math.max(0, Math.floor(Number(n) || 0));
    const price = await solUsdQuick();
    const money = (n) => {
      const sol = lam(n) / 1e9;
      return (price ? '$' + (sol * price).toFixed(2) + '  ' : '') + '(' + sol.toFixed(4) + ' SOL)';
    };
    const takerSide = P2P.opposingSide(w.type, w.side);
    const sideLabel = (s) => { try { return t ? String(t.label(s, w)) : String(s); } catch (_) { return String(s); } };
    const nm = (n, addr) => (n && String(n).trim())
      ? String(n).trim().slice(0, 20)
      : (addr ? String(addr).slice(0, 4) + '…' + String(addr).slice(-4) : 'player');

    const creatorName  = nm(w.creatorName, w.creator);
    const acceptorName = nm(w.acceptorName, w.acceptor);
    const creatorWon   = w.winner && w.creator && String(w.winner) === String(w.creator);
    const winnerName   = creatorWon ? creatorName : acceptorName;
    const winnerSide   = creatorWon ? w.side : takerSide;
    const loserName    = creatorWon ? acceptorName : creatorName;

    // The slip. Stake/To-return/Profit is the DraftKings shape — the three numbers a bettor checks.
    const profit = lam(w.payout) - lam(w.stakeLamports);
    const body = {
      username: 'SNAKE POT · Bet Slips',
      embeds: [{
        title: '🎟️  Bet settled — congrats ' + winnerName + '!',
        description: (t ? '**' + t.question(w) + '**\n' : '') +
                     '`' + sideLabel(winnerSide) + '` ✅  beat  `' + sideLabel(creatorWon ? takerSide : w.side) + '` ❌\n' +
                     '\n' + winnerName + ' takes it off ' + loserName + '.',
        color: 0x39FF14,
        fields: [
          { name: 'Stake',     value: money(w.stakeLamports), inline: true },
          { name: 'Returned',  value: money(w.payout),        inline: true },
          { name: 'Profit',    value: (profit >= 0 ? '+' : '−') + money(Math.abs(profit)), inline: true },
          { name: 'Market',    value: (t && t.id ? t.id : String(w.type || 'bet')) + (w.duel ? ' · duel' : ''), inline: true },
          { name: 'Arena',     value: String(w.region || 'NA') + ' · ' + String(w.lobby || '—'), inline: true },
          { name: 'Fee',       value: money(w.fee), inline: true },
        ],
        footer: { text: 'Slip ' + String(w.id || '').slice(0, 18) + ' · even money, 8% on winnings' },
        timestamp: new Date(w.settledTs || Date.now()).toISOString(),
      }],
    };
    // The on-chain receipt is what makes the slip believable, so link it when we have one.
    if (w.payoutTx) {
      body.embeds[0].description += '\n\n[✅ View the payout on-chain](https://explorer.solana.com/tx/' +
                                    w.payoutTx + ')  •  [🎲 Place a bet](https://snakepot.com/bets)';
    }
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  } catch (_) { /* a slip is advertising; it must never matter to the money */ }
}

const TX_FEE          = 5000;  // exact Solana base fee (5000 lamports × 1 signature, no priority fees)
// Solana requires a system account's balance to be either exactly 0 OR >= RENT_MIN.
// It must NEVER sit between 0 and RENT_MIN — that triggers InsufficientFundsForRent.
// Players no longer deposit RENT_MIN on join (v23 client fix); the settle handler
// uses a sub-rent safety check to drain the escrow to exactly 0 when needed.
const RENT_MIN        = 890880; // lamports — used only for the sub-rent safety check below

// ── RPC endpoint list ────────────────────────────────────────────────────────
// All Vercel serverless functions share the same outbound IP pool.
// Public Solana RPCs rate-limit by IP — under game load ALL public nodes 429.
//
// FIX: Add your free Helius API key as a Vercel environment variable:
//   HELIUS_RPC_URL = https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
//   Sign up free at https://helius.dev (no credit card, 50 req/s)
//
// Until then we fall back to public nodes with batching + skip-preflight
// to reduce calls from ~10 down to ~4 per cashout.
//
// ⚠️ THIS LIST HAD THREE DEAD NODES IN IT — ON THE PAYOUT PATH.
//
// api/rpc.js measured all three BROKEN on 2026-07-18 and dropped them there; this file, which is the
// one that actually MOVES MONEY, was never updated to match:
//   try-rpc.mainnet-beta.solana.com      -> connection timeouts
//   solana.public-rpc.com                -> non-JSON garbage
//   solana-mainnet.g.alchemy.com/v2/demo -> shared demo key, unusable under any load
// So the "five endpoints" here were really two, and the moment Helius hit its rate limit and the one
// official node was busy, EVERY endpoint failed at once and /api/settle returned 503 — a cashout or
// payout refused outright. Vercel's own alert on 2026-07-31 named these exact three hosts as the
// external failures behind that 503 spike (solana.public-rpc.com alone: 287 failures).
//
// Replaced with the list api/rpc.js verified healthy, so the fallbacks are real ones. Order is
// deliberate: dedicated capacity first, then the free node with no shared rate limit, then the
// official node that rate-limits under load.
const RPCS = [
  process.env.HELIUS_RPC_URL,                        // PRIMARY: set in Vercel env vars
  process.env.SOLANA_RPC_URL,                        // optional second private endpoint (same as rpc.js)
  'https://solana-rpc.publicnode.com',               // free, no key, verified healthy
  'https://api.mainnet-beta.solana.com',             // Solana official (rate-limited under load)
].filter(Boolean); // drop undefined (HELIUS_RPC_URL not set yet)

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const b = [];
  for (const c of str) {
    let v = B58.indexOf(c);
    if (v < 0) throw new Error('Bad base58 char: ' + c);
    for (let i = 0; i < b.length; i++) { v += b[i] * 58; b[i] = v & 0xff; v >>= 8; }
    while (v > 0) { b.push(v & 0xff); v >>= 8; }
  }
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  const out = new Uint8Array(z + b.length);
  b.reverse().forEach((x, i) => { out[z + i] = x; });
  return out;
}
function b58Encode(u8) {
  const d = [];
  for (const byte of u8) {
    let c = byte;
    for (let i = 0; i < d.length; i++) { c += d[i] * 256; d[i] = c % 58; c = Math.floor(c / 58); }
    while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); }
  }
  let p = ''; for (const b of u8) { if (b !== 0) break; p += '1'; }
  return p + d.reverse().map(x => B58[x]).join('');
}
// compact-u16 encoding used in Solana transaction wire format
function cu16(n) {
  if (n < 0x80)   return [n];
  if (n < 0x4000) return [(n & 0x7f) | 0x80, (n >> 7) & 0xff];
  return [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0xff];
}

// ── Escrow keypair from env ──────────────────────────────────────────────────
function getEscrow() {
  const raw = (process.env.ESCROW_SECRET || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('ESCROW_SECRET not set');
  let arr; try { arr = JSON.parse(raw); } catch (e) { throw new Error('ESCROW_SECRET bad JSON: ' + e.message); }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error('ESCROW_SECRET must be 64-byte array');
  const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(arr));
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, pubkeyB58: b58Encode(kp.publicKey) };
}

// ── Single-method RPC call — race all nodes, retry 3× on any failure ────────
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  let lastMsg = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try { return await Promise.any(RPCS.map(one)); }
    catch (e) {
      lastMsg = (e.errors || []).map(x => x.message).join(' | ');
      if (attempt < 2) { console.warn('[rpc] attempt ' + (attempt + 1) + ' failed (' + lastMsg + ') — retrying…'); continue; }
      throw new Error('All RPCs failed: ' + lastMsg);
    }
  }
}

// Like rpc(), but for LOOKUPS where a node legitimately answers "not found" (null). Racing and
// taking the fastest reply means one un-indexed node can report not-found while another already has
// the transaction — which made bet deposits fail verification and hang on "Escrowing bet...".
// Resolve on the first node that actually HAS it; only report not-found once every node has spoken.
async function rpcFound(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  return await new Promise(resolve => {
    let left = RPCS.length, settled = false;
    if (!left) return resolve(null);
    for (const url of RPCS) {
      one(url).then(res => {
        if (settled) return;
        if (res != null) { settled = true; return resolve(res); }
        if (--left === 0) { settled = true; resolve(null); }
      }).catch(() => { if (settled) return; if (--left === 0) { settled = true; resolve(null); } });
    }
  });
}

// ── Batched getBalance + getLatestBlockhash in ONE HTTP request ───────────────
// JSON-RPC batching halves pre-transaction RPC calls (2 → 1 HTTP round-trip).
// JSON-RPC batching halves pre-transaction RPC round-trips (2 → 1 HTTP request).
async function fetchBalAndHash(escPubkey) {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'getBalance',         params: [escPubkey, { commitment: 'confirmed' }] },
    { jsonrpc: '2.0', id: 2, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
  ];
  const body = JSON.stringify(batch);
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('Expected array from batch RPC');
    const balEntry = arr.find(x => x.id === 1);
    const bhEntry  = arr.find(x => x.id === 2);
    if (balEntry?.error) throw new Error('getBalance error: ' + balEntry.error.message);
    if (bhEntry?.error)  throw new Error('getBlockhash error: ' + bhEntry.error.message);
    const bal = typeof balEntry?.result?.value === 'number' ? balEntry.result.value
              : typeof balEntry?.result       === 'number' ? balEntry.result : null;
    const blockhash = bhEntry?.result?.value?.blockhash ?? bhEntry?.result?.blockhash ?? null;
    if (bal === null) throw new Error('Bad balance in batch response');
    if (!blockhash)  throw new Error('Bad blockhash in batch response');
    return { bal, blockhash };
  };
  let lastMsg = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try { return await Promise.any(RPCS.map(one)); }
    catch (e) {
      lastMsg = (e.errors || []).map(x => x.message).join(' | ');
      if (attempt < 2) { console.warn('[rpc-batch] attempt ' + (attempt + 1) + ' failed (' + lastMsg + ') — retrying…'); continue; }
      throw new Error('All RPCs failed (balance+blockhash): ' + lastMsg);
    }
  }
}

// ── Build & sign a Solana legacy transaction (escrow signs) ──────────────────
function buildTx(esc, blockhash, transfers) {
  // Validate inputs before doing anything
  if (!blockhash || typeof blockhash !== 'string') throw new Error('buildTx: missing blockhash');
  for (const t of transfers) {
    if (!t.to || t.to.length !== 32) throw new Error('buildTx: recipient must be 32 bytes, got ' + (t.to && t.to.length));
    const lamps = Math.round(Number(t.lamports));
    if (!Number.isFinite(lamps) || lamps <= 0) throw new Error('buildTx: invalid lamports=' + t.lamports);
    t.lamports = lamps; // normalise to integer
  }

  // Account list: escrow, ...recipients, system_program
  const SYS = new Uint8Array(32); // system program = all zeros
  const accts = [esc.publicKey];
  for (const t of transfers) {
    if (!accts.some(a => a.every((v, i) => v === t.to[i]))) accts.push(t.to);
  }
  accts.push(SYS);
  const sysIdx = accts.length - 1;

  // Header: [numRequiredSig, numReadonlySignedAccts, numReadonlyUnsignedAccts]
  // escrow=writable+signer, recipients=writable, system=readonly
  const header = new Uint8Array([1, 0, 1]);

  // Account keys: compact-u16 count + 32 bytes each
  const keys = new Uint8Array([...cu16(accts.length), ...accts.flatMap(a => [...a])]);

  // Recent blockhash (32 bytes decoded from base58)
  const bh = b58Decode(blockhash);
  if (bh.length !== 32) throw new Error('buildTx: blockhash decoded to ' + bh.length + ' bytes (expected 32)');

  // Instructions: compact-u16 count, then each instruction
  const ixs = [transfers.length]; // compact-u16 count (always < 128)
  for (const t of transfers) {
    const toIdx = accts.findIndex(a => a.every((v, i) => v === t.to[i]));
    if (toIdx < 0) throw new Error('buildTx: recipient not found in account list');
    // Bincode-encoded SystemProgram::Transfer { lamports }
    // discriminant u32-LE = 2, then lamports u64-LE
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);           // Transfer discriminant
    new DataView(data.buffer).setBigUint64(4, BigInt(t.lamports), true);
    // instruction: programIdIndex, accounts (cu16 len + indices), data (cu16 len + bytes)
    ixs.push(sysIdx, 2, 0, toIdx, ...cu16(data.length), ...data);
  }

  // Assemble message
  const msg = new Uint8Array([...header, ...keys, ...bh, ...ixs]);

  // Sign
  const sig = nacl.sign.detached(msg, esc.secretKey);

  // Wire format: compact-u16 sigcount + sig + message
  return new Uint8Array([1, ...sig, ...msg]);
}

// ── Send tx AND wait for on-chain confirmation ───────────────────────────────
// Returns { sig, confirmed } where confirmed=true means we observed on-chain confirmation.
// confirmed=false means the TX was sent successfully but hasn't confirmed in our short poll
// window — it will confirm within a few more seconds on-chain.
async function sendAndConfirm(txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');
  let sig;
  try {
    // skipPreflight:false — RPC simulates the tx before broadcasting.
    // If simulation fails (e.g. InsufficientFundsForRent) NO fee is charged from escrow
    // and we get an immediate -32002 error that triggers the retry loop with a fresh balance.
    // With Helius at 50 req/s the extra simulation call is not a problem.
    sig = await rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    throw new Error('Send failed: ' + e.message);
  }
  console.log('[settle] sent sig=' + sig);

  // Confirm with REBROADCAST — poll up to ~12s, searching tx history, and re-send the identical
  // signed bytes every few seconds until it confirms.
  //
  // Why this matters (this was a live, intermittent "winner not paid / can't cash out" bug): a
  // broadcast transaction can be DROPPED before it lands — the leader skips it, it only ever reached
  // one node's mempool, or the network is briefly congested. The old code polled once for 3s and, if
  // it hadn't confirmed, returned {confirmed:false} and NEVER rebroadcast. Every caller treats
  // confirmed:false like success (snake cashout deletes the wager; blackjack sets the paid flag), so a
  // dropped tx meant the money never moved yet the accounting said it did — and the idempotency guard
  // then blocked the retry that would have re-sent it. Result: silent, intermittent non-payment.
  //
  // A SystemProgram transfer is idempotent by signature (fixed by its blockhash), so re-sending the
  // exact same bytes can NEVER double-pay: if it already landed the re-send is a no-op, if it was
  // dropped it gets another chance while the blockhash is still valid (~150 slots / 60-90s).
  // searchTransactionHistory:true ensures a tx that already landed is always found. 12s stays well
  // inside the 55s handler guard even when a settle pays several winners back-to-back.
  const DEADLINE = Date.now() + 12000;
  let polls = 0;
  while (Date.now() < DEADLINE) {
    await sleep(1500);
    try {
      const res = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      const s = res && res.value && res.value[0];
      if (s) {
        if (s.err) {
          console.error('[settle] TX FAILED on-chain sig=' + sig + ' err=' + JSON.stringify(s.err));
          throw new Error('TX rejected on-chain: ' + JSON.stringify(s.err));
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log('[settle] confirmed sig=' + sig + ' status=' + s.confirmationStatus);
          return { sig, confirmed: true };
        }
      }
    } catch (e) {
      if (e.message.startsWith('TX rejected')) throw e;
      // transient RPC poll error — keep trying
    }
    // Every ~4.5s with no confirmation yet, rebroadcast the same bytes to survive a mempool drop.
    // skipPreflight:true — no re-simulation (the balance may have shifted; the tx itself is unchanged).
    if (++polls % 3 === 0) {
      try { await rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]); }
      catch (_) {}
    }
  }
  // Still unconfirmed after 12s of polling + rebroadcasts — genuinely rare now. The tx is in the
  // network and will most likely still land; the caller keeps its optimistic-success behaviour.
  console.log('[settle] sent (unconfirmed after 12s) sig=' + sig);
  return { sig, confirmed: false };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SPECTATOR BETTING (pari-mutuel) — additive, never touches the wager/cashout paths above ──
// ══════════════════════════════════════════════════════════════════════════════
// Money-safety model (see lib/betting.js): a bet payout is sized ONLY from the resolving market's
// own pool (× 0.92), never from the wallet balance; the global solvency invariant is asserted before
// EVERY transfer so betting can never reduce what is available for a player cashout.

const BET_MKT_TTL = 172800;                 // market records / bets live 48h (ample for audit + retries)
const BET_LEDGER  = 'betledger';            // hash: { betLiability, accruedFee } — atomic HINCRBY
const ALERT_URL   = process.env.BET_ALERT_WEBHOOK || process.env.DISCORD_WEBHOOK || '';
const DM_BOT_TOKEN    = (process.env.DM_BOT_TOKEN || '').trim();
const OWNER_DISCORD_ID = (process.env.OWNER_DISCORD_ID || '').trim();
let _ownerDmChannelId = null; // cached after the first successful lookup — avoids a create-channel call every alert

// Sends a Discord DM to the owner ONLY (not a channel) via the bot REST API. Two calls: open/reuse the
// DM channel, then post into it. Discord's create-channel endpoint is idempotent per recipient, so a
// cold cache just costs one extra call, never a duplicate channel.
async function ownerDm(msg) {
  if (!DM_BOT_TOKEN || !OWNER_DISCORD_ID) return;
  try {
    if (!_ownerDmChannelId) {
      const r = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST', headers: { 'Authorization': 'Bot ' + DM_BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: OWNER_DISCORD_ID }), signal: AbortSignal.timeout(4000),
      });
      const j = await r.json().catch(() => null);
      if (j && j.id) _ownerDmChannelId = j.id; else return;
    }
    await fetch('https://discord.com/api/v10/channels/' + _ownerDmChannelId + '/messages', {
      method: 'POST', headers: { 'Authorization': 'Bot ' + DM_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }), signal: AbortSignal.timeout(4000),
    });
  } catch (_) {}
}

// Loud, non-blocking alert whenever the invariant refuses a payout (the backstop tripped) or an
// accounting anomaly is seen. Never throws.
function betAlert(msg) {
  console.error('[BET-ALERT] ' + msg);
  const text = '⚠️ SNAKE POT betting: ' + msg;
  if (ALERT_URL) {
    try {
      fetch(ALERT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(4000) }).catch(() => {});
    } catch (_) {}
  }
  ownerDm(text).catch(() => {});
}

// The two logical ledgers, read as integers (default 0). One hash → one round-trip.
async function readBetLedger() {
  const h = await kvHgetall(BET_LEDGER) || {};
  return {
    betLiability: Math.max(0, Math.floor(Number(h.betLiability) || 0)),
    accruedFee:   Math.max(0, Math.floor(Number(h.accruedFee)   || 0)),
  };
}

// Sum every outstanding player wager deposit (`pw:<addr>`), read-only, for the invariant's
// `wagerLiability` term. This is the term that guarantees in-game players can always cash out.
// Existing wager code is byte-for-byte untouched — we just observe it. Fail-CLOSED to a very large
// number on any KV error so a read failure can NEVER let a payout slip past the invariant.
async function sumWagerLiability() {
  const keys = await kvScan('pw:*');
  if (!keys.length) return 0;
  let total = 0;
  // chunk MGET to keep request bodies sane
  for (let i = 0; i < keys.length; i += 256) {
    const vals = await kvMget(keys.slice(i, i + 256));
    for (const v of vals) total += Math.max(0, Math.floor(Number(v) || 0));
  }
  return total;
}

// THE gate. Fetches live escrow balance + all liabilities and asks the pure engine whether paying
// `payoutLamports` now keeps escrow solvent for EVERYONE (players + bettors + house fee). Returns the
// invariant result plus the figures used, so callers can log/alert. Fail-closed on any error.
// Gold orbs a dead player's stake was converted into are STILL that money — the SOL sits in escrow and
// only whoever eats the orb can draw it out — but the victim's `pw:` is deleted the instant they die,
// so sumWagerLiability() cannot see a lamport of it. Parked orbs (a paid lobby that emptied) are the
// part we CAN count, and they must be counted, or a house-funded payout treats other players' money as
// spare change. Fail-CLOSED to MAX on a read error, same rule as sumWagerLiability.
async function sumParkedFoodLiability() {
  const keys = await kvScan('foodpark:*');
  if (!keys.length) return 0;
  let total = 0;
  for (let i = 0; i < keys.length; i += 64) {
    const vals = await kvMget(keys.slice(i, i + 64));
    for (const v of vals) {
      if (!v) continue;
      try {
        const p = JSON.parse(v);
        for (const o of (p && p.orbs) || []) total += Math.max(0, Math.floor(Number(o.lam) || 0));
      } catch (_) {}
    }
  }
  return total;
}

// `opts.protectPlayers` makes player deposits (and parked gold food) SENIOR to this payout — set it for
// every house-funded giveaway. See the seniority note in lib/betting.js checkInvariant.
async function assertSolvency(escPubkeyB58, payoutLamports, opts) {
  const protectPlayers = !!(opts && opts.protectPlayers);
  let onChainBalance = 0, wagerLiability = Number.MAX_SAFE_INTEGER, betLiability = 0, accruedFee = 0, parkedFood = 0;
  try {
    const bal = await rpc('getBalance', [escPubkeyB58, { commitment: 'confirmed' }]);
    onChainBalance = (bal && typeof bal.value === 'number') ? bal.value : (typeof bal === 'number' ? bal : 0);
    wagerLiability = await sumWagerLiability();
    if (protectPlayers) { parkedFood = await sumParkedFoodLiability(); wagerLiability += parkedFood; }
    const led = await readBetLedger();
    betLiability = led.betLiability; accruedFee = led.accruedFee;
  } catch (e) {
    // Any failure → keep wagerLiability at MAX so checkInvariant refuses. Never pay blind.
    return { ok: false, reason: 'solvency-read-failed:' + (e && e.message || e), onChainBalance, wagerLiability, betLiability, accruedFee, parkedFood };
  }
  const inv = BET.checkInvariant({ onChainBalance, wagerLiability, betLiability, accruedFee, payoutLamports, txFee: TX_FEE, protectPlayers });
  return { ...inv, onChainBalance, wagerLiability, betLiability, accruedFee, parkedFood };
}

// Verify a GAME_SECRET-HMAC server-to-server proof (same trust model as elim-lock / park-food).
// `payloadStr` is the exact string the game server signed. Uses the shared x-game-proof/x-game-ts headers.
function verifyGameProof(req, payloadStr) {
  if (!GAME_SECRET) return false;
  const gp  = (req.headers['x-game-proof'] || '').trim();
  const gts = Number(req.headers['x-game-ts'] || 0);
  if (!gp || !gts || Math.abs(Date.now() - gts) > 300000) return false;
  const expected = crypto.createHmac('sha256', GAME_SECRET).update(payloadStr).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) { return false; }
}

// Canonical string for a market descriptor — the game server signs this with GAME_SECRET so a client
// cannot invent a market, change its outcomes, or extend its betting window.
function marketCanon(m) {
  return 'betmkt:' + m.id + ':' + m.lobby + ':' + m.type + ':' + (Array.isArray(m.outcomes) ? m.outcomes.join(',') : '') + ':' + m.openTs + ':' + m.lockTs;
}
function verifyMarketDescriptor(m, sig) {
  if (!GAME_SECRET || !m || !sig) return false;
  const expected = crypto.createHmac('sha256', GAME_SECRET).update(marketCanon(m)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig))); } catch (_) { return false; }
}

// Confirm a bet deposit tx paid ≥ lamports into the escrow from walletAddress (mirrors join.js
// verifyWagerTx exactly — same escrow, same checks). Throws a descriptive error on any shortfall.
async function verifyBetDepositTx(txSig, walletAddress, lamports, escrowB58) {
  // Did ANY node actually answer us? "the chain says this tx isn't there yet" and "we never got to
  // ask" both end this loop the same way, but they are completely different events: the first is the
  // ordinary state of a transfer a second old, the second is an outage. The caller turns this
  // distinction into the HTTP status, so a normal pending ante stops being counted as a server error
  // while a real RPC failure still is. Without it, an outage hides inside routine retry traffic.
  let answered = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    let tx;
    try { tx = await rpcFound('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); answered = true; }
    catch (_) { continue; } // transient RPC error — retry
    if (!tx) continue;      // not indexed yet — retry
    if (tx.meta && tx.meta.err) throw new Error('Deposit tx failed on-chain');
    const keys = tx.transaction.message.accountKeys;
    const getKey = k => (typeof k === 'string' ? k : k.pubkey);
    const escrowIdx = keys.findIndex(k => getKey(k) === escrowB58);
    if (escrowIdx < 0) throw new Error('Escrow not found in deposit tx');
    const received = tx.meta.postBalances[escrowIdx] - tx.meta.preBalances[escrowIdx];
    if (received < lamports) throw new Error('Deposit too small: got ' + received + ' need ' + lamports);
    const senderIdx = keys.findIndex(k => getKey(k) === walletAddress);
    if (senderIdx < 0) throw new Error('Sender not found in deposit tx');
    return; // verified ✓
  }
  // The flag rides on the Error rather than in its text: five other call sites surface `e.message`
  // straight to a player, and none of them should grow a marker they have to strip.
  if (answered) {
    const e = new Error('Deposit not confirmed yet — try again in a moment');
    e.pending = true;                 // read by the bj-deposit catch to pick the HTTP status
    throw e;
  }
  throw new Error('Deposit could not be checked — no Solana RPC answered. Your SOL is safe; try again.');
}

// Enumerate every individual bet on a market. Keys are `bet:<mkt>:<outcome>:<addr>` → lamports.
// Returns { pools:{outcome:lamports}, stakesByOutcome:{outcome:{addr:lamports}}, allStakes:{addr:lamports}, bettors:Set }.
async function loadMarketBets(mktId) {
  const prefix = 'bet:' + mktId + ':';
  const keys = await kvScan(prefix + '*');
  const pools = {}, stakesByOutcome = {}, allStakes = {}, byKey = {};
  if (keys.length) {
    for (let i = 0; i < keys.length; i += 256) {
      const slice = keys.slice(i, i + 256);
      const vals = await kvMget(slice);
      for (let j = 0; j < slice.length; j++) {
        const k = slice[j];
        const lamps = Math.max(0, Math.floor(Number(vals[j]) || 0));
        if (lamps <= 0) continue;
        const rest = k.slice(prefix.length);           // "<outcome>:<addr>"
        const ci = rest.lastIndexOf(':');
        if (ci < 0) continue;
        const outcome = rest.slice(0, ci);
        const addr    = rest.slice(ci + 1);
        pools[outcome] = (pools[outcome] || 0) + lamps;
        (stakesByOutcome[outcome] = stakesByOutcome[outcome] || {})[addr] = (stakesByOutcome[outcome][addr] || 0) + lamps;
        allStakes[addr] = (allStakes[addr] || 0) + lamps;
        byKey[k] = { outcome, addr, lamps };
      }
    }
  }
  return { pools, stakesByOutcome, allStakes, byKey };
}

// Pay a set of { addr, lamports } recipients from escrow, in batches that fit one Solana tx, asserting
// the solvency invariant before EACH batch and claiming per-bettor NX single-pay locks so a retry (or a
// double-fired resolve) can never pay anyone twice. Decrements betLiability by exactly what is paid.
// Returns { paid, refused, txs, stranded } — stranded>0 means the invariant blocked some payouts
// (money stays safely in escrow; the alert fires). NEVER pays from anything but the caller's amounts.
async function payBetRecipients(esc, mktId, recipients, tag) {
  const BATCH = 12; // recipients per tx (well within Solana's account/size limits)
  let paidLamports = 0, refused = 0, txs = [], stranded = 0;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH).filter(r => r && r.lamports > 0);
    if (!batch.length) continue;

    // Claim each bettor with an NX lock so concurrent/replayed resolves cannot double-pay them.
    const claimed = [];
    for (const r of batch) {
      const claim = await kvSetNX('betpaid:' + mktId + ':' + r.addr, '1', BET_MKT_TTL);
      if (claim) claimed.push(r); // only pay first-claimers; already-claimed = already paid/being paid
    }
    if (!claimed.length) continue;

    const batchTotal = claimed.reduce((a, r) => a + r.lamports, 0);
    // INVARIANT — the backstop. Refuse if paying this batch would strand any player or bettor.
    const inv = await assertSolvency(esc.pubkeyB58, batchTotal);
    if (!inv.ok) {
      // release the claims so a later (funded) retry can still pay them; leave the money in escrow.
      for (const r of claimed) await kvDel('betpaid:' + mktId + ':' + r.addr).catch(() => {});
      stranded += claimed.length;
      betAlert('invariant REFUSED ' + tag + ' market=' + mktId + ' batchTotal=' + batchTotal +
               ' bal=' + inv.onChainBalance + ' wagerLiab=' + inv.wagerLiability + ' betLiab=' + inv.betLiability +
               ' fee=' + inv.accruedFee + ' deficit=' + (inv.deficit || 'n/a'));
      break; // stop — do not attempt further batches once solvency is in question
    }

    try {
      const { blockhash } = await fetchBalAndHash(esc.pubkeyB58);
      const transfers = claimed.map(r => ({ to: b58Decode(r.addr), lamports: r.lamports }));
      const tx = buildTx(esc, blockhash, transfers);
      const result = await sendAndConfirm(tx);
      txs.push(result.sig);
      // Retire liability only for what we actually sent.
      await kvHincrby(BET_LEDGER, 'betLiability', -batchTotal).catch(() => {});
      // The Solana network fee for this transfer is absorbed by the house's 8% (accruedFee), NOT by a
      // cushion — this is what lets betting run from an empty escrow. Decrement the fee ledger so it
      // stays honest (a future owner sweep never claims fee that was already spent on network costs).
      await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
      paidLamports += batchTotal;
    } catch (e) {
      // Send failed — release the claims so this batch can be retried on the next resolve call.
      for (const r of claimed) await kvDel('betpaid:' + mktId + ':' + r.addr).catch(() => {});
      refused += claimed.length;
      console.error('[bet] ' + tag + ' batch send failed market=' + mktId + ' — ' + (e && e.message || e));
      // keep going: other batches may still succeed; the caller/game-server retries the rest.
    }
  }
  return { paidLamports, refused, txs, stranded };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── P2P BETTING EXCHANGE — player-vs-player, even money, platform never takes a side ──
// ══════════════════════════════════════════════════════════════════════════════
// Creator stakes S on one side; an opponent stakes the SAME S on the other. Pot = 2S in escrow.
// Winner receives 2S − 8%. Unmatched → creator refunded 100%, no fee. The platform holds escrow,
// matches, settles from authoritative game truth, and takes 8% of COMPLETED wagers only.
//
// KV schema:
//   wg:<id>            JSON wager record
//   wgopen:<lobbyKey>  ZSET(createdTs) of wager ids currently OPEN (the public order book)
//   wglive:<lobbyKey>  ZSET(createdTs) of MATCHED wagers still awaiting settlement
//   wgu:<address>      ZSET(createdTs) of every wager a user is party to (their bet slip)
//   lock:wg:<id>       NX mutex around accept/settle/cancel (race guard)
//   wgpaid:<id>        NX single-pay marker (a settled wager can never pay twice)
//   wgtx:<txSig>       deposit replay guard
const P2P = require('../lib/p2pbet');
const WG_TTL       = 604800;   // wager records live 7 days (history)
// wgpaid: is an in-flight payment LOCK, not proof of payment. The authoritative "already paid"
// record is the wager's own status (settled/returned), which every payer checks FIRST. Giving this a
// 7-day TTL meant a single attempt that died between claiming it and paying (Vercel freeze, crash)
// blocked every future payout forever and stranded the stake. Short TTL = self-releasing.
const WG_PAY_LOCK_TTL = 180;

/*
 * How long a new wager stays takeable before it is returned UNMATCHED, in full, with no fee.
 *
 * OWNER 2026-07-31: 60s → 5 minutes ("refund in 5 mins if no one bets on the other side"; briefly set
 * to 15 before they settled on 5). A minute was not long enough for anyone to actually see a bet and
 * take it, so bets kept dying unmatched — the refund worked, the MARKET didn't.
 *
 * ⚠️ This is the UNMATCHED clock only. A MATCHED bet that the game never resolved is a different
 * case on a different timer — WG_VOID_AFTER_MS, which the owner has confirmed stays at ONE HOUR.
 * Do not collapse the two: voiding a matched bet early takes money off a duel whose players are
 * legitimately still alive.
 *
 * Safe to lengthen despite the wider outcome-sniping surface: the anti-snipe guard is on RESERVE, not
 * on create. A taker must hold a roster signature issued within WG_SIG_MAX_AGE_MS, and the game server
 * only signs snakes that are currently ALIVE — so a wager whose subject has already died or cashed out
 * simply cannot be taken, however long it has been on the book. It sits unmatched and refunds here.
 */
const WG_OPEN_WINDOW_MS = 300000;   // 5 minutes
const WG_RESERVE_MS = 90000;   // an acceptor has 90s to land their deposit before the claim expires
// A matched wager that the game never resolved is VOIDED after this long and both stakes are
// returned in full with no fee. Owner's call at 1h: long enough that no real round is still running,
// short enough that nobody's money is held overnight. This is what stops a duel that never got its
// decisive kill (third-party kill, someone left, a settle POST that failed) from stranding funds.
const WG_VOID_AFTER_MS = 3600000;
const WG_MIN_STAKE = 1_000_000;      // 0.001 SOL floor
const WG_MAX_STAKE = 100_000_000_000; // 100 SOL ceiling (sanity)

function wgLobbyKey(region, lobby) { return String(region || 'NA') + ':' + String(lobby || ''); }
async function wgLoad(id) {
  try { const raw = await kvGet('wg:' + id); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
async function wgSave(w) { await kvSet('wg:' + w.id, JSON.stringify(w), WG_TTL); return w; }

// Owner's explicit call: a wager that fails to pay out ONCE stops being touched automatically, forever
// — never retried by the game server's tick, never retried by wager-sweep. Reason: the owner refunds
// failures by hand, and an automatic retry succeeding LATER (after they already paid manually) would
// double-pay the same player. One real attempt, then a permanent stop, is safer than silent retries.
async function wgIsHeld(id) { return !!(await kvGet('wgheld:' + id)); }
async function wgSetHeld(id, reason) { await kvSetPerm('wgheld:' + id, String(reason || 'payout failed').slice(0, 200)).catch(() => {}); }

/*
 * THE ONE REFUND THAT MUST ALWAYS WORK: returning an UNMATCHED bet slip.
 *
 * Owner's rule, stated explicitly: the only time anyone gets money back is a bet slip nobody took the
 * other side of — in snake AND in kart races, because every bet slip here is player-vs-player, not
 * player-vs-house. A bet that never matched never became a bet, so the stake is simply still theirs.
 *
 * That collided with the blanket "bets never auto-retry" rule (`wgheld:`), which exists so the owner is
 * never asked to pay twice after an ambiguous payout. A return blocked by that rule is a player's own
 * unmatched stake locked in escrow permanently — prod was logging exactly this:
 * `[wg] settle REFUSED … {"error":"refund held: insolvent"}`.
 *
 * The two cases are cleanly distinguishable, so they no longer share a policy. wgPayOne refuses on
 * `'insolvent'` from the solvency gate BEFORE it builds or sends any transaction — nothing left escrow,
 * so retrying cannot double-pay. Every other failure comes from send/confirm and IS ambiguous.
 *
 *   insolvent  -> retryable. Do not hold; the next sweep picks it up once escrow can cover it.
 *   anything else -> hold, exactly as before. The owner settles it by hand.
 *
 * `wgpaid:<id>` (claimed before the transfer) remains the single-pay guard either way.
 */
function wgRetryableFail(reason) { return String(reason || '').toLowerCase().includes('insolvent'); }

// True only for a hold that is safe to retry — i.e. one recorded because escrow was momentarily short.
async function wgHeldRetryable(id) {
  const r = await kvGet('wgheld:' + id);
  return !!r && wgRetryableFail(r);
}
// Clear a retryable hold so the return can be attempted again. Never call this for a settlement.
async function wgClearHeld(id) { await kvDel('wgheld:' + id).catch(() => {}); }

// The game server signs each bettable snake so a client cannot invent a subject that could never
// settle. Mirrors the elim-lock trust model: HMAC over region+lobby+pid+name+ipHash+expiry.
// ipHash lets us catch a player betting on their own snake from a second account (see wgSelfBetCheck).
function verifySnakeSig(region, lobby, pid, name, ipHash, expTs, sig) {
  if (!GAME_SECRET || !sig) return false;
  if (!(Number(expTs) > Date.now())) return false;                 // roster entry expired
  // ⚠️ The NAME IS NOT SIGNED (v2). This proof only has to establish "this pid is a live snake in
  // this arena" — the display name is cosmetic and MUTABLE. Binding it meant that the moment a
  // player renamed, or their name reset to the default "SNAKE" mid-session, every signature they
  // had stopped verifying: their snake silently failed validation, a duel's opponent never got
  // recorded, and the wager could never settle. Names change; wallet ids do not.
  //
  // v1 (name included) is still accepted so a game server that has not been redeployed yet keeps
  // working — remove that fallback once both nodes are on the nameless signature.
  const mk = c => crypto.createHmac('sha256', GAME_SECRET).update(c).digest('hex');
  const v2 = 'snake:' + region + ':' + lobby + ':' + pid + ':' + (ipHash || '') + ':' + expTs;
  const v1 = 'snake:' + region + ':' + lobby + ':' + pid + ':' + (name || '') + ':' + (ipHash || '') + ':' + expTs;
  const given = Buffer.from(String(sig));
  for (const canon of [v2, v1]) {
    try { if (crypto.timingSafeEqual(Buffer.from(mk(canon)), given)) return true; } catch (_) {}
  }
  return false;
}


// ── ANTI-SNIPE: the subject must still be IN THE ARENA at the moment you take the bet ──────────
// The game server only signs snakes that are currently alive (wgBettableSnakes filters on sn.alive)
// and re-signs the whole roster every 4s with a fresh expiry. So "holds a roster signature issued
// seconds ago" is a proof that the snake has not yet died or cashed out.
//
// Why this is needed: verifySnakeSig alone only asserts `exp > now`, and an entry stays valid for
// WG_ROSTER_TTL (180s) — while a wager is takeable for 60s. Nothing re-checked the subject after
// CREATE, so an already-decided wager could be taken for free:
//     Alice posts "VIPER cashes out — YES". VIPER dies 10s later. The wager is still open.
//     Bob takes the NO side and collects 1.84x at zero risk.
// That needs no collusion and no rigging, just watching — so it is enforced on RESERVE (the gate
// before any money moves), for every subject of every type.
//
// TTL_MIRROR must match WG_ROSTER_TTL in the game server. If they ever diverge this only becomes
// STRICTER (a smaller server TTL means fewer signatures qualify), never permissive, so a mismatch
// cannot open the hole back up — it would just reject takes until corrected.
const WG_ROSTER_TTL_MIRROR = 180000;
const WG_SIG_MAX_AGE_MS    = 25000;   // roster re-signs every ~4s, so 25s is generous slack
function isFreshSnakeSig(region, lobby, pid, name, ipHash, expTs, sig) {
  if (!verifySnakeSig(region, lobby, pid, name, ipHash, expTs, sig)) return false;
  const issuedAt = Number(expTs) - WG_ROSTER_TTL_MIRROR;
  return (Date.now() - issuedAt) <= WG_SIG_MAX_AGE_MS;
}

// Stable, privacy-preserving fingerprint of the caller's IP. Same secret on the game server, so the
// same network produces the same hash on both sides — raw IPs are never stored.
function clientIpHash(req) {
  try {
    const xf = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (!xf || !GAME_SECRET) return '';
    return crypto.createHmac('sha256', GAME_SECRET).update('ip:' + xf).digest('hex').slice(0, 16);
  } catch (_) { return ''; }
}

// ── RIG GUARD (directional) ───────────────────────────────────────────────────
// A player uses their ONE game wallet for everything and MAY back their own snake to succeed —
// they can't guarantee a win (anyone can kill them), and it only makes them play harder. What they
// may never do is take a side that pays out when a snake THEY CONTROL performs badly, because that
// is riggable: drive into a wall and collect. lib/p2pbet.js#riggableSubjects decides which snakes
// must fail for a side to win; we then check whether the bettor controls any of them, by:
//   1. Identity — a snake's pid IS its wallet address, so `subject === bettor` is exact.
//   2. Network — same hashed network as that snake ⇒ almost certainly the same person on an alt.
//      (This is also what stops "back A to outlast B" when B is your own sacrificial alt.)
// Returns an error string to reject with, or null to allow.
async function wgRigCheck({ bettor, typeId, side, subject, subject2, subjectIpHash, subject2IpHash, req }) {
  const mustFail = P2P.riggableSubjects(typeId, side, subject, subject2).filter(Boolean);
  if (!mustFail.length) return null;                 // backing a snake to SUCCEED — never riggable
  const ipOf = {};
  if (subject)  ipOf[subject]  = subjectIpHash  || '';
  if (subject2) ipOf[subject2] = subject2IpHash || '';
  const myIp = clientIpHash(req);
  for (const s of mustFail) {
    if (s === bettor) {
      return 'You can back your own snake to win, but not to lose — take the other side';
    }
    if (myIp && ipOf[s] && ipOf[s] === myIp) {
      // Count it so a pattern stays visible even if they later switch networks.
      try {
        const k = 'wgselfhit:' + bettor;
        await kvIncrby(k, 1); await kvExpire(k, 604800);
        betAlert('rig attempt blocked (same network) bettor=' + String(bettor).slice(0, 8) +
                 ' mustFail=' + String(s).slice(0, 8) + ' type=' + typeId + ' side=' + side);
      } catch (_) {}
      return 'You cannot bet on a snake from your own network losing';
    }
  }
  return null;
}

// Push a live update to everyone watching that arena, via the game server's websocket (no polling).
//
// ⚠️ MUST BE AWAITED. This was fire-and-forget and that is exactly why other players never saw a new
// bet appear: Vercel can freeze/kill the function the instant the response is sent, so an un-awaited
// fetch is a coin flip on whether it is even dispatched (api/join.js carries the same warning about
// un-awaited background writes). Awaiting costs a few hundred ms on the bettor's own request but is
// what makes the bet show up for everyone else immediately.
//
// The wager is already committed to KV before this runs, so a push that still fails (game server
// down/slow) only means a briefly stale list — the periodic roster digest re-syncs it within ~4s.
async function wgPush(region, lobby, event, wager) {
  if (!GAME_SECRET) return false;
  try {
    const ts = Date.now();
    const proof = crypto.createHmac('sha256', GAME_SECRET).update('wager-event:' + lobby + ':' + ts).digest('hex');
    const base = String(region).toUpperCase() === 'EU' ? 'https://eu.pac-arena.com' : 'https://us.pac-arena.com';
    const r = await fetch(base + '/wager-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-proof': proof, 'x-game-ts': String(ts) },
      body: JSON.stringify({ lobby, event, wager }),
      signal: AbortSignal.timeout(2500),   // bounded so a slow node can't stall the bettor's response
    });
    if (!r.ok) console.warn('[wg] push ' + event + ' -> HTTP ' + r.status);
    return r.ok;
  } catch (e) {
    console.warn('[wg] push ' + event + ' failed: ' + (e && e.message || e));
    return false;
  }
}

// Pay exactly one recipient, gated by the global solvency invariant. Used for winner payouts,
// cancellations, returns and the "your deposit couldn't be matched" refund. Never sizes from balance.
/* ⚠️ `mayHavePaid` ON EVERY FAILURE RESULT — read this before using `!r.ok` to release a pay-lock.
 *
 * A caller that takes an NX pay-lock and DELETES it whenever this returns !ok is assuming !ok means
 * "no lamports moved". That is not true of every failure, and the difference is a double payment.
 *
 *   mayHavePaid: false — nothing was broadcast, or it landed and was REJECTED, so escrow is untouched
 *                        and retrying is not just safe but the point (the usual case is an unfunded
 *                        float: fund it, run again, the winner gets paid once).
 *   mayHavePaid: true  — the submit call itself failed, and a transport error is indistinguishable from
 *                        a LOST RESPONSE to a transaction that is already in the mempool. It may well
 *                        land. Releasing the lock here is what pays somebody twice.
 *
 * This is not hypothetical: the Recruiter-of-the-Week prize was paid TWICE for one week. Its single
 * `recpaid:<week>` lock was deleted on any !ok, and the trigger was an UNAUTHENTICATED board read every
 * client fired when the referral panel opened — so a lost response was retried within seconds by the
 * next player to look. Both the board trigger and that contest are now gone, but the lock-releasing
 * half of the bug is what this flag exists to fix. Note that an unconfirmed-but-broadcast send already
 * returns ok:true (see sendAndConfirm's 12s path), so the lock is correctly KEPT in that case.
 */
async function wgPayOne(esc, toAddr, lamports, tag, opts) {
  const amt = Math.floor(Number(lamports) || 0);
  if (!(amt > 0)) return { ok: false, mayHavePaid: false, reason: 'nothing to pay' };
  const inv = await assertSolvency(esc.pubkeyB58, amt, opts);
  if (!inv.ok) {
    betAlert('invariant REFUSED ' + tag + ' to=' + String(toAddr).slice(0, 8) + ' amt=' + amt +
             ' bal=' + inv.onChainBalance + ' wagerLiab=' + inv.wagerLiability + ' betLiab=' + inv.betLiability +
             ' fee=' + inv.accruedFee + ' deficit=' + (inv.deficit || 'n/a'));
    return { ok: false, mayHavePaid: false, reason: 'insolvent', inv };
  }
  // Only a throw from sendAndConfirm is ambiguous. Everything before it — fetching a blockhash, encoding
  // the recipient, building the transaction — fails with nothing on the wire, and treating those as
  // "might have paid" would hold a lock (needing a manual clear) over a transient RPC blip or a bad
  // address. So the flag is armed at the last possible moment.
  let sendStarted = false;
  try {
    const { blockhash } = await fetchBalAndHash(esc.pubkeyB58);
    const tx = buildTx(esc, blockhash, [{ to: b58Decode(toAddr), lamports: amt }]);
    sendStarted = true;
    const result = await sendAndConfirm(tx);
    return { ok: true, mayHavePaid: true, sig: result.sig, confirmed: result.confirmed };
  } catch (e) {
    const msg = (e && e.message) || 'send failed';
    console.error('[wg] payout failed ' + tag + ' — ' + msg);
    // 'TX rejected on-chain' is thrown only after getSignatureStatuses reports an on-chain error: the
    // transaction was included and FAILED, so no transfer happened and escrow is untouched. Any other
    // throw once the send has begun could be a lost response to a tx already in the mempool.
    return { ok: false, mayHavePaid: sendStarted && !msg.startsWith('TX rejected on-chain'), reason: msg };
  }
}

// Pay the winner AND send the platform's 8% to the fee wallet in ONE transaction.
// The fee does NOT sit in escrow. Escrow is the GAME wallet and should only ever hold what is
// actually owed to players and bettors; the platform cut belongs in the same fee wallet the 10%
// cashout fee goes to (CREATOR_WALLET). Doing both transfers in a single tx makes it atomic (the
// fee can never be stranded or double-swept) and costs one network fee instead of two.
// Carries `mayHavePaid` on every failure for the same reason wgPayOne does — see the note there. Every
// caller of this function also takes a pay-lock, so the same rule applies: release it only when nothing
// can have moved.
async function wgPayWinnerAndFee(esc, winner, payout, fee, tag) {
  const win = Math.floor(Number(payout) || 0);
  const cut = Math.max(0, Math.floor(Number(fee) || 0));
  if (!(win > 0)) return { ok: false, mayHavePaid: false, reason: 'nothing to pay' };
  const inv = await assertSolvency(esc.pubkeyB58, win + cut);
  if (!inv.ok) {
    betAlert('invariant REFUSED ' + tag + ' to=' + String(winner).slice(0, 8) + ' win=' + win + ' fee=' + cut +
             ' bal=' + inv.onChainBalance + ' betLiab=' + inv.betLiability + ' deficit=' + (inv.deficit || 'n/a'));
    return { ok: false, mayHavePaid: false, reason: 'insolvent', inv };
  }
  // Armed immediately before the send — see the same flag in wgPayOne.
  let sendStarted = false;
  try {
    const { bal, blockhash } = await fetchBalAndHash(esc.pubkeyB58);
    // ── KEEP ESCROW RENT-VALID, AND NOTHING MORE ────────────────────────────────────────────────
    // Solana requires a system account to hold >= RENT_MIN (890880 lamports) or be exactly 0 — land
    // it anywhere in between and the transfer is rejected outright (InsufficientFundsForRent). So
    // escrow must retain RENT_MIN plus this tx's 5000-lamport network fee. That is the ENTIRE
    // structural requirement; no buffer beyond it is kept.
    //
    // If the sweep would breach that floor, the FEE is trimmed — never the winner's payout. The
    // winner is owed their money; the platform cut is what should absorb the shortfall.
    const spendable = bal - RENT_MIN - TX_FEE;          // most we can move and stay rent-valid
    // The rake absorbs this tx's ~5000-lamport network fee so escrow's net outflow equals exactly the
    // pot (winner + fee), keeping it self-funding — no operator top-ups. The winner is never reduced.
    let feeCut = Math.max(0, cut - TX_FEE);
    if (win > spendable) {
      // Can't even cover the winner while staying rent-valid — refuse rather than send a doomed tx.
      // Nothing was built, let alone sent, so this is safe to retry once escrow is topped up.
      return { ok: false, mayHavePaid: false, reason: 'insufficient escrow for a rent-valid payout' };
    }
    if (win + feeCut > spendable) {
      feeCut = Math.max(0, spendable - win);
      console.warn('[wg] ' + tag + ' fee trimmed ' + cut + ' -> ' + feeCut + ' to keep escrow rent-exempt');
    }
    const transfers = [{ to: b58Decode(winner), lamports: win }];
    if (feeCut > 0) transfers.push({ to: b58Decode(CREATOR_WALLET), lamports: feeCut });
    const tx = buildTx(esc, blockhash, transfers);
    sendStarted = true;
    const result = await sendAndConfirm(tx);
    return { ok: true, mayHavePaid: true, sig: result.sig, confirmed: result.confirmed, feeSent: feeCut };
  } catch (e) {
    const msg = (e && e.message) || 'send failed';
    console.error('[wg] ' + tag + ' payout failed — ' + msg);
    // Same classification as wgPayOne: nothing on the wire before the send, and only an on-chain
    // rejection proves no lamports moved once it has begun.
    return { ok: false, mayHavePaid: sendStarted && !msg.startsWith('TX rejected on-chain'), reason: msg };
  }
}

/* ── THE ONE PLACE THE PAY-LOCK RELEASE RULE LIVES ────────────────────────────────────────────────
 *
 * Every payout path takes an NX lock so it can run at most once, and every one of them used to delete
 * that lock on any failure. That is correct when the money definitely did not move and catastrophic
 * when it might have — it is how a Recruiter-of-the-Week prize went out twice for one week.
 *
 * Hand-copying this decision to fourteen call sites is the shape that has already bitten this codebase
 * repeatedly (three copies of RECRUIT_ANCHOR silently disagreeing). So it is a function, and the answer
 * comes from `mayHavePaid` on the payout result rather than from `!ok`.
 *
 * Returns TRUE if the lock was released (the caller may safely advertise a retry) and FALSE if it is
 * being HELD. Callers that answer a self-retrying client MUST pass this through as `retry`, or the
 * client will hammer a lock that is never going to open.
 */
/* TRUE only when a THROWN payout error proves no lamports moved.
 *
 * sendAndConfirm throws exactly two ways: 'TX rejected on-chain' (the transaction was included and
 * FAILED — a rejected SystemProgram transfer moves nothing) and 'Send failed: …' out of the submit call,
 * where a transport error is indistinguishable from a LOST RESPONSE to a transaction already in the
 * mempool. Only the first is proof.
 *
 * ⚠️ This exists because a comment in the cashout path asserted the opposite — that sendAndConfirm
 * "only throws on a failed broadcast or a tx rejected on-chain, and in BOTH cases no SOL left escrow".
 * The second half is true; the first is not, and the code restored the player's `pw:` wager on that
 * basis, so a lost response let them cash the same wager out twice. Same family as the wrong comment
 * that broke build placement: a confident comment is not a proof.
 */
function throwProvesUnpaid(err) {
  return String((err && err.message) || err || '').startsWith('TX rejected on-chain');
}

/* ── A PAY-FLAG MUST RECORD COMPLETION, NOT INTENT ───────────────────────────────────────────────
 *
 * Every payout path claims an NX flag (`bjpaid:`, `cfpaid:`, `kartpaid:`, `evtpaid:`) and then sends. The
 * flag was written as the placeholder `'1'` BEFORE the transfer, and a caller that found it already held
 * was told `{ok:true, already:true}` — success.
 *
 * So if the function died in between — Vercel's 60s maxDuration, a cold-start kill, any crash — the
 * money never left, the flag survived, and every retry reported the winner as already paid. The pot sat
 * in escrow as unattributed surplus and nobody was told. Reported as blackjack, kart and kill rewards
 * "not paying at times", with ~$10 unexplained in escrow.
 *
 * Now the flag carries its state: `claimed:<ts>` while a payout is in flight, `sig:<signature>` once SOL
 * has actually moved. A flag found in `claimed:` is a payout that never finished — UNRESOLVED, alerted,
 * and NOT reported as success.
 *
 * ⚠️ Legacy `'1'` is read as PAID. Real keys written by the old code are still in KV, most of them from
 * genuinely completed payouts, and calling those unresolved would alert on every one. Treating them as
 * paid keeps exactly the old behaviour for them and nothing worse; they expire with the 24h TTL, after
 * which detection is complete. `'sealed'` is bj-audit's quarantine marker and also means "never pay".
 */
const PAY_FLAG_TTL = 86400;
async function claimPayFlag(key, ttl) {
  if (await kvSetNX(key, 'claimed:' + Date.now(), ttl || PAY_FLAG_TTL)) return { claimed: true };
  const cur = String((await kvGet(key).catch(() => '')) || '');
  // Anything that is not an in-flight claim counts as settled: a real signature, the audit's seal, or a
  // legacy placeholder.
  return { claimed: false, paid: !cur.startsWith('claimed:'), value: cur };
}
// Called ONLY after a transfer has actually gone out. This is what turns a claim into proof of payment.
async function markPayFlagPaid(key, sig, ttl) {
  await kvSet(key, 'sig:' + String(sig || 'ok'), ttl || PAY_FLAG_TTL).catch(() => {});
}
// A claim that never completed. Alerts with the amount so it can be settled by hand, and tells the
// caller plainly that it is NOT paid — the silent `already: true` is what hid this for so long.
function unresolvedPayFlag(key, who, lamports, tag) {
  betAlert('PAYOUT NEVER COMPLETED ' + tag + ' -> ' + String(who).slice(0, 8) + ' amount=' + lamports +
           ' — a previous attempt claimed ' + key + ' and then died before the transfer finished, so this ' +
           'was never paid and the money is still in escrow. Verify on-chain, pay by hand if it never ' +
           'arrived, then DEL ' + key + '.');
}

async function releasePayLock(key, r, tag) {
  if (r && r.mayHavePaid) {
    betAlert('payout UNCERTAIN ' + tag + ' : ' + ((r && r.reason) || '') + ' — the transaction MAY have ' +
             'landed. Pay-lock ' + key + ' is HELD so it cannot pay twice. Check the destination wallet ' +
             'on-chain; clear the lock ONLY if the money never arrived.');
    return false;
  }
  await kvDel(key).catch(() => {});
  return true;
}

// Public-safe projection of a wager (never leaks internal reservation details).
function wgPublic(w) {
  if (!w) return null;
  return {
    id: w.id, lobby: w.lobby, region: w.region, type: w.type, duel: !!w.duel,
    subject: w.subject, subjectName: w.subjectName, subject2: w.subject2, subject2Name: w.subject2Name,
    side: w.side, takerSide: P2P.opposingSide(w.type, w.side),
    stake: w.stakeLamports, potentialWin: P2P.potentialWin(w.stakeLamports),
    creator: w.creator, creatorName: w.creatorName, acceptor: w.acceptor, acceptorName: w.acceptorName,
    status: w.status, createdTs: w.createdTs, lockTs: w.lockTs, durationMs: w.durationMs,
    winningSide: w.winningSide || null, winner: w.winner || null,
    payout: w.payout || 0, fee: w.fee || 0, payoutTx: w.payoutTx || null, settledTs: w.settledTs || null,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  let done = false;
  const guard = setTimeout(() => {
    if (!done) { done = true; try { res.status(500).json({ error: 'Timed out — try again' }); } catch (_) {} }
  }, 55000);

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-settle-sig, x-settle-ts');
    if (req.method === 'OPTIONS') { clearTimeout(guard); done = true; return res.status(200).end(); }
    if (req.method !== 'POST')   { clearTimeout(guard); done = true; return res.status(405).end(); }

    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};

    const { action, playerAddress, lobbyId } = body;
    const wagerLamportsRaw = Number(body.wagerLamports) || 0;
    // Leaderboard stats are scoped per-game so Slither Snakes and Pac-Man never mix,
    // even for a wallet that plays both. ss-* lobbyId = Slither Snakes, else Pac-Man.
    const game = (lobbyId && lobbyId.startsWith('ss-')) ? 'ss' : 'pac';

    // ── elim-lock: game server calls this immediately on kill to block victim cashout ──
    // Also the ONLY trustworthy place to record the killer's elimination stat: the snake game
    // pays kills via dropped food (action:'kill' never fires for ss), so without this the
    // leaderboard KILLS column sat at 0 for everyone. killerAddress rides the same
    // GAME_SECRET-HMAC'd server-to-server call, so clients can't inflate it.
    if (action === 'elim-lock') {
      const { victimAddress, killerAddress } = body;
      // Auth: EITHER the admin secret, OR — for the game server, which has GAME_SECRET but not
      // ADMIN_SECRET — a GAME_SECRET-HMAC proof over victim+timestamp (same secret that signs kill
      // proofs). Either proves the caller is our own infrastructure. Without this the dead-flag silently
      // 403'd (game server had no ADMIN_SECRET), so killed players were never blocked from cashing out
      // → double-spend / escrow shortfall. Fail-closed if neither credential validates.
      const adminSec  = (req.headers['x-admin-secret'] || '').trim();
      const serverSec = (process.env.ADMIN_SECRET || '').trim();
      let authed = !!(adminSec && serverSec && adminSec === serverSec);
      if (!authed && GAME_SECRET && victimAddress) {
        const gp  = (req.headers['x-game-proof'] || '').trim();
        const gts = Number(req.headers['x-game-ts'] || 0);
        if (gp && gts && Math.abs(Date.now() - gts) < 300000) {
          // New form binds the killer into the proof; old form kept so not-yet-updated game
          // servers stay authed during rollout (proofs never leave our own infra either way).
          const expectedNew = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victimAddress + ':' + (killerAddress || '') + ':' + gts).digest('hex');
          const expectedOld = crypto.createHmac('sha256', GAME_SECRET).update('elim-lock:' + victimAddress + ':' + gts).digest('hex');
          try { authed = crypto.timingSafeEqual(Buffer.from(expectedNew), Buffer.from(gp)); } catch (_) {}
          if (!authed) { try { authed = crypto.timingSafeEqual(Buffer.from(expectedOld), Buffer.from(gp)); } catch (_) {} }
        }
      }
      if (!authed) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (!victimAddress || typeof victimAddress !== 'string' || victimAddress.length < 20) {
        clearTimeout(guard); done = true;
        return res.status(400).json({ error: 'victimAddress required' });
      }
      // Set dead flag (blocks cashout) and atomically delete their wager record simultaneously
      await Promise.all([
        kvSet('dead:' + victimAddress, '1', 600),
        kvGetDel('pw:' + victimAddress),
      ]).catch(() => {});
      // Record the killer's elimination — paid lobbies only (matches every other leaderboard
      // stat: "wagered lobbies only"), never bots, never self-kills.
      if (killerAddress && typeof killerAddress === 'string' && killerAddress.length >= 20 &&
          killerAddress !== victimAddress && killerAddress.indexOf('bot-') !== 0 &&
          lobbyId && lobbyId.indexOf('paid') !== -1) {
        try { await kvHincrby('ph:' + game + ':' + killerAddress, 'kills', 1); } catch (_) {}
        // Bounty Hour: if a scheduled kill-event is live right now, this paid kill also scores on the
        // event board. Same trust path as the all-time stat above (GAME_SECRET-authed, paid, non-bot).
        try { const _ev = activeKillEvent(); if (_ev) await kvHincrby('evtk:' + _ev.id, killerAddress, 1); } catch (_) {}
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
    }

    // ── event-board: live / just-ended Bounty-Hour kill standings (unsigned read — the numbers are
    // built only from GAME_SECRET-authed elim-lock kills, so exposing them read-only is safe). ──────
    if (action === 'event-board') {
      const now = Date.now();
      /* Two INDEPENDENT things, deliberately: `state`/`top` is the board being played or the one that
       * was last played (its final standings stay up indefinitely — that is the results board), and
       * `next` is the next SCHEDULED event, or null when the operator hasn't scheduled one.
       *
       * `state` is never 'upcoming' any more. It used to roll the ended board forward into a countdown
       * after 24h, which meant the last event's results disappeared and the homescreen advertised an
       * event that only existed because the schedule generated it. Results and announcements are now
       * separate fields, so one can never overwrite the other. */
      let ev = activeKillEvent(now), state = 'live';
      if (!ev) {
        const past = killEvents().filter(e => now >= e.end).sort((a, b) => b.end - a.end)[0];
        if (past) { ev = past; state = 'ended'; }
      }
      const nextEv = killEvents().filter(e => e.start > now).sort((a, b) => a.start - b.start)[0] || null;
      /* NO PAYOUT HAPPENS HERE ANY MORE — same reason the recruiter board stopped paying before it was
       * deleted. The claim that this "can never touch player funds" was simply untrue: the guard it
       * relied on (assertSolvency →
       * checkInvariant) deliberately left wagerLiability OUT of the gate, so with no live bets it let
       * a payout of the ENTIRE escrow balance through. Its twin drained escrow on 2026-08-07 and
       * stranded a player's 36,688,110-lamport cash-out. Player deposits are senior now
       * (protectPlayers), but an unsigned board read still has no business moving money at a moment
       * nobody chose: bounty prizes leave only via admin-gated `event-settle` (dryRun:false). */
      clearTimeout(guard); done = true;
      const nextOut = nextEv ? { id: nextEv.id, startsAt: nextEv.start, endsAt: nextEv.end } : null;
      if (!ev) return res.status(200).json({ active: false, next: nextOut });
      const h = (await kvHgetall('evtk:' + ev.id).catch(() => null)) || {};
      const rows = Object.keys(h).map(a => ({ addr: a, kills: parseInt(h[a]) || 0 }))
                         .filter(r => r.kills > 0).sort((a, b) => b.kills - a.kills);
      const you = String(body.playerAddress || '').trim();
      let youRank = 0, youKills = 0;
      for (let i = 0; i < rows.length; i++) { if (rows[i].addr === you) { youRank = i + 1; youKills = rows[i].kills; break; } }
      const top = rows.slice(0, 10);
      await Promise.all(top.map(async r => { try { r.name = (await kvHget('ph:' + r.addr, 'name')) || ''; } catch (_) { r.name = ''; } }));
      return res.status(200).json({
        active: true, state, id: ev.id, startsAt: ev.start, endsAt: ev.end, next: nextOut,
        top: top.map(r => ({ name: r.name || (r.addr.slice(0, 4) + '…' + r.addr.slice(-4)), kills: r.kills })),
        you: { rank: youRank, kills: youKills, onBoard: youRank > 0 },
      });
    }

    // ── my-refcode: a player's own invite code/link + how many friends they have brought in ───────
    //
    // `recruits` used to be this week's bucket and `recruitsAllTime` a SCAN-derived total, because a
    // weekly contest needed both. The contest is gone (see the note at the top of this file), so there
    // is one number: the all-time count of invited friends who went on to wager for real. It only ever
    // goes up, which is the only behaviour a player ever wanted from it.
    //
    // `recruits` is still in the response, carrying that all-time value. Three clients read this key
    // and they deploy separately from this file — dropping the name would zero the count on whichever
    // one is a minute behind. It can go once all three are known to be on the new field.
    if (action === 'my-refcode') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const code = await ensureRefCode(w);
      const qualified = parseInt(await kvHget('refstats:' + w, 'qualified').catch(() => 0), 10) || 0;
      return res.status(200).json({ code, link: 'https://snakepot.com/?ref=' + code,
        qualified, recruits: qualified, recruitsAllTime: qualified });
    }

    // ── credit-status: a player's free-entry credit balance + Free Entry Grind progress ───────────
    if (action === 'credit-status') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const credit = parseInt(await kvGet('credit:' + w).catch(() => 0)) || 0;
      const gev = activeGrindEvent();
      const total = gev ? (parseInt(await kvGet('grind:' + gev.id + ':' + w).catch(() => 0)) || 0) : 0;
      return res.status(200).json({ credit, grindActive: !!gev, grindTarget: GRIND_TARGET,
        grindDone: total % GRIND_TARGET, grindTotal: total });
    }

    // ── discord-link-code: mint a short code the player posts in Discord to link their account ──────
    if (action === 'discord-link-code') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      const existing = await kvGet('discord:' + w).catch(() => null);
      if (existing) return res.status(200).json({ linked: true });
      const code = refCodeFor(w + ':dl:' + Math.floor(Date.now() / 60000)); // rotates each minute
      await kvSet('dlink:' + code, w, 900);                                 // 15-minute window
      return res.status(200).json({ linked: false, code, channel: DISCORD_LINK_CHANNEL });
    }

    // ── discord-link-check: read the link channel, map any pending code's wallet to its poster ─────
    if (action === 'discord-link-check') {
      const w = String(body.playerAddress || '').trim();
      clearTimeout(guard); done = true;
      if (!w || w.length < 20) return res.status(400).json({ error: 'playerAddress required' });
      if (await kvGet('discord:' + w).catch(() => null)) return res.status(200).json({ linked: true });
      if (!DISCORD_BOT_TOKEN) return res.status(200).json({ linked: false, notConfigured: true });
      let msgs = [];
      try {
        const r = await fetch('https://discord.com/api/v10/channels/' + DISCORD_LINK_CHANNEL + '/messages?limit=50',
          { headers: { 'Authorization': 'Bot ' + DISCORD_BOT_TOKEN } });
        if (r.ok) msgs = await r.json();
      } catch (_) {}
      let linked = false;
      for (const m of (Array.isArray(msgs) ? msgs : [])) {
        const mm = /^\s*LINK\s+([A-Za-z0-9]{6})\s*$/i.exec((m && m.content) || '');
        if (!mm) continue;
        const wallet = await kvGet('dlink:' + mm[1].toUpperCase()).catch(() => null);
        if (!wallet) continue;
        const did = m.author && m.author.id;
        if (!did) continue;
        if (!(await kvGet('dwallet:' + did).catch(() => null))) {   // one Discord per wallet, first wins
          await kvSetPerm('discord:' + wallet, did).catch(() => {});
          await kvSetPerm('dwallet:' + did, wallet).catch(() => {});
        }
        await kvDel('dlink:' + mm[1].toUpperCase()).catch(() => {});
        if (wallet === w) linked = true;
      }
      return res.status(200).json({ linked });
    }

    // ── event-settle: compute (dryRun, anyone) or fire (real, admin-only) a Bounty-Hour payout ─────
    if (action === 'event-settle') {
      const now = Date.now();
      const ev = activeKillEvent(now) || killEvents().filter(e => now >= e.end).sort((a, b) => b.end - a.end)[0];
      clearTimeout(guard); done = true;
      if (!ev) return res.status(200).json({ error: 'no event' });
      if (body.dryRun === false) {   // REAL payout — admin secret required
        const adminSec = (req.headers['x-admin-secret'] || '').trim(), serverSec = (process.env.ADMIN_SECRET || '').trim();
        if (!(adminSec && serverSec && adminSec === serverSec)) return res.status(403).json({ error: 'admin only' });
        return res.status(200).json(await settleBounty(ev, { dryRun: false }));
      }
      return res.status(200).json(await settleBounty(ev, { dryRun: true }));
    }

    // ── bj-audit: inventory every registered blackjack ante; find UNPAID hands; (ADMIN) seal dead ones ─
    // Each ante is `bjdep:<tableId>:<handNum>:<addr>`, flagged `bjpaid:…` once it has been paid out or
    // refunded. ⚠️ Only WINNERS get flagged on a win, so "unflagged" does NOT mean "unpaid" — a loser's
    // ante is unflagged forever and its money correctly went to the winner. Classifying per ANTE is what
    // makes that mistake; this classifies per HAND:
    //   settled  — some ante in the hand was paid out (or the fee was taken). Unflagged antes in it are
    //              LOSERS. Nothing is owed and their liability was already cleared by bj-settle, which
    //              decrements the WHOLE pot. Decrementing again would understate real obligations and let
    //              escrow be overdrawn, so quarantine NEVER touches the ledger.
    //   unpaid   — nothing in the hand was ever paid and its table is gone: the pot was collected and the
    //              winner never got it. THIS is the money to chase (`unpaidHands` below).
    // Quarantine seals a dead hand's antes by setting the NX `bjpaid` flag every payout path is guarded
    // on, which makes paying it again impossible — the point after the operator has settled up by hand.
    // Read-only dry-run by default so anyone can inspect; writing requires ADMIN_SECRET.
    if (action === 'bj-audit') {
      const keys = await kvScan('bjdep:*', 5000);
      const rows = [];
      for (const k of keys) {
        const parts = k.slice('bjdep:'.length).split(':');
        if (parts.length < 3) continue;
        const addr = parts[parts.length - 1];
        const handId = parts.slice(0, parts.length - 1).join(':');
        let lamports = 0, sig = '';
        try { const d = JSON.parse(await kvGet(k) || '{}'); lamports = Math.floor(Number(d.lamports) || 0); sig = String(d.sig || ''); } catch (_) {}
        rows.push({ handId, tableId: parts.slice(0, parts.length - 2).join(':'), addr, lamports, sig, consumed: !!(await kvGet('bjpaid:' + handId + ':' + addr)) });
      }
      const hands = {};
      for (const r of rows) {
        const h = hands[r.handId] || (hands[r.handId] = { handId: r.handId, tableId: r.tableId, antes: 0, pot: 0, paidSeats: 0, seats: [] });
        h.antes++; h.pot += r.lamports; if (r.consumed) h.paidSeats++; h.seats.push(r);
      }
      for (const h of Object.values(hands)) {
        h.feeTaken = !!(await kvGet('bjfee:' + h.handId));
        h.tableAlive = !!(await kvGet('bjt:' + h.tableId));
        h.queued = !!(await kvGet('bjq:' + h.handId));                 // still in the settlement retry queue
        h.settled = h.paidSeats > 0 || h.feeTaken;
        h.unpaid = !h.settled && !h.tableAlive && !h.queued;           // pot collected, winner never paid
      }
      const all = Object.values(hands).sort((a, b) => a.handId.localeCompare(b.handId));
      const unpaidHands = all.filter((h) => h.unpaid);
      const sealable = rows.filter((r) => !r.consumed && !hands[r.handId].tableAlive && !hands[r.handId].queued);
      const info = {
        antes: rows.length, hands: all.length,
        settledHands: all.filter((h) => h.settled).length,
        liveHands: all.filter((h) => h.tableAlive || h.queued).length,
        unpaidHands: unpaidHands.map((h) => ({ handId: h.handId, potLamports: h.pot, potSol: +(h.pot / 1e9).toFixed(6), seats: h.seats.map((s) => s.addr) })),
        unpaidLamports: unpaidHands.reduce((n, h) => n + h.pot, 0),
        sealableAntes: sealable.length,
        handSummary: all.map((h) => ({ handId: h.handId, antes: h.antes, potLamports: h.pot, paidSeats: h.paidSeats, feeTaken: h.feeTaken, tableAlive: h.tableAlive, queued: h.queued, settled: h.settled, unpaid: h.unpaid })),
      };
      if (body.dryRun === false) {
        const adminSec = (req.headers['x-admin-secret'] || '').trim(), serverSec = (process.env.ADMIN_SECRET || '').trim();
        if (!(adminSec && serverSec && adminSec === serverSec)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'admin only' }); }
        let sealed = 0;
        for (const r of sealable) { if (await kvSetNX('bjpaid:' + r.handId + ':' + r.addr, 'sealed', 604800)) sealed++; }
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, applied: true, sealed, ledgerUntouched: true, ...info });
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, applied: false, dryRun: true, ...info, howToApply: 'POST again with {"action":"bj-audit","dryRun":false} and header x-admin-secret: <ADMIN_SECRET> — seals every dead ante so it can never be paid again. Does NOT touch betLiability.' });
    }

    // ── bet-reconcile: repair the shared bet/blackjack liability ledger (ADMIN, read-safe dry-run) ──
    // `betLiability` is a running counter: EVERY ante/bet deposit adds to it, EVERY settle/refund
    // subtracts. When a settlement fails to complete — a payout the solvency gate refused, or a winner
    // the operator paid BY HAND from escrow outside the system — the `+deposit` lands but the `−settle`
    // never does. It RATCHETS above the escrow's real balance, and once `betLiability > escrow` the
    // solvency invariant refuses EVERY blackjack/bet payout AND its fee (they would "eat another
    // bettor's stake"), so payouts freeze until a human sends the money. Blackjack pots are self-funded
    // (each hand's antes are in escrow at settle), so the honest counter at rest is 0 — nothing is
    // mid-hand, and a live hand re-adds its own antes on the next deposit. This resets the counter to a
    // target (default 0). Dry-run by default so anyone can inspect; the real write requires ADMIN_SECRET.
    if (action === 'bet-reconcile') {
      const escR = getEscrow();
      const led = await readBetLedger();
      const balR = await rpc('getBalance', [escR.pubkeyB58, { commitment: 'confirmed' }]);
      const escrowLamports = (balR && typeof balR.value === 'number') ? balR.value : (typeof balR === 'number' ? balR : 0);
      const cur = Math.max(0, Math.floor(Number(led.betLiability) || 0));
      const target = body.setLamports != null ? Math.max(0, Math.floor(Number(body.setLamports) || 0)) : 0;
      const info = { escrowLamports, currentBetLiability: cur, accruedFee: led.accruedFee, proposedBetLiability: target, deltaLamports: target - cur };
      if (body.dryRun === false) {
        const adminSec = (req.headers['x-admin-secret'] || '').trim(), serverSec = (process.env.ADMIN_SECRET || '').trim();
        if (!(adminSec && serverSec && adminSec === serverSec)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'admin only' }); }
        if (target !== cur) await kvHincrby(BET_LEDGER, 'betLiability', target - cur);
        const after = await assertSolvency(escR.pubkeyB58, 0);
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, applied: true, ...info, newBetLiability: target, payoutsWouldSucceed: !!after.ok });
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, applied: false, dryRun: true, ...info, howToApply: 'POST again with {"action":"bet-reconcile","dryRun":false} and header x-admin-secret: <ADMIN_SECRET>' });
    }

    // ── park-food / get-food: persist a paid lobby's UNCLAIMED gold food across an empty room ──────
    // Server-to-server only (GAME_SECRET-HMAC, exactly like elim-lock). Touches ONLY KV, never escrow:
    // the dead players' SOL is already pooled in escrow — these persist the CLAIM TICKETS (gold orbs)
    // so a returning player can still grab that value instead of it vanishing when the room tears down.
    // NO signing, NO transfers happen here, so no money can be moved or duplicated by this path.
    //
    // get-food uses GETDEL (atomic read+delete), NOT GET, on purpose: the same paid lobby id can run on
    // both the NA and EU nodes against ONE shared escrow. GETDEL means exactly one node/instance can
    // ever claim a given parked set; the loser gets nothing. That's what prevents restoring the same
    // gold food on two nodes and letting both sets of players cash it out (escrow shortfall). Whichever
    // instance claims it re-parks whatever is still unclaimed when IT empties, so nothing is lost.
    if (action === 'park-food' || action === 'get-food') {
      const lid = (body.lid || lobbyId || '').toString();
      let authed = false;
      const gp  = (req.headers['x-game-proof'] || '').trim();
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (GAME_SECRET && gp && gts && Math.abs(Date.now() - gts) < 300000) {
        const expected = crypto.createHmac('sha256', GAME_SECRET).update('food:' + lid + ':' + gts).digest('hex');
        try { authed = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) {}
      }
      if (!authed) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      // paid Slither lobbies only — this is the only place gold food carries real escrow value
      if (!lid || !lid.startsWith('ss-') || lid.indexOf('paid') === -1) {
        clearTimeout(guard); done = true; return res.status(400).json({ error: 'paid ss lobby required' });
      }
      // Key is per-lobby, so a $1 lobby's money can never surface in a $5 lobby (ss-paid-lobby-1 vs
      // ss-paid-lobby-5 are different keys). The lid is ALSO stamped inside the payload and re-checked
      // on read — belt-and-braces so a future key refactor can't hand one lobby another lobby's money.
      const KEY = 'foodpark:' + lid;
      if (action === 'get-food') {
        let orbs = [];
        try {
          const raw = await kvGetDel(KEY);
          if (raw) {
            const p = JSON.parse(raw);
            // fail CLOSED on any lid mismatch: never hand a lobby value parked by a different one
            if (p && p.lid === lid && Array.isArray(p.orbs)) orbs = p.orbs;
            else if (p && p.lid && p.lid !== lid) console.warn('[food] lid mismatch parked=' + p.lid + ' asked=' + lid + ' — refusing');
          }
        } catch (_) {}
        clearTimeout(guard); done = true;
        return res.status(200).json({ orbs });
      }
      // park-food: store the server's authoritative set of currently-unclaimed gold orbs. Permanent
      // (kvSetPerm, no TTL) so it genuinely never disappears; cleared when nothing is left unclaimed.
      // Validate BEFORE coercing: `Number(x) || 0` would turn junk ('a', NaN, undefined) into a
      // perfectly valid money orb sitting at the map origin. Reject non-finite coords outright.
      // `lam` rides along with `w`: it is the orb's share of a dead player's stake in lamports, and it
      // is the figure a cash-out is actually paid from. Dropping it here would strip every parked orb
      // of its money on the round trip and quietly reduce a returning player's claim to zero.
      const orbs = Array.isArray(body.orbs)
        ? body.orbs.slice(0, 4000)
            .map(o => (o && typeof o === 'object') ? { x: Number(o.x), y: Number(o.y), w: Number(o.w), lam: Math.floor(Number(o.lam) || 0) } : null)
            .filter(o => o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.w) && Number.isFinite(o.lam) && o.lam >= 0 && (o.w > 0 || o.lam > 0))
            .map(o => ({ x: Math.round(o.x), y: Math.round(o.y), w: o.w, lam: o.lam }))
        : [];
      try {
        if (orbs.length) await kvSetPerm(KEY, JSON.stringify({ lid, ts: Date.now(), orbs }));
        else await kvDel(KEY);
      } catch (_) {}
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, parked: orbs.length });
    }

    // ── wager-list: PUBLIC order book for one arena (open + live). No auth, no money. ────────────
    if (action === 'wager-list') {
      const lk = wgLobbyKey(body.region, body.lobby);
      const ids = [];
      for (const key of ['wgopen:' + lk, 'wglive:' + lk]) {
        const z = await kvZrevrange(key, 0, 199);           // newest first (score = createdTs)
        if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      }
      const now = Date.now();
      const open = [], live = [], stale = [];
      for (const id of ids.slice(0, 300)) {
        let w = await wgLoad(id); if (!w) continue;
        // SWEEP stale reservations. A reservation is a 90s claim taken BEFORE the taker deposits; if
        // their deposit never lands the wager must go back on the book, or it is stranded forever
        // (never matched, never returned, creator's stake stuck in escrow). This used to happen only
        // if another player coincidentally tried to reserve the same wager. wager-list is called by
        // every client AND by the game server's reconcile, so sweeping here makes it self-healing.
        if (w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0;
          w.reservedSubject2 = null; w.reservedSubject2Name = ''; w.reservedSubject2Ip = '';
          await wgSave(w);
          await kvZadd('wgopen:' + lk, w.createdTs, id).catch(() => {});
          stale.push(id);
        }
        if (w.status === P2P.STATUS.OPEN)      { if (now < Number(w.lockTs)) open.push(wgPublic(w)); }
        else if (w.status === P2P.STATUS.MATCHED) live.push(wgPublic(w));
        // A wager whose window has closed with no taker is reported so the game server returns it.
        else if (w.status === P2P.STATUS.RESERVED) { /* still validly claimed — leave it alone */ }
      }
      if (stale.length) console.log('[wg] swept ' + stale.length + ' stale reservation(s) back to open');
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, open, live, now, swept: stale.length });
    }

    // ── wager-sweep: RECOVER stranded wagers (GAME_SECRET-HMAC) ─────────────────────────────────
    // Safety net that runs independently of any live game. ssWagerTick only runs while an arena is
    // actually being simulated, so a wager left behind in an idle lobby had nothing to rescue it.
    // This scans every wager and:
    //   * reverts a lapsed 'reserved' claim back to 'open' (taker never funded it), and
    //   * RETURNS 100% (no fee) to the creator of any unmatched wager whose window has closed.
    // Idempotent and invariant-gated, exactly like wager-return.
    if (action === 'wager-sweep') {
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-sweep:' + gts)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      const now = Date.now();
      const keys = await kvScan('wg:*', 2000);
      let reverted = 0, returned = 0, voided = 0, checked = 0;
      const detail = [];   // read-only picture of what is actually in KV, so a stuck stake can be diagnosed
      const esc = getEscrow();
      for (const k of keys) {
        if (returned >= 10) break;                       // bound the work per sweep
        let w = null;
        try { const raw = await kvGet(k); if (raw) w = JSON.parse(raw); } catch (_) {}
        if (!w || !w.id) continue;
        checked++;
        // No addresses, no signatures — just enough to see WHY something is not settling.
        if (detail.length < 25) detail.push({ id: w.id, st: w.status, lob: w.lobby, reg: w.region,
          stake: w.stakeLamports, ageS: Math.round((now - Number(w.createdTs || 0)) / 1000),
          lockInS: Math.round((Number(w.lockTs || 0) - now) / 1000),
          resInS: w.reservedUntil ? Math.round((Number(w.reservedUntil) - now) / 1000) : null,
          matched: !!w.acceptor, paidLock: null });
        // 1) lapsed reservation → back on the book
        if (w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0;
          w.reservedSubject2 = null; w.reservedSubject2Name = ''; w.reservedSubject2Ip = '';
          await wgSave(w);
          await kvZadd('wgopen:' + wgLobbyKey(w.region, w.lobby), w.createdTs, w.id).catch(() => {});
          reverted++;
        }
        // 2) unmatched and closed → refund the creator in full
        if (w.status === P2P.STATUS.OPEN && now >= Number(w.lockTs || 0)) {
          /* Returning an unmatched stake is the ONE refund that must always work (see wgRetryableFail).
           * A hold recorded because escrow was momentarily short is cleared and retried — nothing was
           * ever sent in that case. A hold from an ambiguous send still blocks, as before. */
          if (await wgIsHeld(w.id)) {
            if (!(await wgHeldRetryable(w.id))) continue;
            await wgClearHeld(w.id);
            console.log('[wg] retrying held return ' + w.id + ' — previous failure was insolvency, nothing was sent');
          }
          const lock = await kvSetNX('lock:wg:' + w.id, '1', 45);
          if (!lock) continue;
          try {
            const cur = await wgLoad(w.id);
            if (!cur || cur.status !== P2P.STATUS.OPEN) continue;
            let claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);
            if (!claimed) {
              // We already proved above that this wager is still OPEN — i.e. no payout ever
              // completed. So a lock sitting here is a leftover from an attempt that died
              // mid-flight, and honouring it would strand the creator's stake forever. Clear it.
              await kvDel('wgpaid:' + w.id).catch(() => {});
              claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);
              if (!claimed) continue;
              console.warn('[wg] cleared a stale payment lock on ' + w.id);
            }
            const amt = P2P.returnAmount(cur.stakeLamports);
            const pay = await wgPayOne(esc, cur.creator, amt, 'wager-sweep-return');
            if (!pay.ok) {
              await kvDel('wgpaid:' + w.id).catch(() => {});
              if (wgRetryableFail(pay.reason)) {
                // Escrow was short and NOTHING was sent. Leave the wager OPEN and unheld so the next
                // sweep returns it — this stake is the creator's own unmatched money and must not be
                // stranded just because the wallet was momentarily thin.
                console.warn('[wg] sweep-return deferred for ' + w.id + ' — insolvent, will retry next sweep');
                betAlert('unmatched bet ' + w.id + ' could NOT be returned yet (escrow short ' + amt +
                         ' lamports). Nothing was sent; it retries automatically every 60s.');
                continue;
              }
              await wgSetHeld(w.id, 'wager-sweep-return failed: ' + (pay.reason || 'unknown'));
              betAlert('wager ' + w.id + ' HELD after a failed sweep-return (' + (pay.reason || 'unknown') +
                       ') — will NOT auto-retry. Refund the creator by hand if this was real, then leave it.');
              continue;
            }
            await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
            await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
            cur.status = P2P.STATUS.RETURNED; cur.payoutTx = pay.sig; cur.settledTs = Date.now(); cur.fee = 0;
            await wgSave(cur);
            await kvZrem('wgopen:' + wgLobbyKey(cur.region, cur.lobby), cur.id).catch(() => {});
            await wgPush(cur.region, cur.lobby, 'returned', wgPublic(cur));
            returned++;
            betAlert('swept stranded wager ' + cur.id + ' → returned ' + amt + ' to ' + String(cur.creator).slice(0, 8));
          } finally { await kvDel('lock:wg:' + w.id).catch(() => {}); }
        }
        // 3) MATCHED but still unsettled an hour later → VOID: both sides get 100% back, no fee.
        // A duel only settles when one duellist actually kills the other, so a duel where a third
        // party intervened (or someone never came back) would otherwise hold both stakes forever.
        // This is the release valve, and it is deliberately the LAST resort: it only fires long
        // after any real game has ended.
        //
        // "Make sure it wasn't already paid out or lost first" — three independent guards:
        //   a) re-load under a lock and require status === 'matched'. A wager that settled is
        //      'settled', so a decided bet can never be voided out from under its winner.
        //   b) claim 'wgpaid:<id>' with SETNX. Unlike case 2 we do NOT clear a lock we find held,
        //      because here a held lock may be a real payout in flight — we skip and retry later.
        //   c) pay each side under its own 'wgvoid:<id>:<side>' guard, so a void interrupted after
        //      the first transfer resumes without paying the same person twice.
        if (w.status === P2P.STATUS.MATCHED && w.acceptor &&
            now - Number(w.matchedTs || w.createdTs || 0) >= WG_VOID_AFTER_MS) {
          /* A bet that CANNOT SETTLE is the owner's other stated return case ("or doesnt settle it
           * should be returned to player"), so like the unmatched return it must not be stranded by a
           * momentarily thin escrow: an insolvency hold is cleared and retried, an ambiguous one is not.
           * Resuming is safe per-side because of the `wgvoid:<id>:<side>` guards below — a side already
           * paid is skipped, so only the outstanding one is sent. */
          if (await wgIsHeld(w.id)) {
            if (!(await wgHeldRetryable(w.id))) continue;
            await wgClearHeld(w.id);
            console.log('[wg] retrying held VOID refund ' + w.id + ' — previous failure was insolvency');
          }
          const lock = await kvSetNX('lock:wg:' + w.id, '1', 45);
          if (!lock) continue;
          try {
            const cur = await wgLoad(w.id);
            if (!cur || cur.status !== P2P.STATUS.MATCHED || !cur.acceptor) continue;   // (a)
            const claimed = await kvSetNX('wgpaid:' + w.id, '1', WG_PAY_LOCK_TTL);      // (b)
            if (!claimed) continue;
            const amt = P2P.returnAmount(cur.stakeLamports);
            let paidBoth = true, txs = [], softFail = false;
            for (const [who, side] of [[cur.creator, 'c'], [cur.acceptor, 'a']]) {       // (c)
              const g = await kvSetNX('wgvoid:' + w.id + ':' + side, '1', WG_PAY_LOCK_TTL);
              if (!g) continue;                       // already refunded on an earlier pass
              const pay = await wgPayOne(esc, who, amt, 'wager-void-refund');
              if (!pay.ok) {
                await kvDel('wgvoid:' + w.id + ':' + side).catch(() => {});
                paidBoth = false;
                softFail = wgRetryableFail(pay.reason);   // insolvent = nothing sent = retry next sweep
                break;
              }
              txs.push(pay.sig);
              await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
              await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
            }
            if (!paidBoth) {
              await kvDel('wgpaid:' + w.id).catch(() => {});
              if (softFail) {
                console.warn('[wg] VOID refund deferred for ' + w.id + ' — insolvent, will retry next sweep');
                betAlert('bet ' + w.id + ' could not settle and its return is waiting on escrow (' + amt +
                         ' lamports/side). Nothing was sent; it retries automatically every 60s.');
                continue;
              }
              await wgSetHeld(w.id, 'wager-void-refund failed for ' + w.id);
              betAlert('wager ' + w.id + ' HELD after a failed VOID refund — will NOT auto-retry. ' +
                       'Refund both sides by hand if this was real, then leave it.');
              continue;
            }
            cur.status = P2P.STATUS.RETURNED; cur.voided = true; cur.fee = 0;
            cur.payoutTx = txs[0] || null; cur.settledTs = Date.now();
            await wgSave(cur);
            await kvZrem('wglive:' + wgLobbyKey(cur.region, cur.lobby), cur.id).catch(() => {});
            await wgPush(cur.region, cur.lobby, 'returned', wgPublic(cur));
            voided++;
            betAlert('VOIDED unsettled wager ' + cur.id + ' after ' +
                     Math.round((now - Number(cur.matchedTs || cur.createdTs || 0)) / 60000) +
                     'min — refunded ' + amt + ' to BOTH sides');
          } finally { await kvDel('lock:wg:' + w.id).catch(() => {}); }
        }
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, checked, reverted, returned, voided, detail });
    }

    // ── wager-mine: PUBLIC read of one address's bet slip (all statuses). No money. ──────────────
    if (action === 'wager-mine') {
      const addr = String(body.address || '');
      if (!addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'address required' }); }
      const z = await kvZrevrange('wgu:' + addr, 0, 199);
      const ids = []; if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      const mine = [];
      for (const id of ids) { const w = await wgLoad(id); if (w) mine.push(wgPublic(w)); }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, wagers: mine, now: Date.now() });
    }

    // ── wager-settle: AUTHORITATIVE settlement from the game server (GAME_SECRET-HMAC) ───────────
    // The game server decides the winning side from live game truth; this pays the winner 2S − 8%
    // and books the fee. Idempotent + NX-locked: a wager can NEVER pay out twice.
    if (action === 'wager-settle') {
      const wid = String(body.wagerId || '');
      const winningSide = String(body.winningSide || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-settle:' + wid + ':' + winningSide + ':' + gts)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' });
      }
      if (!wid) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (w.status === P2P.STATUS.SETTLED) {   // idempotent replay
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, already: true, wager: wgPublic(w) });
        }
        if (await wgIsHeld(wid)) {   // failed once already — owner handles it manually, never auto-retry
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: false, held: true, error: 'held for manual review — refund by hand if needed, will not auto-retry' });
        }
        const r = P2P.resolveWager(w, winningSide);
        if (!r) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wager is not settleable' }); }
        // Single-pay marker claimed BEFORE the transfer — a crash mid-send can never double-pay.
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_PAY_LOCK_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }

        const esc = getEscrow();
        // Winner is paid and the 8% is swept to the fee wallet in the SAME transaction.
        const pay = await wgPayWinnerAndFee(esc, r.winner, r.payout, r.fee, 'wager-settle');
        if (!pay.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});
          await wgSetHeld(wid, 'wager-settle failed: ' + (pay.reason || 'unknown'));
          betAlert('wager ' + wid + ' HELD after a failed settle (' + (pay.reason || 'unknown') +
                   ') — will NOT auto-retry. Refund the winner by hand if this was real, then leave it.');
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'payout held: ' + (pay.reason || 'unknown'), held: true });
        }
        // The whole pot leaves bet liability. accruedFee is NOT incremented any more: the fee has
        // physically left escrow to the fee wallet, so tracking it as a balance still sitting here
        // would overstate what escrow holds and (as it did) block later legitimate payouts.
        await kvHincrby(BET_LEDGER, 'betLiability', -r.pot).catch(() => {});
        w.status = P2P.STATUS.SETTLED; w.winningSide = winningSide; w.winner = r.winner; w.loser = r.loser;
        w.payout = r.payout; w.fee = r.fee; w.payoutTx = pay.sig; w.settledTs = Date.now();
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wglive:' + lk, wid).catch(() => {});
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await wgPush(w.region, w.lobby, 'settled', wgPublic(w));
        // Public bet slip. AWAITED (Vercel can freeze the function the instant the response is sent, so
        // fire-and-forget here often never runs at all) but fully swallowed inside, and only reached
        // after the payout has already landed — it cannot affect the money or this response.
        await postBetSlipToDiscord(w);
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── COINFLIP "Tails Never Fails" money — cf-deposit registers a player's escrow deposit as bet
    // liability (so the shared-escrow solvency invariant accounts for it, exactly like wagers), and
    // cf-settle pays the winner (pot − 10%) or refunds both on a tie. Trustless: verifies the deposit
    // ON-CHAIN and recomputes the provably-fair flip; solvency-guarded + NX-locked so it can never
    // double-pay or overdraw the pool that funds the live snake/pac games. State lives in shared KV.
    if (action === 'cf-deposit') {
      const id = String(body.id || ''); const role = body.role === 'opponent' ? 'opponent' : 'creator';
      const addr = String(body.address || ''); const sig = String(body.sig || '');
      const lamports = Math.floor(Number(body.lamports) || 0);
      if (!id || !addr || !sig || !(lamports > 0)) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'id, address, sig, lamports required' }); }
      const key = 'cfdep:' + id + ':' + role;
      // Claim the deposit slot ONCE — a replay must not re-register liability.
      const claimed = await kvSetNX(key, JSON.stringify({ addr, sig, lamports }), 86400);
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        await verifyBetDepositTx(sig, addr, lamports, esc.pubkeyB58);        // must have really landed in escrow
        await kvHincrby(BET_LEDGER, 'betLiability', lamports).catch(() => {}); // account it in the invariant
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true });
      } catch (e) {
        await kvDel(key).catch(() => {});                                   // release so a real deposit can retry
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: (e && e.message) || 'deposit not verified', retry: true });
      }
    }

    if (action === 'cf-settle') {
      const m = body.match || {};
      const id = String(m.id || '');
      if (!id) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'match required' }); }
      const shaHex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
      // Per-round flip: each re-flip mixes the round index into the player seed, so a tie can roll
      // again from the SAME committed serverSeed (no new commit needed). 0=heads, 1=tails.
      const flipR = (ss, ps, r) => parseInt(shaHex(ss + ':' + ps + ':' + r).slice(0, 8), 16) % 2;
      if (!m.serverSeed || shaHex(m.serverSeed) !== m.serverSeedHash) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad server-seed commit' }); }
      // Trustless round proof: the winning round must be the FIRST decisive one — every earlier round
      // must recompute to a tie from the committed seeds, else the caller is cherry-picking a round.
      const round = Math.max(0, Math.min(300, Math.floor(Number(m.round) || 0)));
      for (let r = 0; r < round; r++) {
        if (flipR(m.serverSeed, m.creatorSeed, r) !== flipR(m.serverSeed, m.opponentSeed, r)) {
          clearTimeout(guard); done = true; return res.status(403).json({ error: 'round ' + r + ' was decisive, not a tie' });
        }
      }
      // Both deposits must be on record (registered + verified by cf-deposit).
      const [cd, od] = await Promise.all([kvGet('cfdep:' + id + ':creator'), kvGet('cfdep:' + id + ':opponent')]);
      if (!cd || !od) { clearTimeout(guard); done = true; return res.status(409).json({ error: 'both deposits not registered yet', retry: true }); }
      const cDep = JSON.parse(cd), oDep = JSON.parse(od);
      const dep = Math.min(cDep.lamports, oDep.lamports);   // pay on the smaller stake if they ever differ
      const cFlip = flipR(m.serverSeed, m.creatorSeed, round), oFlip = flipR(m.serverSeed, m.opponentSeed, round);
      const tie = cFlip === oFlip;
      const lock = await kvSetNX('lock:cf:' + id, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const esc = getEscrow();
        if (tie) {
          const out = {};
          for (const [tag, addr] of [['c', cDep.addr], ['o', oDep.addr]]) {
            const claimed = await kvSetNX('cfpaid:' + id + ':' + tag, '1', 86400);
            if (!claimed) { out[tag] = { already: true }; continue; }
            const r = await wgPayWinnerAndFee(esc, addr, dep, 0, 'cf-tie-' + tag);
            if (!r.ok) {
              const retry = await releasePayLock('cfpaid:' + id + ':' + tag, r, 'cf-tie-' + tag + ':' + id);
              clearTimeout(guard); done = true;
              return res.status(retry ? 503 : 409).json({ retry, held: !retry,
                error: (retry ? 'refund held: ' : 'refund UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (r.reason || '') });
            }
            await kvHincrby(BET_LEDGER, 'betLiability', -dep).catch(() => {});
            out[tag] = { sig: r.sig };
          }
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, tie: true, refunds: out });
        }
        const claimed = await kvSetNX('cfpaid:' + id, '1', 86400);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        const winnerAddr = cFlip === 1 ? cDep.addr : oDep.addr;   // TAILS(1) wins
        const pot = dep * 2;
        const fee = Math.floor(pot * CREATOR_FEE_PCT);            // 10% to CREATOR_WALLET
        const payout = pot - fee;
        const pay = await wgPayWinnerAndFee(esc, winnerAddr, payout, fee, 'cf-settle');
        if (!pay.ok) {
          const retry = await releasePayLock('cfpaid:' + id, pay, 'cf-settle:' + id);
          clearTimeout(guard); done = true;
          return res.status(retry ? 503 : 409).json({ retry, held: !retry,
            error: (retry ? 'payout held: ' : 'payout UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (pay.reason || '') });
        }
        await kvHincrby(BET_LEDGER, 'betLiability', -pot).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tie: false, winner: winnerAddr, payout, fee, tx: pay.sig });
      } finally { await kvDel('lock:cf:' + id).catch(() => {}); }
    }

    // cf-refund: a creator cancels their open flip before anyone joins → refund their deposit 100%, no
    // fee, and clear the liability. Idempotent; only refunds a registered-but-unsettled deposit.
    if (action === 'cf-refund') {
      const id = String(body.id || ''); const role = body.role === 'opponent' ? 'opponent' : 'creator';
      if (!id) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'id required' }); }
      const raw = await kvGet('cfdep:' + id + ':' + role);
      if (!raw) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'no deposit on record' }); }
      const d = JSON.parse(raw);
      const claimed = await kvSetNX('cfpaid:' + id + ':' + role + ':refund', '1', 86400);
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      // See the note on the same flag in bj-refund: the catch releases the pay-lock, which is only safe
      // while nothing has been sent.
      let payAttempted = false;
      try {
        const esc = getEscrow();
        payAttempted = true;
        const r = await wgPayWinnerAndFee(esc, d.addr, d.lamports, 0, 'cf-refund');
        if (!r.ok) {
          const retry = await releasePayLock('cfpaid:' + id + ':' + role + ':refund', r, 'cf-refund:' + id + ':' + role);
          clearTimeout(guard); done = true;
          return res.status(retry ? 503 : 409).json({ retry, held: !retry,
            error: (retry ? 'refund held: ' : 'refund UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (r.reason || '') });
        }
        await kvHincrby(BET_LEDGER, 'betLiability', -d.lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tx: r.sig });
      } catch (e) {
        const retry = await releasePayLock('cfpaid:' + id + ':' + role + ':refund', { mayHavePaid: payAttempted, reason: (e && e.message) || 'threw' },
                                          'cf-refund:' + id + ':' + role);
        clearTimeout(guard); done = true;
        return res.status(500).json({ error: (e && e.message) || 'refund failed', retry, held: !retry });
      }
    }

    // ── BLACKJACK PVP money — bj-deposit registers each seated player's ante (escrow deposit) as bet
    // liability (shared-escrow solvency accounts for it, exactly like coinflip/wagers). bj-settle pays
    // the winner(s) closest-to-21 — pot − 10% → CREATOR_WALLET, SPLIT equally on a tie — or refunds
    // every ante on a PUSH (all bust / whole-table tie, no fee). GAME_SECRET-HMAC authed: blackjack's
    // result depends on player hit/stand DECISIONS, so (unlike coinflip) it can't be re-derived from the
    // seed alone — the trusted game server attests it, same trust model as wager-settle. Pot is computed
    // from the REGISTERED on-chain antes (never the caller's claim). Solvency-guarded + NX-locked +
    // idempotent per payee so it can never double-pay or overdraw the pool. State in shared KV.
    if (action === 'bj-deposit') {
      const handId = String(body.handId || ''); const addr = String(body.address || '');
      const sig = String(body.sig || ''); const lamports = Math.floor(Number(body.lamports) || 0);
      if (!handId || !addr || !sig || !(lamports > 0)) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId, address, sig, lamports required' }); }
      const key = 'bjdep:' + handId + ':' + addr;
      const claimed = await kvSetNX(key, JSON.stringify({ addr, sig, lamports }), 86400);   // claim ONCE — replays must not re-register liability
      if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
      try {
        const esc = getEscrow();
        await verifyBetDepositTx(sig, addr, lamports, esc.pubkeyB58);                        // must have really landed in escrow
        await kvHincrby(BET_LEDGER, 'betLiability', lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true });
      } catch (e) {
        await kvDel(key).catch(() => {});                                                    // release so a real deposit can retry
        clearTimeout(guard); done = true;
        /*
         * THREE DIFFERENT THINGS USED TO SHARE ONE 503, AND ONLY ONE OF THEM IS A FAULT.
         *
         * A player's ante is deposited on chain and registered here immediately afterwards, so the
         * FIRST call routinely arrives before the transfer is indexed. That is the normal course of
         * events, not an error — but answering it 503 meant every ordinary ante counted as a server
         * error. Measured on 2026-07-31, pulp's /api/blackjack -> /api/settle ran at a 29.5% error
         * rate, which is why the platform kept raising 5xx anomalies on a day nobody was playing, and
         * why a REAL outage had nowhere to stand out from.
         *
         *   pending      -> 202 Accepted. The chain answered and simply does not have it yet. The
         *                   client already retries on the body's `retry` flag (readyRetry in
         *                   table.jsx tests `last.retry`, never the status), so nothing about the
         *                   player's experience changes.
         *   no RPC       -> 503. Genuinely our problem, and now the ONLY thing on this path that
         *                   shows up as one.
         *   anything else-> 400. 'Deposit too small', 'Escrow not found in deposit tx', 'Sender not
         *                   found', 'Deposit tx failed on-chain' — the deposit is wrong, and no
         *                   amount of retrying fixes it. Marked retry:false so the client stops
         *                   instead of hammering a verdict that will never change.
         *
         * ⚠️ 202 is a 2xx, so `r.ok` is now TRUE for a pending ante. The caller MUST test the body's
         * `ok`, not the HTTP status, or it will seat a player whose money has not been verified.
         * That is done — see the bj-deposit branch of app/api/blackjack/route.js.
         */
        const msg = (e && e.message) || 'deposit not verified';
        if (e && e.pending)            return res.status(202).json({ ok: false, pending: true, error: msg, retry: true });
        if (/no Solana RPC answered/.test(msg)) return res.status(503).json({ ok: false, error: msg, retry: true });
        return res.status(400).json({ ok: false, error: msg, retry: false });
      }
    }

    // bj-dep-status: is this seat's ante for this hand ALREADY sitting in escrow, unspent? Read-only.
    // The blackjack engine asks this before charging: the table object is not the only record of a paid
    // ante — the on-chain deposit is registered here the instant it lands. A `ready` that was lost after
    // the transfer (dropped response, erased write, closed tab) used to leave the player paid but shown
    // as un-anted, so pressing ANTE again charged them a SECOND time. `creditable` lets the engine seat
    // them on the money already in escrow. It is false once the ante has been consumed (won out or
    // refunded — bjpaid is set), so a spent ante can never be re-credited into a pot it no longer funds.
    if (action === 'bj-dep-status') {
      const handId = String(body.handId || ''); const addr = String(body.address || '');
      if (!handId || !addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId, address required' }); }
      const raw = await kvGet('bjdep:' + handId + ':' + addr);
      const spent = raw ? await kvGet('bjpaid:' + handId + ':' + addr) : null;
      let lamports = 0;
      if (raw) { try { lamports = Math.floor(Number(JSON.parse(raw).lamports) || 0); } catch (_) {} }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, registered: !!raw, consumed: !!spent, creditable: !!raw && !spent && lamports > 0, lamports });
    }

    if (action === 'bj-settle') {
      const handId = String(body.handId || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!handId) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId required' }); }
      // Server-to-server only — the trusted game server signs the settlement.
      if (!verifyGameProof(req, 'bj-settle:' + handId + ':' + gts)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      // Provable-fairness record: the committed seed must match its hash (players verify the deal with it).
      if (body.serverSeed && body.serverSeedHash) {
        const h = crypto.createHash('sha256').update(String(body.serverSeed)).digest('hex');
        if (h !== body.serverSeedHash) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad server-seed commit' }); }
      }
      const seatAddrs = Array.isArray(body.seats) ? body.seats.map((s) => String((s && (s.address || s.addr)) || s || '')).filter(Boolean) : [];
      const winnersIn = Array.isArray(body.winners) ? body.winners.map((w) => String(w)).filter(Boolean) : [];
      if (seatAddrs.length < 1) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'no seats' }); }
      // Pot from the REGISTERED antes (bj-deposit) — never the caller's claimed amounts.
      const deps = {};
      for (const a of seatAddrs) { const raw = await kvGet('bjdep:' + handId + ':' + a); if (raw) deps[a] = JSON.parse(raw); }
      const anted = Object.keys(deps);
      if (anted.length < 1) { clearTimeout(guard); done = true; return res.status(409).json({ error: 'no antes registered yet', retry: true }); }
      const pot = anted.reduce((n, a) => n + Math.floor(deps[a].lamports || 0), 0);
      const lock = await kvSetNX('lock:bj:' + handId, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'settlement in progress' }); }
      try {
        const esc = getEscrow();
        const winners = winnersIn.filter((w) => deps[w]);                    // only an anted seat can win
        const isPush = body.outcome === 'push' || winners.length === 0;
        if (isPush) {
          const out = {};                                                    // refund every ante 100%, no fee
          for (const a of anted) {
            const fk = 'bjpaid:' + handId + ':' + a;
            const c = await claimPayFlag(fk);
            if (!c.claimed) {
              // A flag left in `claimed:` is a refund that was started and never finished — say so
              // instead of reporting it as already paid, which is how these went missing silently.
              if (!c.paid) { unresolvedPayFlag(fk, a, deps[a].lamports, 'bj-push:' + handId); out[a] = { unresolved: true, paid: false }; }
              else out[a] = { already: true };
              continue;
            }
            const r = await wgPayWinnerAndFee(esc, a, deps[a].lamports, 0, 'bj-push');
            /* ⚠️ `retry` MUST come from releasePayLock, not be hardcoded true. The game server retries
             * this call by itself, with no human in the loop — so when the lock is HELD (the send may
             * already have landed) telling it to retry would make it hammer a lock that never opens.
             * A held ante is reported as unresolved and needs the owner to check on-chain. */
            if (!r.ok) {
              const retry = await releasePayLock('bjpaid:' + handId + ':' + a, r, 'bj-push:' + handId + ':' + String(a).slice(0, 8));
              clearTimeout(guard); done = true;
              return res.status(retry ? 503 : 409).json({ retry, held: !retry,
                error: (retry ? 'refund held: ' : 'refund UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (r.reason || '') });
            }
            // The transfer went out — turn the claim into proof of it, so a retry can tell this apart
            // from an attempt that died mid-flight.
            await markPayFlagPaid(fk, r.sig);
            await kvHincrby(BET_LEDGER, 'betLiability', -deps[a].lamports).catch(() => {});
            out[a] = { sig: r.sig };
          }
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, push: true, pot, refunds: out });
        }
        // Winner(s) split the prize; the 10% fee (plus rounding dust) → CREATOR_WALLET. Each winner's
        // share and the fee are paid + accounted INDEPENDENTLY (own NX claim), so a retry after a partial
        // payout never double-pays anyone or double-charges the fee. Liability nets to exactly `pot`.
        const W = winners.length;
        const fee0 = Math.floor(pot * CREATOR_FEE_PCT);
        const prize = pot - fee0;
        const share = Math.floor(prize / W);
        const feeTotal = fee0 + (prize - share * W);                          // rounding dust rides with the fee → escrow stays exact
        const out = {};
        for (const w of winners) {
          const fk = 'bjpaid:' + handId + ':' + w;
          const c = await claimPayFlag(fk);
          if (!c.claimed) {
            if (!c.paid) { unresolvedPayFlag(fk, w, share, 'bj-win:' + handId); out[w] = { unresolved: true, paid: false }; }
            else out[w] = { already: true };
            continue;
          }
          const r = await wgPayWinnerAndFee(esc, w, share, 0, 'bj-win');
          if (!r.ok) {
            const retry = await releasePayLock('bjpaid:' + handId + ':' + w, r, 'bj-win:' + handId + ':' + String(w).slice(0, 8));
            clearTimeout(guard); done = true;
            return res.status(retry ? 503 : 409).json({ retry, held: !retry,
              error: (retry ? 'payout held: ' : 'payout UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (r.reason || '') });
          }
          await markPayFlagPaid(fk, r.sig);
          await kvHincrby(BET_LEDGER, 'betLiability', -share).catch(() => {});
          out[w] = { sig: r.sig, share };
        }
        let feeSig = null;
        if (feeTotal > 0) {
          const fc = await kvSetNX('bjfee:' + handId, '1', 86400);
          if (fc) {
            // Each winner payout above cost escrow a ~5000-lamport network fee that its own tx had no
            // rake to absorb (wgPayWinnerAndFee was called with fee=0). Take the WHOLE hand's network
            // cost — W winner txs + this fee tx — out of the rake, so escrow nets exactly the pot and
            // stays funded purely by antes (no operator top-ups). betLiability is still cleared by the
            // full feeTotal; the lamports withheld from the rake are the network fees already spent.
            const feeToSend = Math.max(0, feeTotal - (W + 1) * TX_FEE);
            if (feeToSend > 0) {
              const fr = await wgPayOne(esc, CREATOR_WALLET, feeToSend, 'bj-fee');
              if (!fr.ok) {
                const retry = await releasePayLock('bjfee:' + handId, fr, 'bj-fee:' + handId);
                clearTimeout(guard); done = true;
                return res.status(retry ? 503 : 409).json({ retry, held: !retry,
                  error: (retry ? 'fee held: ' : 'fee UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (fr.reason || '') });
              }
              feeSig = fr.sig;
            }
            await kvHincrby(BET_LEDGER, 'betLiability', -feeTotal).catch(() => {});
          }
        }
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, push: false, pot, fee: feeTotal, share, winners, payouts: out, feeTx: feeSig });
      } finally { await kvDel('lock:bj:' + handId).catch(() => {}); }
    }

    // bj-refund: a seat's ante is returned 100% (no fee) — e.g. a table breaks up before the hand deals,
    // or a queued player never got dealt in. Idempotent; only refunds a registered, unsettled ante.
    if (action === 'bj-refund') {
      const handId = String(body.handId || ''); const addr = String(body.address || '');
      if (!handId || !addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'handId, address required' }); }
      // Server-to-server only — the trusted blackjack engine signs each refund it authorizes (same
      // GAME_SECRET-HMAC trust model as bj-settle). ⚠️ Without this, bj-refund was UNAUTHENTICATED: any
      // client could POST {handId,address} and reclaim ANY registered, unsettled ante — including their
      // OWN losing ante (a hand's payout only NX-flags the WINNER as paid, so a loser's bjdep looked
      // refundable) — double-spending the pot straight out of escrow. The engine only ever requests a
      // refund for an ante NOT dealt into a live hand (see undealtAnteHandId), so real refunds are unaffected.
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'bj-refund:' + handId + ':' + addr + ':' + gts)) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      const raw = await kvGet('bjdep:' + handId + ':' + addr);
      if (!raw) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'no deposit on record' }); }
      const d = JSON.parse(raw);
      const fk = 'bjpaid:' + handId + ':' + addr;
      const c = await claimPayFlag(fk);
      if (!c.claimed) {
        clearTimeout(guard); done = true;
        if (!c.paid) {
          unresolvedPayFlag(fk, addr, d.lamports, 'bj-refund:' + handId);
          return res.status(409).json({ ok: false, unresolved: true, retry: false,
            error: 'A previous refund attempt never completed — this ante has NOT been returned. It is flagged for the operator; do not retry.' });
        }
        return res.status(200).json({ ok: true, already: true });
      }
      // Tracks whether the transfer call was ever entered. The catch below releases the pay-lock, and
      // that is only safe while nothing has been sent — the realistic throw here is getEscrow() failing
      // before any transfer. Once the payout has been attempted, a throw from anything AFTER it (the
      // ledger update, the response) must NOT release the lock, or the ante is refunded twice.
      let payAttempted = false;
      try {
        const esc = getEscrow();
        payAttempted = true;
        const r = await wgPayWinnerAndFee(esc, d.addr, d.lamports, 0, 'bj-refund');
        if (!r.ok) {
          const retry = await releasePayLock('bjpaid:' + handId + ':' + addr, r, 'bj-refund:' + handId + ':' + String(addr).slice(0, 8));
          clearTimeout(guard); done = true;
          return res.status(retry ? 503 : 409).json({ retry, held: !retry,
            error: (retry ? 'refund held: ' : 'refund UNRESOLVED — the transfer may already have been sent, so it will NOT be retried: ') + (r.reason || '') });
        }
        await markPayFlagPaid(fk, r.sig);
        await kvHincrby(BET_LEDGER, 'betLiability', -d.lamports).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, tx: r.sig });
      } catch (e) {
        const retry = await releasePayLock('bjpaid:' + handId + ':' + addr, { mayHavePaid: payAttempted, reason: (e && e.message) || 'threw' },
                                          'bj-refund:' + handId + ':' + String(addr).slice(0, 8));
        clearTimeout(guard); done = true;
        return res.status(500).json({ error: (e && e.message) || 'refund failed', retry, held: !retry });
      }
    }

    // ── wager-return: unmatched at close → creator refunded 100%, NO fee (GAME_SECRET-HMAC) ──────
    if (action === 'wager-return') {
      const wid = String(body.wagerId || '');
      const gts = Number(req.headers['x-game-ts'] || 0);
      if (!verifyGameProof(req, 'wager-return:' + wid + ':' + gts)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' });
      }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'busy' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (w.status === P2P.STATUS.RETURNED) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        /* Returning an unmatched stake is the ONE refund that must always work. An insolvency hold is
         * cleared and retried — nothing was ever sent in that case — while an ambiguous send failure
         * still stops here for the owner. (The settle path above keeps the strict rule: a winner payout
         * that MIGHT have landed must never be retried automatically.) */
        if (await wgIsHeld(wid)) {
          if (!(await wgHeldRetryable(wid))) {
            clearTimeout(guard); done = true;
            return res.status(200).json({ ok: false, held: true, error: 'held for manual review — refund by hand if needed, will not auto-retry' });
          }
          await wgClearHeld(wid);
          console.log('[wg] retrying held return ' + wid + ' — previous failure was insolvency, nothing was sent');
        }
        /*
         * REVIVE A LAPSED RESERVATION FIRST — otherwise this is a dead end holding real money.
         *
         * 'reserved' is a short-lived claim by an acceptor who is part-way through depositing, and the
         * legal transitions out of it are only ['matched','open']. So a wager whose acceptor walked
         * away at the wrong moment could never match (the claim is stale) and could never be returned
         * (the transition is illegal) — it just sat there, and prod logged
         * `cannot return a reserved wager` over and over while the creator's stake stayed locked in
         * escrow with no path out in either direction.
         *
         * Every other place that reads a wager already reverts a LAPSED claim back to open (the two
         * reconcile passes and the accept path all do it); the return path was the one that did not.
         * An UNEXPIRED reservation is still refused below, which is correct — someone is mid-deposit
         * and their accept must be allowed to land.
         */
        if (w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < Date.now()) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0;
          w.reservedSubject2 = null; w.reservedSubject2Name = ''; w.reservedSubject2Ip = '';
          await wgSave(w);
        }
        // Only an UNMATCHED wager can be returned — a matched one must settle.
        if (!P2P.canTransition(w.status, P2P.STATUS.RETURNED)) {
          clearTimeout(guard); done = true; return res.status(400).json({ error: 'cannot return a ' + w.status + ' wager' });
        }
        const claimed = await kvSetNX('wgpaid:' + wid, '1', WG_PAY_LOCK_TTL);
        if (!claimed) { clearTimeout(guard); done = true; return res.status(200).json({ ok: true, already: true }); }
        const esc = getEscrow();
        const amt = P2P.returnAmount(w.stakeLamports);          // 100%, no fee
        const pay = await wgPayOne(esc, w.creator, amt, 'wager-return');
        if (!pay.ok) {
          await kvDel('wgpaid:' + wid).catch(() => {});
          if (wgRetryableFail(pay.reason)) {
            // Escrow was short and NOTHING was sent. The wager stays OPEN and UNHELD, so the 60s sweep
            // returns it as soon as escrow can cover it. This is the creator's own unmatched stake.
            betAlert('unmatched bet ' + wid + ' could NOT be returned yet (escrow short ' + amt +
                     ' lamports). Nothing was sent; it retries automatically every 60s.');
            clearTimeout(guard); done = true;
            return res.status(503).json({ error: 'escrow is momentarily short — your unmatched stake is safe and will be returned automatically', retry: true });
          }
          await wgSetHeld(wid, 'wager-return failed: ' + (pay.reason || 'unknown'));
          betAlert('wager ' + wid + ' HELD after a failed return (' + (pay.reason || 'unknown') +
                   ') — will NOT auto-retry. Refund the creator by hand if this was real, then leave it.');
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'refund held: ' + (pay.reason || 'unknown'), held: true });
        }
        await kvHincrby(BET_LEDGER, 'betLiability', -amt).catch(() => {});
        await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {});
        w.status = P2P.STATUS.RETURNED; w.payoutTx = pay.sig; w.settledTs = Date.now(); w.fee = 0;
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await wgPush(w.region, w.lobby, 'returned', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w), tx: pay.sig });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    /* ── wager-close-manual: mark wagers terminal that were ALREADY PAID OUT-OF-BAND ────────────
     * The owner refunded wmrsh3egsfqolyv and wmrsh3yhtweug5t by hand after they deadlocked in
     * 'reserved' (see the revive fix in the return path). The settle loop did not know that and kept
     * retrying them forever, so they had to be closed — but closing them must NOT pay anybody, or the
     * owner would be refunding the same stake twice. Precedent: the bounty event where 2nd place was
     * paid manually needed exactly this kind of short-circuit to avoid a double-pay.
     *
     * This moves NO money. It has no call to wgPayOne, wgPayWinnerAndFee or any transfer at all. It:
     *   - takes the `wgpaid:` NX lock PERMANENTLY, so no later retry, sweep or void can ever pay them
     *   - marks the wager settled with manual/paidOutOfBand flags and no payoutTx (there is no tx —
     *     recording a fake one would corrupt the audit trail)
     *   - drops them from the open/live sets so nothing re-queues them
     *
     * It deliberately does NOT touch betLiability. The ledger already reads 0 for these; decrementing
     * would drive it negative and make the solvency gate under-report what is owed to real bettors.
     *
     * GAME_SECRET-HMAC authed, and it only ever acts on wager ids named explicitly in the request —
     * there is no "close everything" form of this on purpose.
     */
    if (action === 'wager-close-manual') {
      const ids = Array.isArray(body.wagerIds) ? body.wagerIds.map(String).slice(0, 25) : [];
      if (!ids.length) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerIds required' }); }
      if (!verifyGameProof(req, 'wager-close-manual:' + ids.slice().sort().join(',') + ':' + (req.headers['x-game-ts'] || ''))) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad proof' });
      }
      const out = [];
      for (const wid of ids) {
        const w = await wgLoad(wid);
        if (!w) { out.push({ id: wid, ok: false, reason: 'not found' }); continue; }
        if (w.status === P2P.STATUS.SETTLED || w.status === P2P.STATUS.RETURNED) {
          out.push({ id: wid, ok: true, already: true, status: w.status }); continue;
        }
        // Hold the pay-lock with no TTL so nothing can ever claim it and send funds.
        await kvSetPerm('wgpaid:' + wid, 'manual-out-of-band').catch(() => {});
        const prev = w.status;
        w.status = P2P.STATUS.SETTLED;
        w.manuallyClosed = true; w.paidOutOfBand = true; w.payoutTx = null; w.fee = 0;
        w.settledTs = Date.now();
        w.closeNote = 'refunded by the operator directly; closed so the retry loop stops. No on-chain payout from settle.';
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await kvZrem('wglive:' + lk, wid).catch(() => {});
        out.push({ id: wid, ok: true, from: prev, to: w.status, moved: 0 });
      }
      betAlert('wagers CLOSED manually (no payout): ' + ids.join(', '));
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, closed: out, lamportsMoved: 0 });
    }

    /* ══ KART ARENA — ENTRY FEES AND PAYOUT ═══════════════════════════════════════════════════════
     * Two actions, split by WHO is allowed to call them, because they need different trust:
     *
     *   kart-entry   the PLAYER pays. Wallet-signed (the gate below), and the deposit is verified
     *                ON CHAIN before anything is issued. Returns an HMAC ticket.
     *   kart-settle  the KART SERVER pays out. GAME_SECRET-HMAC, never reachable from a browser.
     *
     * The ticket is the join between them. The kart server has no wallet, no RPC and no escrow key —
     * it must not, since it is a game process on a box that also runs untrusted physics. So it never
     * decides that someone paid; it is HANDED proof, signed with a secret a client does not have, and
     * checks the signature. A player cannot mint one, and a compromised kart server cannot move money
     * (kart-settle only pays addresses that are in the race it is settling, capped by the pot).
     */
    /*
     * kart-refund — give an entry back IN FULL, no fee. For a paid race that never ran: the creator
     * paid to open the room and nobody else turned up, the lobby was abandoned, the field never
     * reached two. Money taken for a race that did not happen is not the platform's to keep, and
     * without this the first person into an empty room is quietly out of pocket for trying.
     *
     * 100%, not pot-minus-rake: there was no contest, so there is nothing to rake.
     */
    if (action === 'kart-refund') {
      const refundId = String(body.refundId || '').slice(0, 90);
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 8) : [];
      if (!refundId || !entries.length) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'refundId and entries required' }); }
      if (!verifyGameProof(req, 'kart-refund:' + refundId + ':' + (req.headers['x-game-ts'] || ''))) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad proof' });
      }
      const lk = await claimPayFlag('kartrefund:' + refundId, 0);
      if (!lk.claimed) {
        clearTimeout(guard); done = true;
        if (!lk.paid) {
          unresolvedPayFlag('kartrefund:' + refundId, refundId, 0, 'kart-refund');
          return res.status(409).json({ ok: false, unresolved: true, retry: false, refundId,
            error: 'A previous refund for this race never completed — entries were NOT returned. Flagged for the operator; do not retry.' });
        }
        return res.status(200).json({ ok: true, already: true });
      }
      const escR = getEscrow();
      const out = [];
      let returned = 0;
      for (const e of entries) {
        const to = String((e && e.address) || '');
        const lam = Math.floor(Number(e && e.lamports) || 0);
        if (!to || lam <= 0) continue;
        const r = await wgPayOne(escR, to, lam, 'kart-refund:' + refundId);
        if (!r.ok) betAlert('KART refund FAILED ' + refundId + ' -> ' + to.slice(0, 8) + ' : ' + (r.reason || ''));
        else returned += lam;
        out.push({ address: to, lamports: lam, ok: !!r.ok, mayHavePaid: !!r.mayHavePaid, sig: r.sig || null });
      }
      // Same rule as kart-settle: a refund where nothing moved must not stay flagged as done, or the
      // entry is stranded in escrow with no path back to the player.
      //
      // ⚠️ And the same correction: "nothing returned ok" is NOT "nothing moved". This loop is per-entry,
      // so clearing the flag after a send that may have landed re-refunds whoever it did reach.
      if (!out.some((o) => o.ok) && !out.some((o) => o.mayHavePaid)) {
        await kvDel('kartrefund:' + refundId).catch(() => {});
        betAlert('KART refund returned NOTHING for ' + refundId + ' — flag cleared, safe to retry');
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: 'kart refund failed, retryable', retry: true, refundId });
      }
      if (!out.some((o) => o.ok)) {
        betAlert('KART refund UNRESOLVED ' + refundId + ' — nothing confirmed but a transfer MAY have ' +
                 'landed. Flag kartrefund:' + refundId + ' is HELD so a retry cannot refund twice. Check ' +
                 'the entries on-chain and refund by hand if nothing arrived.');
        clearTimeout(guard); done = true;
        return res.status(409).json({ error: 'kart refund unresolved — may already have been sent, not retrying',
          retry: false, held: true, refundId, refunded: out });
      }
      // At least one entry was returned — record it, so a retry can tell this from a died-mid-refund.
      await markPayFlagPaid('kartrefund:' + refundId, (out.find((o) => o.sig) || {}).sig, 0);
      if (returned > 0) await kvHincrby(BET_LEDGER, 'betLiability', -returned).catch(() => {});
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, refundId, refunded: out });
    }

    /*
     * UNCLAIMED PAID ENTRIES — list, and clear the ones already refunded by hand.
     *
     * `pw:<wallet>` is an unconsumed paid wager: money that was taken and has not yet been played or
     * cashed out. When a join fails and the owner refunds the player DIRECTLY, that entry is left
     * behind — and it is not harmless, because the replay guard treats a live `pw:` as proof the
     * player already paid and will let them straight into a race on a deposit that has since been
     * given back. Refunding by hand and leaving the entry is therefore paying twice.
     *
     * `action:'wager-orphans'` lists them so they can be eyeballed first; `action:'clear-entry'`
     * removes named ones. Neither moves any money — clearing is bookkeeping to match a refund that
     * already happened off-chain, which is why it names wallets explicitly and has no "clear all".
     */
    if (action === 'wager-orphans') {
      if (!verifyGameProof(req, 'wager-orphans:' + (req.headers['x-game-ts'] || ''))) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad proof' });
      }
      const keys = await kvScan('pw:*').catch(() => []);
      const out = [];
      for (let i = 0; i < keys.length && out.length < 200; i += 128) {
        const slice = keys.slice(i, i + 128);
        const vals = await kvMget(slice).catch(() => []);
        for (let j = 0; j < slice.length; j++) {
          const lam = Math.floor(Number(vals[j]) || 0);
          if (lam > 0) out.push({ wallet: String(slice[j]).slice(3), lamports: lam, sol: lam / 1e9 });
        }
      }
      out.sort((a, b) => b.lamports - a.lamports);
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, count: out.length, entries: out });
    }

    if (action === 'clear-entry') {
      const wallets = Array.isArray(body.wallets) ? body.wallets.map(String).slice(0, 50) : [];
      if (!wallets.length) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wallets required' }); }
      if (!verifyGameProof(req, 'clear-entry:' + wallets.slice().sort().join(',') + ':' + (req.headers['x-game-ts'] || ''))) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad proof' });
      }
      const cleared = [];
      for (const w of wallets) {
        const had = await kvGet('pw:' + w).catch(() => null);
        if (had === null) { cleared.push({ wallet: w, had: null, cleared: false }); continue; }
        await kvDel('pw:' + w).catch(() => {});
        cleared.push({ wallet: w, had: Math.floor(Number(had) || 0), cleared: true });
      }
      betAlert('paid entries CLEARED (already refunded by hand): ' + wallets.map((w) => w.slice(0, 8)).join(', '));
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, cleared, lamportsMoved: 0 });
    }

    if (action === 'kart-settle') {
      const raceId = String(body.raceId || '').slice(0, 80);
      const winners = Array.isArray(body.winners) ? body.winners.slice(0, 8) : [];
      const potLamports = Math.floor(Number(body.potLamports) || 0);
      if (!raceId || !winners.length || potLamports <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'raceId, winners and potLamports required' }); }
      if (!verifyGameProof(req, 'kart-settle:' + raceId + ':' + potLamports + ':' + (req.headers['x-game-ts'] || ''))) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'bad proof' });
      }
      // ONE PAYOUT PER RACE, permanently. A race id can never be settled twice however many times the
      // kart server retries or restarts.
      // ⚠️ Was `String(Date.now())`, so a flag could not be told apart from a completed one. A race whose
      // settle died mid-payout answered `already: true` to every retry and the pot stayed in escrow.
      const lk = await claimPayFlag('kartpaid:' + raceId, 0);
      if (!lk.claimed) {
        clearTimeout(guard); done = true;
        if (!lk.paid) {
          unresolvedPayFlag('kartpaid:' + raceId, raceId, potLamports, 'kart-settle');
          return res.status(409).json({ ok: false, unresolved: true, retry: false, raceId,
            error: 'A previous settle for this race never completed — the winners were NOT paid. Flagged for the operator; do not retry.' });
        }
        return res.status(200).json({ ok: true, already: true });
      }

      // 10% to the house, the rest split evenly among the winners — ties split, as specified. Dust
      // from the division rides with the fee so escrow stays exact to the lamport.
      const fee = Math.floor(potLamports * 0.10);
      const share = Math.floor((potLamports - fee) / winners.length);
      const esc2 = getEscrow();
      const paid = [];
      for (const w of winners) {
        const to = String((w && w.address) || w || '');
        if (!to) continue;
        const r = await wgPayWinnerAndFee(esc2, to, share, Math.floor(fee / winners.length), 'kart:' + raceId);
        if (!r.ok) betAlert('KART payout FAILED ' + raceId + ' -> ' + to.slice(0, 8) + ' : ' + (r.reason || ''));
        paid.push({ address: to, lamports: share, ok: !!r.ok, mayHavePaid: !!r.mayHavePaid, sig: r.sig || null, reason: r.reason || null });
      }
      // ⚠️ IF NOTHING ACTUALLY WENT OUT, UNDO THE "ALREADY PAID" FLAG.
      // kartpaid:<raceId> is set BEFORE the transfers and has NO TTL, so a race where every send
      // failed (RPC blip, a solvency hold, escrow briefly short) was marked settled FOREVER: the
      // kart server's retry would get {already:true}, the winner would never be paid, and nothing
      // would ever look at it again. Same shape as the blackjack bjpaid bug. Clearing the flag when
      // not one lamport moved makes the race retryable; a PARTIAL success keeps the flag, because
      // re-running it would pay the ones that already landed a second time.
      //
      // ⚠️ "NOT ONE LAMPORT MOVED" IS NARROWER THAN "NOTHING RETURNED ok". A send whose submit call
      // failed may still be in the mempool, and this loop is per-winner, so clearing the flag on that
      // would re-pay whoever it did reach. Only a race where every payout is KNOWN not to have moved is
      // retryable — the rest is reported for the owner to resolve against the chain.
      const anyPaid      = paid.some((p) => p.ok);
      const anyUncertain = paid.some((p) => !p.ok && p.mayHavePaid);
      if (!anyPaid && !anyUncertain) {
        await kvDel('kartpaid:' + raceId).catch(() => {});
        betAlert('KART settle paid NOTHING for ' + raceId + ' — flag cleared, safe to retry');
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: 'kart payout failed, retryable', retry: true, raceId });
      }
      if (!anyPaid) {
        betAlert('KART settle for ' + raceId + ' is UNRESOLVED — no payout confirmed, but at least one ' +
                 'transfer MAY have landed. Flag kartpaid:' + raceId + ' is HELD so a retry cannot pay ' +
                 'twice. Check the winners\' wallets on-chain and pay by hand if nothing arrived.');
        clearTimeout(guard); done = true;
        return res.status(409).json({ error: 'kart payout unresolved — may already have been sent, not retrying',
          retry: false, held: true, raceId, paid });
      }
      // The pot has left the building either way; keeping it as liability would block later payouts.
      await markPayFlagPaid('kartpaid:' + raceId, (paid.find((p) => p.sig) || {}).sig, 0);
      await kvHincrby(BET_LEDGER, 'betLiability', -potLamports).catch(() => {});
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, raceId, feeLamports: fee, paid });
    }

    // ── stake-read: the game server asks what a player ACTUALLY deposited (GAME_SECRET-HMAC) ──────
    // Read-only. Moves nothing, signs nothing, names no escrow account.
    //
    // This exists because the game server had NO honest source for a player's stake. It seeded the
    // snake's value from the CLIENT's own join packet (`d.usd` in _server_na.js), which means every
    // figure downstream of it — the $ over their head, the kill food they drop when they die, the
    // cash-out total — descended from a number the player's own browser picked. `pw:<addr>` is the
    // only trustworthy record of a stake: api/join.js writes it ONLY after verifying the deposit
    // actually landed in escrow on-chain. Handing that figure to the game server is what lets the
    // game server own the value ledger in LAMPORTS and sign the cash-out amount itself — and that
    // is what makes the 20x fraud cap on cashout unnecessary.
    if (action === 'stake-read') {
      const gp  = (req.headers['x-game-proof'] || '').trim();
      const gts = Number(req.headers['x-game-ts'] || 0);
      let authed = false;
      if (GAME_SECRET && gp && gts && Math.abs(Date.now() - gts) < 300000) {
        const expected = crypto.createHmac('sha256', GAME_SECRET).update('stake-read:' + gts).digest('hex');
        try { authed = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) {}
      }
      if (!authed) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }
      const addrs = Array.isArray(body.addresses) ? body.addresses.slice(0, 64).map(a => String(a || '')) : [];
      const stakes = {};
      for (const a of addrs) {
        if (!a || a.length < 32 || a.length > 64) continue;
        stakes[a] = Math.max(0, Math.floor(Number(await kvGet('pw:' + a)) || 0));
      }
      clearTimeout(guard); done = true;
      /* `requireCashProof` rides along on this already-GAME_SECRET-authed read so the guard's state is
       * checkable from a machine that legitimately holds the secret — i.e. either game node — without
       * exposing it publicly and without a new endpoint.
       *
       * It is here because the flag CANNOT BE READ any other way. This project stores env vars as
       * "sensitive": `vercel env ls` and the REST API both return "" for the value whatever it is, and
       * console.log does not surface in the runtime-log view on this plan. That is how the flag came to
       * be created EMPTY and then deployed under the title "rebuild so CASHOUT_REQUIRE_PROOF=1 takes
       * effect" — nothing outside the function could tell armed from disarmed, and the guard standing
       * between a forged cash-out claim and the escrow was in an unknown state for two hours.
       *
       * The game server also has a real use for it: with the guard ON, a paid cash-out that mints no
       * proof is refused outright, so `NO cash proof` in the node's log stops being a note and becomes
       * the reason a player could not get paid. */
      return res.status(200).json({ ok: true, stakes,
        requireCashProof: REQUIRE_CASH_PROOF, gameSecret: GAME_SECRET.length });
    }

    /* ── forfeit: a paid Pac-Man player left and never came back (GAME_SECRET-HMAC) ────────────────
     * Server-to-server twin of `lose`. `lose` is signed by the PLAYER's wallet, which is exactly what
     * a vanished player cannot provide — so Pac-Man resolved a disconnect by doing nothing at all: the
     * player was deleted from the room and their `pw:` record simply expired after 4h. The stake sat
     * in escrow credited to nobody, which is a genuine contributor to the "why is there extra money in
     * escrow" confusion.
     *
     * FORFEIT TO THE HOUSE, never a refund. Owner's rule, all four games: once the wager is in, it is
     * locked until cash-out — a disconnect is the player's problem, exactly like dying. Snake already
     * behaves this way (it sheds the stake as food, same as a death); this gives Pac-Man the
     * equivalent, since it has no food to shed into. */
    if (action === 'forfeit') {
      const gp  = (req.headers['x-game-proof'] || '').trim();
      const gts = Number(req.headers['x-game-ts'] || 0);
      const who = String(body.playerAddress || '').trim();
      let authed = false;
      if (GAME_SECRET && gp && gts && who && Math.abs(Date.now() - gts) < 300000) {
        const expected = crypto.createHmac('sha256', GAME_SECRET).update('forfeit:' + who + ':' + gts).digest('hex');
        try { authed = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(gp)); } catch (_) {}
      }
      if (!authed) { clearTimeout(guard); done = true; return res.status(403).json({ error: 'Forbidden' }); }

      const fLock = await kvSetNX('lock:ff:' + who, '1', 20);
      if (!fLock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'forfeit already in progress' }); }
      try {
        // GETDEL: consume the record atomically so a duplicated disconnect callback cannot sweep twice.
        const stake = Number(await kvGetDel('pw:' + who)) || 0;
        if (stake <= 0) {   // already resolved by a death, a cash-out, or an earlier forfeit
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, amount: 0, already: true });
        }
        const escF = getEscrow();
        try {
          const { bal, blockhash } = await fetchBalAndHash(escF.pubkeyB58);
          const avail = bal - TX_FEE;
          if (avail <= 0) throw new Error('escrow empty');
          const take = Math.min(stake, avail);
          const remaining = avail - take;
          const finalAmt = (remaining > 0 && remaining < RENT_MIN) ? avail : take;
          // House nets the stake minus this tx's network fee, so escrow's outflow is exactly the
          // liability being cleared and it never leaks — same self-funding rule as cashout and lose.
          const houseTake = Math.max(0, finalAmt - TX_FEE);
          const tx = buildTx(escF, blockhash, [{ to: b58Decode(CREATOR_WALLET), lamports: houseTake }]);
          const { sig: fsig, confirmed } = await sendAndConfirm(tx);
          try { await kvDel('krl:' + who); await kvDel('kc:' + who); } catch (_) {}
          try {
            await kvHincrby('ph:' + game + ':' + who, 'losses', 1);
            await kvHincrby('ph:' + game + ':' + who, 'deaths', 1);
          } catch (_) {}
          console.log('[settle] FORFEIT ' + who.slice(0, 8) + ' stake=' + stake + ' house=' + houseTake + ' game=' + game);
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, amount: houseTake, sig: fsig, confirmed });
        } catch (e) {
          /* The sweep did not happen, so nothing left escrow. Do NOT restore `pw:` — the player has
           * already forfeited and restoring it would make the stake claimable again by a returning
           * client. The money stays in escrow as unattributed surplus, which the solvency check will
           * report as free to withdraw. Erring toward surplus, never toward a double claim. */
          betAlert('FORFEIT sweep failed for ' + who.slice(0, 8) + ' (' + ((e && e.message) || e) +
                   '). Stake ' + stake + ' stays in escrow as surplus — pw: already cleared, nothing is owed.');
          clearTimeout(guard); done = true;
          return res.status(200).json({ ok: true, amount: 0, swept: false });
        }
      } finally { await kvDel('lock:ff:' + who).catch(() => {}); }
    }

    // ── Wallet signature auth — required for all fund-moving actions ─────────
    // The player signs the request with their Solana private key.
    // Only the real wallet owner can produce a valid signature.
    // 'solvency' joins 'balance' as unsigned: both are READ-ONLY views of public on-chain state
    // plus aggregate liability totals. No wallet is named, nothing is mutated, no funds move.
    // 'ref-balance' is unsigned too: a referrer's accrued balance + stats are not secret and nothing
    // moves — it's the read behind the streamer's earnings panel. The PAYOUT (ref-claim) is signed.
    if (action !== 'balance' && action !== 'solvency' && action !== 'ref-balance') {
      const sig = req.headers['x-settle-sig'] || '';
      const ts  = req.headers['x-settle-ts']  || '';
      if (!verifyPlayerSig(sig, ts, action, playerAddress || '', wagerLamportsRaw)) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Invalid wallet signature — cashout must originate from the game client' });
      }
    }

    // kart-entry sits AFTER the signature gate deliberately: the caller must prove with their wallet
    // key that they are the address the ticket will be issued to. The on-chain check alone is not
    // enough — it proves a deposit happened, not that the person asking is the one who made it.
    if (action === 'kart-entry') {
      const lobbyId = String(body.lobbyId || '').slice(0, 40);
      const cents   = Math.round(Number(body.stakeCents) || 0);
      const txSig   = String(body.txSig || '').slice(0, 128);
      const addr    = String(playerAddress || '');
      if (!lobbyId || !txSig || !addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'lobbyId, txSig and playerAddress required' }); }
      if (!(cents >= 10 && cents <= 50000)) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'stake out of range' }); }

      // ONE ENTRY PER DEPOSIT. Taken before the chain is even consulted, so two racers cannot both
      // present the same txSig and both get a ticket — the second caller loses the race for this key
      // and is told so, rather than being quietly issued a duplicate entry off one payment.
      const txLock = await kvSetNX('karttx:' + txSig, addr + ':' + lobbyId, 6 * 60 * 60);
      if (!txLock) { clearTimeout(guard); done = true; return res.status(409).json({ error: 'that deposit has already been used' }); }

      const price = await solUsdQuick();
      if (!(price > 0)) { await kvDel('karttx:' + txSig).catch(() => {}); clearTimeout(guard); done = true;
        return res.status(503).json({ error: 'no SOL price right now — try again', retry: true }); }
      // Round DOWN what we demand, so a cent of price drift between quote and payment cannot reject a
      // deposit the player made in good faith.
      const wantLamports = Math.floor((cents / 100) / price * 1e9 * 0.97);
      const esc = getEscrow();
      try {
        await verifyBetDepositTx(txSig, addr, wantLamports, esc.pubkeyB58);
      } catch (e) {
        // Release the lock: an unconfirmed deposit must be retryable with the SAME signature, or a
        // player whose RPC was merely slow would be permanently unable to use the money they sent.
        await kvDel('karttx:' + txSig).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(400).json({ error: String((e && e.message) || 'deposit not verified'), retry: true });
      }

      // The stake is now escrow money owed back out to this race — it belongs in the same liability
      // the solvency gate protects, exactly like a bet stake.
      const paidLamports = wantLamports;
      await kvHincrby(BET_LEDGER, 'betLiability', paidLamports).catch(() => {});
      await kvSetPerm('kartentry:' + lobbyId + ':' + addr, JSON.stringify({ cents, lamports: paidLamports, txSig, ts: Date.now() })).catch(() => {});

      const tts = Date.now();
      const ticket = [lobbyId, addr, String(cents), String(paidLamports), String(tts)].join('|');
      const tsig = crypto.createHmac('sha256', GAME_SECRET).update('kart-entry:' + ticket).digest('hex');
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, ticket, tsig, lamports: paidLamports });
    }


    // ── ref-balance: read-only view of a referrer's accrued earnings (unsigned) ───────────────────
    if (action === 'ref-balance') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const owed  = Math.floor(Number(await kvGet('refbal:' + playerAddress)) || 0);
      const stats = (await kvHgetall('refstats:' + playerAddress)) || {};
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, owedLamports: owed, minClaimLamports: REF_MIN_CLAIM,
        players: Number(stats.players) || 0, joins: Number(stats.joins) || 0,
        accruedLamports: Number(stats.accrued) || 0, paidLamports: Number(stats.paid) || 0 });
    }

    const esc = getEscrow();

    // ── ref-claim: a referrer withdraws their accrued referral rewards ───────────────────────────
    // The wallet signature above (action='ref-claim', playerAddress=referrer, wagerLamports=0) proves
    // the caller owns the referrer wallet. Payment goes through wgPayOne, which is gated by the global
    // solvency invariant — so a referral withdrawal can ONLY ever spend genuine surplus (unswept
    // platform fees sitting in escrow) and can NEVER touch a player deposit or a bettor's stake. If
    // there isn't enough surplus yet, the claim is refused and the balance stays intact to try later.
    if (action === 'ref-claim') {
      /* ⚠️ PROGRAM OFF — the withdrawal half of the same switch as REFERRAL_REWARDS_ENABLED in
       * api/join.js. Disabling only the accrual would leave this endpoint able to move escrow money
       * on demand, which is the whole thing the owner asked to stop. Every `refbal:` balance was
       * verified ZERO before this went in, so no genuinely-earned reward is being refused; nothing is
       * deleted either, so re-enabling both flags resumes exactly where it left off. */
      if (!REFERRAL_REWARDS_ENABLED) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'The referral reward program is not running.' });
      }
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      // One claim at a time per wallet, so two concurrent claims can't both read the balance and pay.
      const rcLock = await kvSetNX('lock:rc:' + playerAddress, '1', 20);
      if (!rcLock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'Claim already in progress — try again shortly' }); }
      try {
        // GETDEL: read and zero the balance atomically, so a retry or a race can't double-pay.
        const owed = Math.floor(Number(await kvGetDel('refbal:' + playerAddress)) || 0);
        if (owed <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Nothing to claim yet' }); }
        // Don't send a payout worth less than a few network fees — leave it accruing until it's worth it.
        if (owed < REF_MIN_CLAIM) {
          await kvIncrby('refbal:' + playerAddress, owed).catch(() => {}); // put it back
          clearTimeout(guard); done = true;
          return res.status(400).json({ error: 'Below minimum claim (' + (REF_MIN_CLAIM / 1e9).toFixed(4) + ' SOL) — keep earning', owedLamports: owed, minLamports: REF_MIN_CLAIM });
        }
        const pay = await wgPayOne(esc, playerAddress, owed, 'ref-claim', { protectPlayers: true });
        if (!pay.ok) {
          /* ⚠️ The balance was consumed with GETDEL, so restoring it is the same decision as releasing a
           * pay-lock — and it is only safe when nothing can have moved. A send whose response was lost
           * may still land, and restoring `refbal:` there means the referrer holds the SOL AND a
           * claimable balance: they claim again and are paid twice. Insolvency and an on-chain rejection
           * restore as before, which is what this branch was for. */
          if (!pay.mayHavePaid) {
            await kvIncrby('refbal:' + playerAddress, owed).catch(() => {});
            clearTimeout(guard); done = true;
            return res.status(503).json({ error: 'Payout temporarily unavailable — your balance is safe, try again shortly', retry: true });
          }
          await kvSetPerm('refclaimheld:' + playerAddress, JSON.stringify({ owedLamports: owed, ts: Date.now(), reason: pay.reason || '' })).catch(() => {});
          betAlert('REF-CLAIM UNRESOLVED ' + String(playerAddress).slice(0, 8) + ' owed=' + owed + ' : ' +
                   (pay.reason || '') + ' — MAY have landed, so the balance was NOT restored. Check the ' +
                   'wallet on-chain: if it arrived, DEL refclaimheld:' + String(playerAddress) + '. If not, ' +
                   'INCRBY refbal:' + String(playerAddress) + ' ' + owed + '.');
          clearTimeout(guard); done = true;
          return res.status(409).json({ held: true, retry: false,
            error: 'Your claim is being checked — the transfer may already have gone through. Nothing is lost.' });
        }
        await kvHincrby('refstats:' + playerAddress, 'paid', owed).catch(() => {});
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, paidLamports: owed, sig: pay.sig, confirmed: pay.confirmed });
      } finally { await kvDel('lock:rc:' + playerAddress).catch(() => {}); }
    }

    // ── wager-create: a spectator opens a P2P wager and escrows their stake ──────────────────────
    // Layered auth: the wallet signature above proves ownership; the snake's GAME_SECRET signature
    // proves the subject really is in that arena (so it can always settle); the on-chain tx proves
    // the stake actually landed. Only ADDS to escrow, so no solvency gate is needed here.
    if (action === 'wager-create') {
      const creator = playerAddress;
      const stake   = wagerLamportsRaw;
      const region  = String(body.region || 'NA').toUpperCase() === 'EU' ? 'EU' : 'NA';
      const lobby   = String(body.lobby || '');
      const typeId  = String(body.type || '');
      const side    = String(body.side || '');
      const now     = Date.now();
      const lockTs  = now + WG_OPEN_WINDOW_MS;

      if (!creator || b58Decode(creator).length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'bad creator address' }); }

      const isDuel = body.duel === true || body.duel === 'true';
      const vErr = P2P.validateCreate({ typeId, side, stakeLamports: stake, lockTs, nowMs: now,
        // subject2 is passed through UNCHANGED even for a duel: the engine must REJECT a duel that
        // tries to name its opponent, not silently drop it. Nulling it here would have hidden the
        // rule and quietly created a different wager than the caller asked for.
        subject: body.subject, subject2: body.subject2,
        minStake: WG_MIN_STAKE, maxStake: WG_MAX_STAKE, creator, duel: isDuel });
      if (vErr) { clearTimeout(guard); done = true; return res.status(400).json({ error: vErr }); }

      // Subject snake(s) must carry the game server's signature for THIS arena.
      if (!verifySnakeSig(region, lobby, body.subject, body.subjectName, body.subjIpHash, body.subjExp, body.subjSig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired snake — refresh and try again' });
      }
      // A duel names BOTH snakes up front, same as any outlast — it differs only in how it settles.
      const needs2 = P2P.getBetType(typeId).needsSubject2;
      if (needs2 && !verifySnakeSig(region, lobby, body.subject2, body.subject2Name, body.subj2IpHash, body.subj2Exp, body.subj2Sig)) {
        clearTimeout(guard); done = true; return res.status(403).json({ error: 'Invalid or expired second snake' });
      }

      // Back your own snake to WIN: allowed. Take a side that pays when a snake you control
      // loses: refused (that's the riggable direction).
      const rigErr = await wgRigCheck({
        bettor: creator, typeId, side,
        subject: body.subject, subject2: needs2 ? body.subject2 : null,
        subjectIpHash: body.subjIpHash, subject2IpHash: needs2 ? body.subj2IpHash : null,
        req,
      });
      if (rigErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: rigErr }); }

      const txSig = body.txSig;
      if (!txSig) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'txSig required' }); }
      if (await kvGet('wgtx:' + txSig) !== null) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Deposit already used' }); }
      await verifyBetDepositTx(txSig, creator, stake, esc.pubkeyB58);
      await kvSet('wgtx:' + txSig, '1', WG_PAY_LOCK_TTL);

      const id = 'w' + now.toString(36) + Math.random().toString(36).slice(2, 8);
      const w = {
        id, region, lobby, type: typeId, side, duel: isDuel,
        subject: body.subject, subjectName: String(body.subjectName || '').slice(0, 20),
        subject2: body.subject2 || null,
        subject2Name: String(body.subject2Name || '').slice(0, 20),
        // kept so the ACCEPTOR can be self-bet checked too (never exposed publicly)
        subjIpHash: body.subjIpHash || '', subj2IpHash: body.subj2IpHash || '',
        durationMs: Math.max(0, Math.floor(Number(body.durationMs) || 0)),
        stakeLamports: stake, creator, creatorName: String(body.creatorName || '').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 16),
        acceptor: null, acceptorName: null, status: P2P.STATUS.OPEN,
        createdTs: now, lockTs, createTx: txSig,
      };
      await wgSave(w);
      const lk = wgLobbyKey(region, lobby);
      await kvZadd('wgopen:' + lk, now, id);
      await kvExpire('wgopen:' + lk, WG_TTL).catch(() => {});
      await kvZadd('wgu:' + creator, now, id);
      await kvExpire('wgu:' + creator, WG_TTL).catch(() => {});
      await kvHincrby(BET_LEDGER, 'betLiability', stake);
      await wgPush(region, lobby, 'created', wgPublic(w));
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, wager: wgPublic(w) });
    }

    // ── wager-reserve: atomically CLAIM an open wager before depositing ──────────────────────────
    // This is what makes double-accept impossible AND stops anyone paying for a wager someone else
    // just took. The claim auto-expires (WG_RESERVE_MS) and the wager returns to the book.
    if (action === 'wager-reserve') {
      const taker = playerAddress;
      const wid   = String(body.wagerId || '');
      if (!taker || !wid) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 20);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'Someone else is taking this wager' }); }
      try {
        const w = await wgLoad(wid);
        const now = Date.now();
        // A stale reservation silently reverts to open before we validate.
        if (w && w.status === P2P.STATUS.RESERVED && Number(w.reservedUntil || 0) < now) {
          w.status = P2P.STATUS.OPEN; w.reservedBy = null; w.reservedUntil = 0; await wgSave(w);
          await kvZadd('wgopen:' + wgLobbyKey(w.region, w.lobby), w.createdTs, wid);
        }
        const aErr = P2P.validateAccept({ wager: w, acceptor: taker, nowMs: now });
        if (aErr) { clearTimeout(guard); done = true; return res.status(409).json({ error: aErr }); }

        // ── ANTI-SNIPE — every subject must still be in the arena RIGHT NOW ──────────────────────
        // Without this, any wager whose outcome had already been decided during its open window was
        // free money for the taker (see isFreshSnakeSig). The taker proves liveness by presenting
        // the CURRENT signed roster entry for each subject; a snake that has died or cashed out is
        // no longer in the roster, so no such signature can exist.
        const freshSubj = isFreshSnakeSig(w.region, w.lobby, w.subject, w.subjectName, w.subjIpHash || '', body.subjExp, body.subjSig);
        if (!freshSubj) {
          clearTimeout(guard); done = true;
          return res.status(409).json({ error: 'That snake is no longer in the arena — this bet can no longer be taken' });
        }
        if (w.subject2) {
          const fresh2 = isFreshSnakeSig(w.region, w.lobby, w.subject2, w.subject2Name, w.subj2IpHash || '', body.subj2Exp, body.subj2Sig);
          if (!fresh2) {
            clearTimeout(guard); done = true;
            return res.status(409).json({ error: 'One of those snakes is no longer in the arena — this bet can no longer be taken' });
          }
        }

        // A duel names both snakes at creation now, so there is nothing extra to supply here — the
        // taker simply takes the other side, and the freshness check above already proved BOTH
        // snakes are still in the arena.
        // The acceptor takes the OPPOSITE side, so the rig check must run against THAT side — not
        // the creator's. Backing your own snake to win is fine; being handed the "this snake dies"
        // side of a wager on a snake you control is exactly the riggable case.
        const takerSide = P2P.opposingSide(w.type, w.side);
        const rigErr = await wgRigCheck({
          bettor: taker, typeId: w.type, side: takerSide,
          subject: w.subject, subject2: w.subject2,
          subjectIpHash: w.subjIpHash || '', subject2IpHash: w.subj2IpHash || '',
          req,
        });
        if (rigErr) { clearTimeout(guard); done = true; return res.status(403).json({ error: rigErr }); }
        w.status = P2P.STATUS.RESERVED; w.reservedBy = taker; w.reservedUntil = now + WG_RESERVE_MS;
        await wgSave(w);
        // ⚠️ DO NOT remove it from the wgopen: index here. It used to be zrem'd "so it leaves the book
        // at once" — but wager-list reads ONLY wgopen:/wglive:, and a reserved wager is in neither
        // until the accept lands. That ORPHANED it: invisible to wager-list, so invisible to the game
        // server's reconcile, and ssWagerTick never handled 'reserved' either. If the accept never
        // completed, the wager sat in 'reserved' forever — never matched, never returned, the
        // creator's stake stuck in escrow. That is the "friend's money stuck pending" bug.
        // It still leaves the *takeable* book instantly because wager-list filters on status==='open'.
        await wgPush(w.region, w.lobby, 'reserved', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, stake: w.stakeLamports, expiresTs: w.reservedUntil, wager: wgPublic(w) });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // ── wager-accept: acceptor's deposit landed → MATCH the wager and lock it ────────────────────
    if (action === 'wager-accept') {
      const taker = playerAddress;
      const wid   = String(body.wagerId || '');
      const txSig = body.txSig;
      if (!taker || !wid || !txSig) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId + txSig required' }); }
      const lock = await kvSetNX('lock:wg:' + wid, '1', 45);
      if (!lock) { clearTimeout(guard); done = true; return res.status(429).json({ error: 'busy' }); }
      try {
        const w = await wgLoad(wid);
        if (!w) { clearTimeout(guard); done = true; return res.status(404).json({ error: 'wager not found' }); }
        if (await kvGet('wgtx:' + txSig) !== null) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Deposit already used' }); }
        // The deposit is real regardless of whether the match still stands — verify it first.
        await verifyBetDepositTx(txSig, taker, w.stakeLamports, esc.pubkeyB58);
        await kvSet('wgtx:' + txSig, '1', WG_PAY_LOCK_TTL);

        const now = Date.now();
        const claimOk = (w.status === P2P.STATUS.RESERVED && w.reservedBy === taker && Number(w.reservedUntil || 0) >= now);
        if (!claimOk || !(now < Number(w.lockTs))) {
          // Their money landed but the wager is no longer theirs to take → return it immediately.
          await kvHincrby(BET_LEDGER, 'betLiability', w.stakeLamports);   // briefly owed to them
          const back = await wgPayOne(esc, taker, w.stakeLamports, 'wager-accept-refund');
          if (back.ok) { await kvHincrby(BET_LEDGER, 'betLiability', -w.stakeLamports).catch(() => {}); await kvHincrby(BET_LEDGER, 'accruedFee', -TX_FEE).catch(() => {}); }
          clearTimeout(guard); done = true;
          return res.status(409).json({ error: 'That wager was taken first — your deposit was returned', refundTx: back.sig || null });
        }
        w.status = P2P.STATUS.MATCHED; w.acceptor = taker;
        w.acceptorName = String(body.acceptorName || '').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 16);
        w.matchedTs = now; w.acceptTx = txSig; w.reservedBy = null; w.reservedUntil = 0;
        // A "survive N" wager's clock starts when both sides are locked in — fair to creator and taker.
        if (w.type === 'survive' && w.durationMs > 0) w.resolveTs = now + w.durationMs;
        await wgSave(w);
        const lk = wgLobbyKey(w.region, w.lobby);
        await kvZrem('wgopen:' + lk, wid).catch(() => {});
        await kvZadd('wglive:' + lk, w.createdTs, wid);
        await kvExpire('wglive:' + lk, WG_TTL).catch(() => {});
        await kvZadd('wgu:' + taker, w.createdTs, wid);
        await kvExpire('wgu:' + taker, WG_TTL).catch(() => {});
        await kvHincrby(BET_LEDGER, 'betLiability', w.stakeLamports);   // pot is now 2× stake
        await wgPush(w.region, w.lobby, 'matched', wgPublic(w));
        clearTimeout(guard); done = true;
        return res.status(200).json({ ok: true, wager: wgPublic(w) });
      } finally { await kvDel('lock:wg:' + wid).catch(() => {}); }
    }

    // NOTE: there is deliberately NO wager-cancel action. Once a wager is placed it must run to a
    // conclusion — matched wagers SETTLE on game truth, and an unmatched one is RETURNED in full at
    // lock by wager-return. Removing the endpoint (not just the button) means a creator cannot pull a
    // wager back via the API either, which also closes the free-option abuse: post a wager, watch how
    // the snake starts doing, then yank it before anyone can take the other side.

    // ── wager-hide: clear finished tickets off YOUR OWN bet slip ────────────────────────────────
    // Deliberately does NOT delete the wager record. `wg:<id>` is financial history: the sweep, the
    // settle idempotency guards (wgpaid:/wgvoid:) and any dispute all read it. What gets removed is
    // the id from `wgu:<address>` — the caller's personal index — so the ticket disappears from
    // THEIR slip and nobody else's, and nothing about the money changes.
    //
    // Guards:
    //   * signature-gated (this block sits below the wallet-signature check), so you can only ever
    //     clear your own slip.
    //   * TERMINAL statuses only. An open/reserved/matched wager still has money riding on it, and
    //     hiding it would let someone lose track of a stake that is still owed to them.
    //   * you must actually be a party to it.
    // `all: true` clears every finished ticket in one go; otherwise pass a single wagerId.
    if (action === 'wager-hide') {
      const addr = playerAddress;
      if (!addr) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const TERMINAL = [P2P.STATUS.SETTLED, P2P.STATUS.RETURNED, P2P.STATUS.CANCELLED];
      const wantAll = body.all === true || body.all === 'true';
      let ids = [];
      if (wantAll) {
        const z = await kvZrevrange('wgu:' + addr, 0, 199);
        if (Array.isArray(z)) for (let i = 0; i < z.length; i += 2) ids.push(z[i]);
      } else {
        const one = String(body.wagerId || '');
        if (!one) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'wagerId or all required' }); }
        ids = [one];
      }
      let hidden = 0, skipped = 0;
      for (const id of ids) {
        const w = await wgLoad(id);
        if (!w) { await kvZrem('wgu:' + addr, id).catch(() => {}); hidden++; continue; }  // dangling id
        const mine = (w.creator === addr || w.acceptor === addr);
        const finished = TERMINAL.indexOf(w.status) >= 0;
        if (!mine || !finished) { skipped++; continue; }
        await kvZrem('wgu:' + addr, id).catch(() => {});
        hidden++;
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true, hidden, skipped,
        note: skipped ? 'skipped bets that are still live or not yours' : undefined });
    }

    /* ── solvency: READ-ONLY view of escrow vs every claim against it ──────────────────────────
     * There was no way to see this from outside, which is exactly why "it says he won but nobody got
     * the money" was a mystery: the refusal is silent to the player. This exposes the same figures
     * assertSolvency() uses plus what a hypothetical payout would do. Moves no money, mutates
     * nothing, reveals no secrets — the escrow balance is already public via action:'balance'.
     *
     * ⚠️ `accruedFee` IS NOT A LIABILITY AND DOES NOT GATE ANYTHING. Read that before reacting to it.
     * It is a dead counter from the old design, where the 8% was tracked as still sitting inside
     * escrow. The fee now leaves escrow in the SAME transaction that pays the winner, so nothing in
     * this codebase increments it any more — every remaining reference is a `-TX_FEE` decrement — and
     * checkInvariant() deliberately excludes it, because the platform's own profit is JUNIOR to
     * everyone and absorbs shortfalls rather than creating them.
     *
     * This mattered: the stale figure (0.0274 SOL against an escrow of 0.0175) was read as "the fee
     * owed exceeds the entire escrow", and a whole session went looking for a leak that was not
     * there. The real cause of `payout held: insolvent` is the plain one directly below —
     * escrow < payout + txFee + what is still owed to OTHER bettors. It is now labelled and the
     * figure that actually decides the refusal is reported alongside it.
     */
    if (action === 'solvency') {
      const probe = Math.max(0, Math.floor(Number(body.payoutLamports) || 0));
      const inv = await assertSolvency(esc.pubkeyB58, probe);
      const sol = l => (Number(l) || 0) / 1e9;
      clearTimeout(guard); done = true;
      return res.status(200).json({
        ok: true,
        escrowPubkey: esc.pubkeyB58,
        // What a payout is ACTUALLY tested against, so the answer to "why was this refused?" is here
        // rather than inferred from the raw figures.
        gate: {
          formula: 'bet/cashout payouts: escrow - payout - txFee >= betLiability - payout   |   ' +
                   'house-funded prizes & ref-claims: escrow - payout - txFee >= betLiability - payout + wagerLiability',
          spendableNowLamports: Math.max(0, inv.onChainBalance - TX_FEE),
          spendableNowSol: sol(Math.max(0, inv.onChainBalance - TX_FEE)),
          owedToOtherBettorsLamports: inv.betLiability,
          largestPayoutThatWouldClearLamports: Math.max(0, inv.onChainBalance - TX_FEE),
          /* ⚠️ THE NUMBER TO READ BEFORE GIVING ANYTHING AWAY. `spendableNow` is what a PLAYER can be
           * paid — it is allowed to draw on player deposits because that IS what deposits are for. It
           * is NOT free money, and reading it as "the float" is what made a $10 prize look affordable
           * against a $10.79 escrow that already owed $5.40 to three people mid-match on 2026-08-07.
           * This figure subtracts everything owed, so it is the real answer to "what is actually mine".
           * It also still UNDERSTATES the liability: a killed player's stake is deleted from `pw:` and
           * lives on as gold orbs on the arena floor, which nothing counts until the room empties and
           * parks them (parkedFoodLamports below). Treat a small positive number here as zero. */
          houseFundedSpendableLamports: Math.max(0, inv.onChainBalance - TX_FEE - inv.betLiability - inv.wagerLiability),
          houseFundedSpendableSol: sol(Math.max(0, inv.onChainBalance - TX_FEE - inv.betLiability - inv.wagerLiability)),
        },
        lamports: {
          escrow: inv.onChainBalance,
          playerDeposits: inv.wagerLiability,
          betLiability: inv.betLiability,
          accruedFee: inv.accruedFee,
        },
        sol: {
          escrow: sol(inv.onChainBalance),
          playerDeposits: sol(inv.wagerLiability),
          betLiability: sol(inv.betLiability),
          accruedFee: sol(inv.accruedFee),
        },
        accruedFeeNote: 'LEGACY COUNTER — not a liability, not part of the solvency gate. Nothing ' +
          'increments it; the 8% now leaves escrow in the same tx as the payout. Ignore it when ' +
          'diagnosing a refused payout.',
        probePayoutLamports: probe,
        payoutsWouldSucceed: !!inv.ok,
        deficitLamports: inv.deficit || 0,
        deficitSol: sol(inv.deficit || 0),
        reason: inv.reason || null,
      });
    }

    // ── balance ───────────────────────────────────────────────────────────────
    if (action === 'balance') {
      const bal = await rpc('getBalance', [esc.pubkeyB58, { commitment: 'confirmed' }]);
      clearTimeout(guard); done = true;
      return res.status(200).json({ balance: bal.value, escrowPubkey: esc.pubkeyB58, solBalance: bal.value / 1e9 });
    }

    // ── stat-loss: record a death + loss on the leaderboard (NO money moves) ─────
    // The client calls this whenever a paid player is eliminated. It only touches the stat
    // counters — there is zero fund transfer here — so it is safe to record on every death. This
    // is the SINGLE source of truth for a player's own deaths+losses (the kill handler below no
    // longer also bumps the victim's deaths, which is why 'losses' used to sit at 0 and K/D looked
    // wrong: nothing was ever writing them). Signature-gated like every other non-balance action,
    // so only the wallet owner can record their own loss (and inflating your own losses only ever
    // hurts your own K/D — there's no incentive to abuse it).
    if (action === 'stat-loss') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      try {
        await kvHincrby('ph:' + game + ':' + playerAddress, 'losses', 1);
        await kvHincrby('ph:' + game + ':' + playerAddress, 'deaths', 1);
      } catch (_) {}
      clearTimeout(guard); done = true;
      return res.status(200).json({ ok: true });
    }

    // ── cashout / win ─────────────────────────────────────────────────────────
    if (action === 'cashout' || action === 'win') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      const playerPubkey = b58Decode(playerAddress);
      if (playerPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be a 32-byte Solana address' }); }

      // NX lock: only one cashout can run at a time per wallet.
      // Prevents two concurrent requests from both reading kvWager > 0 and both sending txs.
      const coLockKey = 'lock:co:' + playerAddress;
      const coLock = await kvSetNX(coLockKey, '1', 20);
      if (!coLock) {
        // A falsy NX result means EITHER the lock is genuinely held OR KV is unreachable — lib/kv.js
        // collapses every infrastructure failure into the same null. Those two need OPPOSITE
        // responses: one clears in a couple of seconds, the other is a total outage that no amount
        // of retrying will fix. Conflating them is what made a dead KV present to every single
        // player as "cashout already in progress", burning all four client retries and leaving them
        // on a screen that says the payout did not complete. Ping to tell them apart and say which.
        const kvUp = await kvPing();
        clearTimeout(guard); done = true;
        if (!kvUp) {
          console.error('[settle] CASHOUT BLOCKED — KV unreachable, wallet=' + playerAddress);
          return res.status(503).json({
            error: 'Payout system temporarily unavailable — your wager is safe and still on record. Try Cash Out again shortly.',
            kvDown: true, retry: true });
        }
        return res.status(429).json({ error: 'Cashout already in progress — wait a moment and try again' });
      }

      try {
        // Dead check: if the kill handler (or elim-lock) already marked this player dead,
        // refuse cashout even if their wager record briefly still exists.
        const isDead = await kvGet('dead:' + playerAddress);
        if (isDead) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'Cannot cashout — you were eliminated' });
        }
        // GETDEL atomically reads and deletes the wager in one step.
        // This eliminates the race where a kill could delete it after we read it but before we finish.
        const kvWager = Number(await kvGetDel('pw:' + playerAddress)) || 0;
        if (kvWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'No wager on record — you may have been eliminated or already cashed out' });
        }
        // Second dead check: catches kills that raced with our kvGetDel above.
        // elim-lock or settle/kill may have set dead: in the ~5 ms between our first check and here.
        // Restore the wager so the kill-reward path is unaffected, then reject.
        const isDeadNow = await kvGet('dead:' + playerAddress);
        if (isDeadNow) {
          kvSet('pw:' + playerAddress, String(kvWager), 600).catch(() => {});
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'Cannot cashout — you were eliminated' });
        }
        /* How much do we owe? There are two answers, and only one of them is honest.
         *
         * `wagerLamportsRaw` is the figure the PLAYER's client claims. It is signed by their wallet,
         * but a wallet signature proves *identity*, not *honesty* — the player chooses what they
         * sign, so a modified client can claim any number it likes. That is why this path used to
         * clamp to `kvWager * 20`: the cap was the only thing standing between a forged claim and
         * the whole escrow balance. It was also wrong for honest players, because carried money is
         * real (you eat other players' dropped food), so a legitimate 30x run got truncated.
         *
         * `cashProof` is the figure the GAME SERVER attests to, HMAC'd with GAME_SECRET over
         * cashout:<addr>:<lobby>:<base>:<carried>:<ts>. The game server owns the value ledger in
         * lamports — seeded from the on-chain deposit via stake-read, grown only by kill food it
         * spawned itself — so it cannot be talked into a number by a browser. Same trust model as
         * the kill proofs and elim-lock already running through this file.
         *
         * With a proof we pay the server's figure EXACTLY and no cap applies, which is the point:
         * the cap only ever existed to bound a forgeable claim. Without one we fall back to the old
         * capped path so a stale cached client (or a node that has not taken the patch yet) can
         * still cash out rather than being stranded — but it is logged, and CASHOUT_REQUIRE_PROOF=1
         * turns the fallback off once both nodes are confirmed minting proofs.
         */
        const cpProof = typeof body.cashProof === 'string' ? body.cashProof : '';
        const cpTs    = Number(body.cashTs) || 0;
        const cpBase  = Math.floor(Number(body.cashBase) || 0);
        const cpLam   = Math.floor(Number(body.cashLamports) || 0);
        // The lobby the GAME SERVER signed, echoed back by the client untouched. Deliberately not
        // `lobbyId`: the client's own idea of its lobby falls back to a guess when the socket has
        // already torn down, and that guess would fail an otherwise valid proof. Nothing is trusted
        // by taking it from here — a wrong value simply makes the HMAC not match.
        const cpLobby = String(body.cashLobby || '');
        let   proofOk = false;
        /* Separate from proofOk, and the whole point of the 2026-08-17 fix.
         *
         * proofAuthentic = the HMAC VERIFIED, so the game server genuinely signed this cash-out with
         * GAME_SECRET. Nobody without the secret can produce that.
         * proofOk        = ...and the signed figures are still usable as the AUTHORITATIVE amount.
         *
         * They came apart on the base check below: the proof binds `cpBase` to the `pw:` deposit the
         * game server read at mint time, and `pw:` legitimately MOVES while a player eats (the node's
         * own log shows base 13186523 -> 13202192 for one player). A player whose wager changed between
         * the proof being minted and the cash-out landing therefore failed the bind — and with
         * CASHOUT_REQUIRE_PROOF armed that was a flat REFUSAL, not a fallback, so an honest player was
         * told "could not be verified with the game server" and could not get paid.
         *
         * A moved base is a STALE BINDING, not a forgery: the signature still proves the game server
         * vouched for this player. So it falls back to the capped path (which is bounded by the 20x cap
         * AND floored at the real kvWager deposit) instead of refusing. Only a cash-out with NO
         * authentic signature at all is still refused outright, which is what the guard exists for. */
        let   proofAuthentic = false;

        if (cpProof && cpProof.length === 64 && cpTs && cpLam > 0 && GAME_SECRET) {
          const cpAge = Date.now() - cpTs;
          // 120s, not the 300s used elsewhere: a proof is minted the instant the 4s cash-out circle
          // completes and is spent seconds later. A tight window is what stops a proof from a
          // previous, richer round being replayed against a fresh cheap deposit.
          if (cpAge >= 0 && cpAge < 120000) {
            const canon = 'cashout:' + playerAddress + ':' + cpLobby + ':' + cpBase + ':' + cpLam + ':' + cpTs;
            const want  = crypto.createHmac('sha256', GAME_SECRET).update(canon).digest('hex');
            try { proofOk = crypto.timingSafeEqual(Buffer.from(want), Buffer.from(cpProof)); } catch (_) {}
            // The signature verified: this really came from the game server. Recorded before the bind
            // check below can clear proofOk, because the two answer different questions.
            proofAuthentic = proofOk;
            // Bind the proof to THIS deposit. The base the game server read out of `pw:` at join
            // must still be the `pw:` we just consumed, so a proof cannot be carried across rounds.
            if (proofOk && cpBase !== kvWager) {
              console.warn('[settle] cashout proof base mismatch signed=' + cpBase + ' kv=' + kvWager + ' — signature is genuine, falling back to the capped path');
              proofOk = false;
            }
            // Spent proofs stay spent. Checked (not set) here so the client's own retry loop can
            // re-present the same proof after a failed payout — `cpd:` is only written once SOL has
            // actually left escrow, below.
            if (proofOk && await kvGet('cpd:' + cpProof)) {
              console.warn('[settle] cashout proof REPLAY refused player=' + playerAddress.slice(0, 8));
              clearTimeout(guard); done = true;
              await kvSet('pw:' + playerAddress, String(kvWager), 600).catch(() => {});
              return res.status(403).json({ error: 'That cash-out was already paid' });
            }
          } else {
            console.warn('[settle] cashout proof stale age=' + cpAge + 'ms — falling back');
          }
        }

        let wagerLamports;
        if (proofOk) {
          // Never pay less than the deposit we hold, even if the ledger says so — same principle as
          // the underfunded refusal below: a suspect figure must not quietly shortchange a player.
          if (cpLam < kvWager) {
            console.warn('[settle] cashout proof BELOW deposit signed=' + cpLam + ' kv=' + kvWager + ' — paying deposit');
            betAlert('CASHOUT proof below deposit — signed ' + cpLam + ' kv ' + kvWager +
                     ' player=' + playerAddress.slice(0, 8) + ' game=' + game);
            wagerLamports = kvWager;
          } else {
            wagerLamports = cpLam;   // authoritative, uncapped
          }
        } else {
          /* ⚠️ REFUSE ONLY WHEN NOTHING VOUCHED FOR THIS CASH-OUT.
           *
           * `proofAuthentic` means the HMAC verified — the game server signed it and only the holder of
           * GAME_SECRET could have. A proof that is authentic but whose base moved is a stale binding on
           * an honest player (see the note where proofAuthentic is declared), and refusing it is how
           * players ended up unable to cash out at all while the guard was armed. Those fall through to
           * the capped path below, which is floored at the real `pw:` deposit and capped at 20x it, so a
           * forged AMOUNT still cannot overpay.
           *
           * What is still refused outright is what the guard was built for: a cash-out arriving with no
           * signature, a malformed one, or one that fails the HMAC. */
          if (proofAuthentic) {
            /* Prefer the figure the GAME SERVER SIGNED over the client's unsigned claim. The signature is
             * genuine, so `cpLam` is the honest total it computed (deposit + food); only its binding to a
             * since-changed deposit is stale. Still bounded, because a genuine proof could in principle be
             * a replayed one from a richer round: floored at the real `pw:` so nobody is shortchanged, and
             * capped at the same 20x the unsigned path uses so nobody is overpaid.
             *
             * `cpd:` already blocks replaying a proof that was actually PAID, so the cap is the backstop
             * for the case that guard cannot see, not the primary defence. */
            wagerLamports = Math.max(kvWager, Math.min(cpLam, kvWager * 20));
            console.warn('[settle] cashout base moved — paying signed ' + cpLam + ' bounded to ' + wagerLamports + ' (kv=' + kvWager + ')');
            betAlert('CASHOUT proof base moved — signature GENUINE, paid the signed amount bounded to the ' +
                     'deposit. player=' + playerAddress.slice(0, 8) + ' game=' + game + ' signedBase=' + cpBase +
                     ' signedTotal=' + cpLam + ' kv=' + kvWager + ' paid=' + wagerLamports +
                     '. Not a forgery: the deposit changed between the proof being minted and the cash-out.');
          } else if (REQUIRE_CASH_PROOF) {
            await kvSet('pw:' + playerAddress, String(kvWager), 600).catch(() => {});
            betAlert('CASHOUT REFUSED — no valid game-server proof. player=' + playerAddress.slice(0, 8) +
                     ' game=' + game + ' claimed=' + wagerLamportsRaw + '. If this player is on a CACHED ' +
                     'page they must RELOAD; if it happens to everyone, unset CASHOUT_REQUIRE_PROOF.');
            clearTimeout(guard); done = true;
            /* Tell them to RELOAD, not to retry. By far the likeliest reason a cash-out reaches here is a
             * page cached from before the proof client shipped: it never listens for `ss-cash-proof`, so
             * it has nothing to send and pressing Cash Out again produces the identical refusal forever.
             * The wager is restored above, so reloading costs them nothing and actually fixes it. */
            return res.status(503).json({
              error: 'Cash-out could not be verified with the game server. Your wager is SAFE and still on record — please RELOAD the page (Ctrl+Shift+R), rejoin, and cash out again.',
              reload: true, retry: true });
          }
          // Unsigned claim, capped. Reached when the guard is OFF and no usable proof arrived — and NOT
          // when the proof was authentic, which is handled above off the signed figure instead.
          if (wagerLamports == null) {
            wagerLamports = wagerLamportsRaw > kvWager
              ? Math.min(wagerLamportsRaw, kvWager * 20)
              : kvWager;
          }
        }
        console.log('[settle] cashout kv=' + kvWager + ' claimed=' + wagerLamportsRaw +
                    ' proof=' + (proofOk ? cpLam : 'none') + ' using=' + wagerLamports +
                    (proofOk ? ' [authoritative]' : ' [CLIENT-CLAIMED, capped]'));

        let sig, playerCut, creatorCut, txConfirmed = false;
        try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) await sleep(1200);
          const { bal, blockhash } = await fetchBalAndHash(esc.pubkeyB58);
          console.log('[settle] cashout attempt=' + attempt + ' bal=' + bal + ' blockhash=' + blockhash.slice(0,8) + '… player=' + playerAddress.slice(0,8) + '…');
          const avail = bal - TX_FEE;
          if (avail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow balance too low to cashout — try again shortly' }); }
          // REFUSE rather than silently pay less than owed — escrow being thinner than a player's own
          // tracked stake means something upstream is wrong (concurrent draw, manual withdrawal, a stuck
          // payout eating the float); clamping here would send them home shortchanged with zero signal
          // to anyone. Throwing routes into the catch below, which restores pw: and tells them to retry.
          if (wagerLamports > 0 && avail < wagerLamports) {
            betAlert('CASHOUT UNDERFUNDED — owed ' + wagerLamports + ' but escrow only has ' + avail +
                     ' spendable. player=' + playerAddress.slice(0, 8) + ' game=' + game);
            throw new Error('escrow underfunded: owed ' + wagerLamports + ' avail ' + avail);
          }
          let payout = wagerLamports > 0 ? wagerLamports : avail;
          const remaining = avail - payout;
          if (remaining > 0 && remaining < RENT_MIN) { payout = avail; }
          const rake = Math.floor(payout * CREATOR_FEE_PCT);
          playerCut  = payout - rake;                    // player keeps their full 90% — never reduced
          // The rake absorbs THIS tx's ~5000-lamport network fee. Escrow's net outflow is then exactly
          // `payout` (playerCut + creatorCut + networkFee = payout), so it stays funded purely by player
          // deposits and never drifts below what players are owed — no operator top-ups. (Previously the
          // full 10% was swept out AND escrow paid the 5000 on top, leaking ~5000 lamports per cashout.)
          creatorCut = Math.max(0, rake - TX_FEE);
          console.log('[settle] cashout payout=' + payout + ' (wager=' + wagerLamports + ' avail=' + avail + ' remaining=' + remaining + ') player=' + playerCut + ' creator=' + creatorCut);
          const transfers = creatorCut > 0
            ? [{ to: playerPubkey, lamports: playerCut }, { to: b58Decode(CREATOR_WALLET), lamports: creatorCut }]
            : [{ to: playerPubkey, lamports: payout }];
          try {
            const tx = buildTx(esc, blockhash, transfers);
            const result = await sendAndConfirm(tx);
            sig = result.sig; txConfirmed = result.confirmed;
            // Awaited (not fire-and-forget) — Vercel can freeze the function the instant the
            // response is sent, so an un-awaited background write may never finish.
            try{ await kvDel('krl:'+playerAddress); }catch(_){}
            // SOL has left escrow — burn the proof so it can never be presented again. Written only
            // now, never before: the client retries a failed payout with the SAME proof, and burning
            // it up-front would turn a transient RPC failure into a permanently unclaimable wager.
            if (proofOk) { try{ await kvSet('cpd:' + cpProof, '1', 86400); }catch(_){} }
            try{
              const pk='ph:'+game+':'+playerAddress;
              // Leaderboard "earned" is the gross cashout total (wager + winnings) the player
              // actually saw on their in-game $ display when they hit cashout — NOT playerCut,
              // which is that amount minus the 10% platform fee. Using playerCut made cashing
              // out for (say) $2 in a $1 lobby show as $1.80 earned, which looked wrong since
              // the fee is a platform cut, not something the player should see subtracted from
              // their own earnings figure. The actual wallet transfer below is UNCHANGED — this
              // only affects the stat/leaderboard number, never the real payout split.
              const newEarned=await kvHincrby(pk,'earned',payout);
              await kvHincrby(pk,'wins',1);
              await kvZadd('lb:'+game+':earned',Number(newEarned)||0,playerAddress);
              await kvHincrby('ph:'+game+':global','totalEarned',payout);
              const _wagTot=await kvHget(pk,'wagered');
              await pushEarningsPoint(game,playerAddress,newEarned,{wagered:Number(_wagTot)||0,type:'cashout',amount:payout});
            }catch(_){}
            // Announce the win to Discord — awaited (Vercel can freeze the function the moment the
            // response is sent) but fully guarded, so it never affects the payout or the response.
            try{
              const _wname = await kvHget('ph:'+playerAddress,'name');
              await postWinToDiscord(payout, _wname, sig);
              // Public "Live Cashouts" feed — the platform home reads cashouts:recent (name + lamports + game).
              await kvLpush('cashouts:recent', JSON.stringify({ name:_wname||'player', lamports:payout, game, ts:Date.now() }));
              await kvLtrim('cashouts:recent', 0, 49);
              await kvExpire('cashouts:recent', 172800);
            }catch(_){}
            break;
          } catch (e) {
            const isOnChainFail = e.message.includes('TX rejected') || e.message.includes('insufficient') || e.message.includes('0x1') || e.message.includes('-32002') || e.message.includes('Send failed');
            if (attempt < 2 && isOnChainFail) {
              console.warn('[settle] cashout attempt ' + attempt + ' fail (' + e.message.slice(0, 80) + ') — retrying with fresh balance');
              continue;
            }
            throw e;
          }
        }
        } catch (payErr) {
          /* ⚠️ RESTORING THE WAGER IS ONLY SAFE WHEN THE THROW PROVES NOTHING WAS PAID.
           *
           * This used to restore `pw:` unconditionally, on the stated grounds that sendAndConfirm "only
           * throws on a failed broadcast or a tx rejected on-chain, and in BOTH cases no SOL left
           * escrow". The rejected-on-chain half is true. The failed-broadcast half is NOT: a transport
           * error on the submit call cannot be told apart from a lost response to a transaction that is
           * already in the mempool and will land. Restoring the wager there hands the player back a
           * live `pw:` record for money that has already reached their wallet — they press Cash Out
           * again and are paid the same wager TWICE, out of the escrow that backs everyone else's
           * stakes. This is the largest-value instance of the bug that paid a recruiter week twice.
           *
           * Proven-unpaid → restore, unchanged, because stranding a player whose payout genuinely
           * failed is the reason the restore exists.
           * Ambiguous → do NOT restore. Record it under `cashheld:` and alert, so it is a known item
           * with the amount attached rather than either a double payment or a silent loss. */
          if (throwProvesUnpaid(payErr)) {
            await kvSet('pw:' + playerAddress, String(kvWager), 600).catch(() => {});
            console.error('[settle] cashout REJECTED on-chain, wager restored, wallet=' + playerAddress + ' — ' + (payErr && payErr.message || payErr));
            clearTimeout(guard); done = true;
            return res.status(503).json({ error: 'Payout could not be confirmed — your wager is safe, press Cash Out again.', retry: true });
          }
          await kvSetPerm('cashheld:' + playerAddress, JSON.stringify({
            wagerLamports: kvWager, playerCut: playerCut || null, ts: Date.now(),
            reason: String((payErr && payErr.message) || payErr || ''),
          })).catch(() => {});
          console.error('[settle] cashout UNRESOLVED, wager NOT restored, wallet=' + playerAddress + ' — ' + (payErr && payErr.message || payErr));
          betAlert('CASHOUT UNRESOLVED ' + String(playerAddress).slice(0, 8) + ' wager=' + kvWager +
                   ' cut=' + (playerCut || '?') + ' : ' + String((payErr && payErr.message) || payErr) +
                   ' — the transfer MAY have landed, so the wager was NOT restored (restoring it would let ' +
                   'them cash out twice). Check the wallet on-chain: if the SOL arrived, DEL cashheld:' +
                   String(playerAddress) + ' and nothing is owed. If it did not, restore pw:' +
                   String(playerAddress) + ' = ' + kvWager + ' or pay by hand.');
          clearTimeout(guard); done = true;
          return res.status(409).json({ held: true, retry: false,
            error: 'Your cash-out is being checked — the transfer may already have gone through. ' +
                   'Nothing is lost; we are confirming on-chain before anything else happens.' });
        }
        clearTimeout(guard); done = true;
        return res.status(200).json({ sig, playerCut, creatorCut, confirmed: txConfirmed });
      } finally {
        await kvDel(coLockKey);
      }
    }

    // ── kill ──────────────────────────────────────────────────────────────────
    if (action === 'kill') {
      if (!playerAddress || !body.wagerLamports) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress + wagerLamports required' }); }
      const killPubkey = b58Decode(playerAddress);
      if (killPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be 32 bytes' }); }

      // Fail CLOSED: if GAME_SECRET is missing the kill proof cannot be verified —
      // deny the claim entirely rather than skipping the gate and allowing console drains.
      if (!GAME_SECRET) {
        clearTimeout(guard); done = true;
        return res.status(503).json({ error: 'Kill rewards not available — server configuration error' });
      }

      const kpBody = typeof body.killProof === 'string' ? body.killProof : '';
      const ktBody = Number(body.killTs) || 0;
      const vaBody = typeof body.victimAddress === 'string' ? body.victimAddress : '';

      // Validate proof format and freshness before touching KV
      const proofAge = Date.now() - ktBody;
      if (!kpBody || kpBody.length !== 64 || !ktBody || !vaBody || proofAge > 300000 || proofAge < 0) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Kill proof required — must originate from an active game' });
      }

      // Verify HMAC first (cheap CPU check before any KV writes)
      const expectedProof = crypto.createHmac('sha256', GAME_SECRET).update(`${playerAddress}:${vaBody}:${ktBody}`).digest('hex');
      let proofOk = false;
      try { proofOk = crypto.timingSafeEqual(Buffer.from(expectedProof), Buffer.from(kpBody)); } catch (_) {}
      if (!proofOk) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Invalid kill proof' });
      }

      // Atomically claim this proof via NX — only the first request wins even under concurrent load.
      // Eliminates the read-then-write race in the old pattern.
      // No per-wallet rate limit: each kill event has a unique proof (killerId:victimId:timestamp),
      // so back-to-back kills each get their own proof and are all paid immediately.
      const proofClaimed = await kvSetNX('kpu:' + kpBody, '1', 300);
      if (!proofClaimed) {
        clearTimeout(guard); done = true;
        return res.status(403).json({ error: 'Kill proof already redeemed' });
      }

      // Immediately block victim cashout: set dead flag + atomically remove their wager.
      // This runs BEFORE the TX so even if the cashout request is in-flight right now,
      // it will hit the dead check or find no wager record and be refused.
      // kvGetDel returns the victim's REAL recorded stake at the exact moment of death — this is the
      // authoritative reward basis. Two players joining a persistent lobby minutes or hours apart can
      // deposit different LAMPORT amounts for the "same" USD entry as SOL's price moves between them,
      // so the killer's OWN pw: (used here previously) is the wrong number whenever it differs from
      // what THIS SPECIFIC victim actually staked. The client-reported wagerLamports is untrusted (a
      // modified client could claim any figure), so it is logged for comparison only, never paid.
      let victimStakeLamports = 0;
      if (vaBody && vaBody !== playerAddress && vaBody.length > 20) {
        const [, delVal] = await Promise.all([
          kvSet('dead:' + vaBody, '1', 600),
          kvGetDel('pw:' + vaBody),
        ]).catch(() => [null, null]);
        victimStakeLamports = Number(delVal) || 0;
      }
      if (victimStakeLamports !== Number(body.wagerLamports)) {
        console.warn('[settle] kill amount mismatch — victim pw:=' + victimStakeLamports +
                      ' client claimed=' + body.wagerLamports + ' killer=' + playerAddress.slice(0, 8));
      }

      // Retry once on on-chain fail — concurrent kills can race on the shared escrow balance
      let sig, killerCut, creatorCut, txConfirmed2 = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) await sleep(1200);
        const { bal: killBal, blockhash: killHash } = await fetchBalAndHash(esc.pubkeyB58);
        console.log('[settle] kill attempt=' + attempt + ' bal=' + killBal + ' blockhash=' + killHash.slice(0,8) + '… killer=' + playerAddress.slice(0,8) + '… wager=' + body.wagerLamports);
        const killAvail = killBal - TX_FEE;
        if (killAvail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
        // Must have an active deposit to claim kill rewards at all (prevents a wallet with no stake in
        // the game from draining escrow), but the AMOUNT paid is the victim's own stake, not the
        // killer's — see victimStakeLamports above.
        const kvKillWager = Number(await kvGet('pw:' + playerAddress)) || 0;
        if (kvKillWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'No active wager on record — must join with a deposit before claiming kill rewards' });
        }
        if (victimStakeLamports <= 0) {
          clearTimeout(guard); done = true;
          return res.status(403).json({ error: 'Victim had no recorded wager — nothing to claim' });
        }
        // REFUSE rather than silently pay less than owed (same reasoning as cashout above). Release the
        // kill-proof claim so a retry with the same proof (still within its 5-minute freshness window)
        // can collect the FULL reward once escrow recovers, instead of burning the proof on a shortfall.
        if (victimStakeLamports > killAvail) {
          await kvDel('kpu:' + kpBody).catch(() => {});
          betAlert('KILL REWARD UNDERFUNDED — owed ' + victimStakeLamports + ' but escrow only has ' + killAvail +
                   ' spendable. killer=' + playerAddress.slice(0, 8));
          clearTimeout(guard); done = true;
          return res.status(503).json({ error: 'Escrow temporarily low — kill reward held, try again', retry: true });
        }
        let total = victimStakeLamports;
        const killRemaining = killAvail - total;
        if (killRemaining > 0 && killRemaining < RENT_MIN) { total = killAvail; }
        const killRake = Math.floor(total * CREATOR_FEE_PCT);
        killerCut  = total - killRake;                  // killer keeps their full share — never reduced
        creatorCut = Math.max(0, killRake - TX_FEE);    // rake absorbs the network fee → escrow stays self-funding (see cashout note)
        console.log('[settle] kill total=' + total + ' killer=' + killerCut + ' creator=' + creatorCut);
        const transfers = creatorCut > 0
          ? [{ to: killPubkey, lamports: killerCut }, { to: b58Decode(CREATOR_WALLET), lamports: creatorCut }]
          : [{ to: killPubkey, lamports: total }];
        try {
          const tx = buildTx(esc, killHash, transfers);
          const result2 = await sendAndConfirm(tx);
          sig = result2.sig; txConfirmed2 = result2.confirmed;
          // Awaited (not fire-and-forget) — see cashout block above for why.
          try{
            const pk='ph:'+game+':'+playerAddress;
            await kvHincrby(pk,'kills',1);
            // Gross reward (pre-fee), same reasoning as the cashout path above.
            const newEarned=await kvHincrby(pk,'earned',total||0);
            await kvZadd('lb:'+game+':earned',Number(newEarned)||0,playerAddress);
            const _wagTotK=await kvHget(pk,'wagered');
            await pushEarningsPoint(game,playerAddress,newEarned,{wagered:Number(_wagTotK)||0,type:'kill',amount:total||0});
            // (Victim's death is now recorded by the victim's own 'stat-loss' call — the single
            // source of truth — so we deliberately DON'T bump it here anymore, to avoid counting
            // the same death twice.)
          }catch(_){}
          break;
        } catch (e) {
          const isOnChainFail = e.message.includes('TX rejected') || e.message.includes('insufficient') || e.message.includes('0x1') || e.message.includes('-32002') || e.message.includes('Send failed');
          if (attempt < 2 && isOnChainFail) {
            console.warn('[settle] kill attempt ' + attempt + ' fail (' + e.message.slice(0, 80) + ') — retrying');
            continue;
          }
          throw e;
        }
      }
      clearTimeout(guard); done = true;
      return res.status(200).json({ sig, amount: killerCut, creatorCut, confirmed: txConfirmed2 });
    }

    // ── lose ──────────────────────────────────────────────────────────────────
    if (action === 'lose') {
      // NX lock: prevents two concurrent lose requests from both sending txs
      const loLockKey = 'lock:lo:' + playerAddress;
      const loLock = await kvSetNX(loLockKey, '1', 20);
      if (!loLock) {
        clearTimeout(guard); done = true;
        return res.status(429).json({ error: 'Payout already in progress — wait a moment' });
      }

      try {
        const kvLoseWager = Number(await kvGet('pw:' + playerAddress)) || 0;
        if (kvLoseWager <= 0) {
          clearTimeout(guard); done = true;
          return res.status(200).json({ sig: null, amount: 0, confirmed: true });
        }
        const { bal: loseBal, blockhash: loseHash } = await fetchBalAndHash(esc.pubkeyB58);
        const loseAvail = loseBal - TX_FEE;
        if (loseAvail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
        const loseAmt = Math.min(kvLoseWager, loseAvail);
        const remaining = loseAvail - loseAmt;
        const finalAmt  = (remaining > 0 && remaining < RENT_MIN) ? loseAvail : loseAmt;
        // House takes the forfeited stake MINUS this tx's network fee, so escrow nets exactly the
        // cleared liability instead of leaking ~5000 lamports (self-funding — see cashout note).
        const houseTake = Math.max(0, finalAmt - TX_FEE);
        const tx = buildTx(esc, loseHash, [{ to: b58Decode(CREATOR_WALLET), lamports: houseTake }]);
        const { sig: loseSig, confirmed: loseConfirmed } = await sendAndConfirm(tx);
        await kvDel('pw:' + playerAddress);
        // Awaited (not fire-and-forget) — see cashout block above for why.
        try{ await kvDel('krl:'+playerAddress); await kvDel('kc:'+playerAddress); }catch(_){}
        try{
          await kvHincrby('ph:'+game+':'+playerAddress,'losses',1);
          await kvHincrby('ph:'+game+':'+playerAddress,'deaths',1);
        }catch(_){}
        clearTimeout(guard); done = true;
        return res.status(200).json({ sig: loseSig, amount: finalAmt, confirmed: loseConfirmed });
      } finally {
        await kvDel(loLockKey);
      }
    }

    clearTimeout(guard); done = true;
    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[settle] CRASH:', e && (e.stack || e.message) || String(e));
    if (!done) { done = true; clearTimeout(guard); try { res.status(500).json({ error: e && e.message || String(e) }); } catch (_) {} }
  }
};

// Exported for unit testing the Discord win-post payload in isolation (scripts/test-winpost.js).
module.exports.postWinToDiscord = postWinToDiscord;
// Exported so the slip's field names and label rendering can be checked offline. The real call site
// swallows every error, which would otherwise hide a typo'd field forever.
module.exports.postBetSlipToDiscord = postBetSlipToDiscord;
/* Exported for scripts/test-double-pay.js — the SHIPPED functions, not copies of their rules.
 *
 * settleBounty owns the decision that pays a winner twice if it is wrong (release the pay-lock, or
 * hold it), and wgPayOne owns the classification that decision reads. A test that reimplemented either
 * would have gone green through the whole recruiter double-payment. `_payInternals` is a test seam and
 * nothing else calls it. */
module.exports._payInternals = { settleBounty, wgPayOne, wgPayWinnerAndFee, sendAndConfirm, releasePayLock, throwProvesUnpaid };
