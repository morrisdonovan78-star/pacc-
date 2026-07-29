# SNAKE POT / PAC ARENA — continue this work (written 2026-07-29, end of session)

Paste this whole file as your first message. It is written to be self-contained.

---

## Who you are

You are taking over a **live, real-money** Solana gaming platform (snakepot.com — snake + PAC-MAN +
blackjack + kart, plus a P2P betting exchange). Players deposit real SOL and play for it.

- **Never claim something works because you deployed it.** Verify at the URL players actually use.
- **A "0% error rate" on the Vercel dashboard proves NOTHING about whether money moved.** This codebase
  has twice returned `200 {ok:true}` while silently not paying anyone. Do not reassure the owner from
  that dashboard — check the escrow's on-chain history and the pm2 logs.
- Do **not** move funds, handle private keys, or log into the owner's dashboards. Tell them to do it.
- The owner types fast, in fragments, and corrects mid-task. **Read their corrections carefully — they
  are usually right about their own game.** Twice this session I called something a bug that wasn't,
  and they caught both.
- **Restate money/combat specs in numbers and confirm before changing them.**

**Working dir:** `C:\Users\morri\Downloads\PAC ARENA`

| Surface | Where | Deploy |
|---|---|---|
| Hub (snakepot.com) | `pulp-platform/` (its own git repo) | `cd pulp-platform && XDG_DATA_HOME=C:/Users/morri/.vercel-cli NEXT_TELEMETRY_DISABLED=1 npx vercel --prod --yes` |
| APIs + standalone games | repo root: `api/`, `slither-snakes.html`, `index.html`, `admin.html` | `git push pacc master:main` (**never** `origin` — stale lineage) |
| Game servers | 2 Vultr boxes: pm2 `pac-arena` :3001, `kart-arena` :3002 | patch over SSH, **both nodes always** |

⚠️ **Never `git add pulp-platform`** from the root repo — it stages a gitlink. It is a separate repo.
⚠️ After editing a game HTML: `cd pulp-platform && node scripts/sync-game.mjs`. **snakepot.com serves
its OWN copy** from `pulp-platform/public/game/*.html`. Verify fixes at `snakepot.com/game/snake.html`.
SSH creds + patch flow: `~/.claude/projects/C--Users-morri-Downloads-PAC-ARENA/memory/reference_vultr_server.md`.

**Start by reading** `~/.claude/projects/.../memory/MEMORY.md` — ~85 one-line pointers to root causes
already paid for. Especially `project_payout_refuse_not_underpay.md` and
`project_usd_peg_and_profit_chart.md`, which cover this session.

---

## ✅ SHIPPED AND DEPLOYED TODAY (do not redo — verify only)

1. **Silent underpayment KILLED (the session's real find).** `cashout` and `kill` in `api/settle.js` did
   `payout = Math.min(owed, avail)` — when escrow was thinner than what the player was owed, they were
   **quietly paid less, with no error and no alert.** Now both REFUSE: cashout throws → existing catch
   restores `pw:` → 503 "your wager is safe, press Cash Out again"; kill releases the `kpu:` proof claim
   so a retry collects the full reward. Both fire `betAlert()`.
2. **Bets never auto-retry after a failure.** Owner's explicit rule: *they refund by hand and will not
   double-pay.* A failed `wager-settle` / `wager-return` / sweep-return / void-refund now sets a
   permanent `wgheld:<id>` flag and **nothing ever touches that wager again.** Guarded at all 4 payout
   sites + both sweep entry points (`wgIsHeld` / `wgSetHeld`).
3. **Pac-Man kill rewards paid from the wrong stake.** Used the *killer's* `pw:` as both cap and amount
   (i.e. repaid the killer their own deposit). Wrong whenever two players joined a persistent lobby at
   different times and SOL's price moved between them. Now uses the victim's real recorded stake, which
   `kvGetDel('pw:'+victim)` already captured at death and threw away. **Snake was never affected** — it
   has no per-kill payout path at all (kills drop food; money only moves at cashout).
4. **Owner DM alerts, live and tested.** `betAlert()` now DMs the owner directly. Reuses the
   discord-music **JUKEBOX** bot token as Vercel env `DM_BOT_TOKEN`; `OWNER_DISCORD_ID` =
   `516310068518453267`. Verified with a real test DM.
5. **Net-profit chart rebuilt** (`pulp-platform/app/components/PlayerCard.jsx`). It plotted cumulative
   GROSS payouts, so it could only ever slope UP — a player down $7.52 saw a happy green climb. Entries
   are now recorded too (`api/join.js` pushes a point with cumulative wagered), so the line is real net
   (`earned − wagered`): dips on entry, climbs on cashout, and a death is a dip that never recovers.
   Plus break-even line, red/green by actual sign, area anchored to zero, and a **hover dot on every
   event** showing timestamp, that event's amount, and running net after it.
6. **Duplicate POT readout removed** from snake's top-center HUD (the top-right leaderboard already
   shows TOTAL POT and the owner prefers it). The JS that wrote to `#hud-pot` is null-guarded so a
   stale cached page can't throw and kill the whole HUD-restore path.

---

## 🔴 NOT DONE — everything the owner asked for today that is still open

### 0. ⚠️⚠️ "NO CASHOUT CAP" **AND** "NO ESCROW-DRAIN EXPLOIT" ARE THE SAME LINE OF CODE

The owner asked for both in consecutive messages: *"make sure there is no cap on cashout compared to
wager"* and *"make sure ppl cant exploit to steal from escrow wallet from any game like friend did when
i first built pac-arena to show me it was possible … no free join exploit or free steal from escrow
wallet exploit but everything should work right."*

**These currently conflict, and I did NOT remove the cap — removing it as written re-opens exactly the
exploit they asked me to prevent.** Here is the whole picture (`api/settle.js`, cashout path ~2654):

```js
// Use client-signed accumulated amount (initial wager + kill-food winnings).
const wagerLamports = wagerLamportsRaw > kvWager
  ? Math.min(wagerLamportsRaw, kvWager * 20)   // ← the "cap" the owner wants gone
  : kvWager;
```

⚠️ **The cashout amount is CLIENT-CLAIMED.** `wagerLamportsRaw` is signed by the player's own wallet —
but the player controls what they sign, so the signature proves *identity*, not *honesty*. A modified
client can claim any figure. **`kvWager * 20` is the only thing bounding how much a cheater can claim.**
Delete it and a player can claim the entire escrow balance. That IS the friend's demo.

**Why the owner is still right that a cap is wrong:** carried money is real (you eat other players'
dropped food), so a legitimate 30× run gets truncated. The cap is a bad proxy for a missing feature.

**THE ACTUAL FIX — make the amount SERVER-AUTHORITATIVE, then no cap is needed at all:**
The game server already tracks each snake's live carried value (`sn.usd` / `p.sol`, broadcast every
tick) and already owns kill-food spawning (`ssSpawnKillFood`, `f.w`). So:
1. On cash-out, the **game server** HMACs the authoritative carried total with `GAME_SECRET`
   (`cashout:<addr>:<lamports>:<ts>`), exactly like it already signs kill proofs.
2. `settle.js` verifies that proof and pays the **server's** figure, ignoring the client's claim.
3. Then delete the `* 20` cap entirely — it is unnecessary once the number can't be forged.
This is the "REMAINING — real money/escrow logic (the hard part)" item in
`memory/project_money_and_ui_overhaul.md`, still deferred. **It needs a patch to both Vultr nodes.**
Do NOT remove the cap before this lands.

**Good news — today's refuse-don't-underpay change already hardened the drain path.** It used to do
`payout = Math.min(claim, avail)`, so an inflated claim was silently paid *whatever escrow had* — i.e.
it emptied the wallet. It now **refuses** when the claim exceeds available, so an inflated claim gets
nothing and the owner is DM'd. Theft is bounded to 20× the cheater's own real stake, and only when
escrow can cover it.

**Also verify (not audited this session):** the free-join → paid-cashout path. Free lobbies must never
produce a `pw:` entry that a cashout can draw against. `join.js` writes `pw:` only after verifying a
real on-chain deposit, and cashout refuses with "No wager on record" when `pw:` is absent — but this
was **not** end-to-end tested today. Test: join a FREE lobby, then attempt a cashout, and confirm 403.

### 1. LIVE-SOL-PRICE PEGGING (owner's biggest and most-repeated ask)

Their words, across several messages: *"make sure people get payed the same amount of sol exactly based
off live sol price and based off what they paid to get in — it should check before and after games"* ·
*"ppl join at same price but can cash out at more cuz u can carry others money and cashout"* · *"ppl
should drop what they joined with"* · *"SINCE SOL AMOUNT IS TRACKED FROM EACH PLAYERS ENTRY THE AMOUNT
OVER HEAD CAN GO UP AND DOWN WITH SOL PRICE BECAUSE THIS IS HOW IT SHOULD WORK."*

Today everything is **raw lamports end to end** — `pw:<addr>` is a lamport figure, never re-priced — so
the $ over a player's head is frozen at their entry's exchange rate.

⚠️ **This is a NEW FEATURE WITH REAL MONEY RISK, not a bug fix.** I told the owner (they did not
dispute) that SOL price caused none of today's failures. If SOL falls mid-game and you peg payouts to
the original USD, you must pay out **more SOL than was deposited**, and escrow is self-funding by
design with no house float to absorb that. **Get an explicit decision on who eats the delta before
writing any payout math.**
**Recommended split to offer them:** peg the **displayed** USD to live price (pure display, zero money
risk — and it literally satisfies "the amount over head can go up and down with SOL price") while
payouts stay lamport-exact. Ship that first; treat pegged payouts as a separate, explicit decision.
Price source already exists: `api/price.js`. Display sites: `_myUsd` / `s.usd` / `ST.lobbyUsd` in
`slither-snakes.html`.

### 2. DISCORD BET SLIPS (asked for, never started)

*"add a discord thing to show all bet slips paid like it shows in app and like a real slip like
draftkings and look good and say congrats to winners and show their slips."*
Post a rich embed when a P2P wager settles. The natural hook is the settle path in `api/settle.js`
(`wager-settle`, right after a successful `wgPayWinnerAndFee`) reusing the `betAlert`/`ownerDm` REST
pattern already there — but to a **public channel**, not a DM. `postWinToDiscord` is an existing
precedent for formatting. Include: both sides, the bet type, stake, payout, and a congrats line.

### 3. PAC-MAN DISCONNECT LEAVES MONEY STRANDED IN ESCROW

⚠️ **The owner's rule is NO REFUNDS FOR DISCONNECTS IN ANY GAME** (snake/pac/kart/blackjack): *"if the
wager is in it's locked until cashout — that's not my fault, ppl will disconnect."* Snake already obeys
this correctly (forfeits to food exactly like a death). **Pac-Man resolves nothing:** the player is
deleted from the room (`_server_na.js` ~5463) and `pw:` merely expires after 4h, so the stake sits in
escrow uncredited to anyone. **This is a genuine contributor to the "why is there extra money in
escrow" confusion.** Correct fix is **FORFEIT to the house** (mirror `action:'lose'`), never a refund.
Needs a live patch to both game servers. Owner deprioritized pac ("worry pac another time") — confirm
before doing it.

### 4. `discord-guard` BOT TOKEN IS DEAD

Its own log has `TokenInvalid` since **2026-07-28**, so the guard bot has not been moderating Discord
for over a day. `/opt/discord-guard/discord_token.txt` on EU is a stale token. Needs the owner to mint
a fresh one in the Discord developer portal. (The **music/JUKEBOX** token is fine — that's the one now
used for owner DMs.)

### 5. STILL OPEN FROM EARLIER SESSIONS (unchanged)

- **Blackjack ante double-charge** — highest-priority money bug from the previous handoff. Diagnose from
  the actual failing `/api/blackjack` request, not theory.
- **Stranded blackjack antes** (`bjdep:<tableId>:<handNum>:<address>`) needing `bj-refund`.
- **Clips**: make them ON by default; turn OFF automatic cash-out clips.
- **Referral = shareable LINK, not a code.** ⚠️ Codes were re-minted (LUCKMAN is `GAFQAY`) — old invite
  links are dead and need resharing.
- **PAC ARENA card art** still cropped (`public/games/pacman.webp` is 1640×959 in a 224×224 tile — needs
  a cropped 1:1 image, not a code change; widening the tiles broke the homepage once already).
- **Pac-Man needs a FREE lobby** that goes live like a paid one.
- **Vercel is over on Fluid Active CPU** (10.6% throttle observed). Throttling can make the payout
  confirmation step time out — a real secondary cause of non-payment. Pro plan or wait for reset.

---

## ⚠️ THE ESCROW QUESTION — read before answering it again

The owner spent much of today confused about **why escrow had "extra" money** ($5 → $17 overnight),
given nobody reported a missing payout. The honest answer assembled from the evidence:

- Escrow **legitimately holds** live players' locked stakes; a nonzero balance is not by itself a bug.
- `POST /api/settle {"action":"solvency"}` is read-only and unauthenticated. It reports `escrow`,
  `playerDeposits`, `betLiability` and whether a payout would clear. **Free money = escrow −
  playerDeposits − betLiability.** Only that is safe to withdraw.
- ⚠️ **The one cause no code can prevent: a manual sweep from the escrow wallet that ignores what is
  still locked to live players.** Nothing on Vercel or the game servers can see or block a transfer the
  owner signs from their own wallet. This is procedural, not fixable in code — say so plainly.
- `[wg] settle REFUSED … insolvent` log lines are the **P2P bets exchange**, NOT game cashouts. Do not
  present them as proof a player's cashout was shortchanged. Also: **success is never logged** on the
  wager paths, so a REFUSED line does not prove the wager stayed unpaid.
- Kart payouts ARE confirmed landing on-chain (real sigs, 2026-07-29 18:56–18:59 UTC), so the old
  `kvSetNX` money bug is proven fixed in the wild.
- The owner's wallet `4B9MgNPUgDiKKQRhsC3pmdWoAehs4yjHb8VfL2Nahzpv` is **their own** (hardcoded at
  `_server_na.js:15` as the owner-auth key). The 8-line unauthenticated `/admin` probe sequence in both
  nodes' logs is **our own verification test**, not an intruder. It was checked — there is no evidence
  of a hacker.

---

## Owner action items (remind, don't do)

1. **Before withdrawing from escrow, run the `solvency` check** and take only the free surplus.
2. **Mint a fresh discord-guard bot token** — the guard bot is offline.
3. **Reshare referral links** — old codes are dead (`GAFQAY` for LUCKMAN).
4. **Vercel Pro** or wait for the CPU reset.
5. Still untested with real money: one paid kart race, one $1 paid join, one bet on `/bets`.
