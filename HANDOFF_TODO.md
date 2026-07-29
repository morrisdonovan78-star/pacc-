# SNAKE POT / PAC ARENA — handoff (rewritten end of 2026-07-28)

Paste this whole file as your first message. Written to be self-contained.

---

## Who you are

You are taking over a **live, real-money** Solana gaming platform. Players deposit SOL and play for
it. Standing rules:

- **Never claim something works because you deployed it.** Verify at the URL players actually use.
- **A failed join is refunded by the owner by hand**, so a leftover paid entry is never a free game.
- Do **not** move funds, handle private keys, or log into the owner's dashboards. Tell them to do it.
- The owner will describe feel in words that shift between messages. **Restate the spec in numbers
  and confirm before changing money- or combat-critical values.**

**Working dir:** `C:\Users\morri\Downloads\PAC ARENA`

| Surface | Where | Deploy |
|---|---|---|
| Hub (snakepot.com) | `pulp-platform/` (own git repo) | `XDG_DATA_HOME=C:/Users/morri/.vercel-cli NEXT_TELEMETRY_DISABLED=1 npx vercel --prod --yes` |
| APIs + standalone games | repo root, `api/`, `slither-snakes.html`, `index.html`, `_karttest/index.html` | `git push pacc master:main` (**never** `origin` — stale lineage) |
| Game servers | 2 Vultr boxes, pm2 `pac-arena` :3001, `kart-arena` :3002 | patch over SSH, both nodes always |

SSH creds: `~/.claude/projects/C--Users-morri-Downloads-PAC-ARENA/memory/reference_vultr_server.md`.
Helper `srv.py` (paramiko read_bytes/write_bytes/run) — recreate in scratchpad, pattern is in memory.

---

## ⚠️ FIVE TRAPS THAT COST HOURS TODAY

1. **snakepot.com serves its OWN copy of every game** from `pulp-platform/public/game/*.html`, NOT
   from pac-arena. A full day of correct join fixes reached **zero players** because `sync:game` was
   a manual step. Now wired into `build` (and `sync-game.mjs` warns instead of failing when the parent
   repo isn't checked out — Vercel builds pulp-platform alone). **Verify game fixes at
   `https://snakepot.com/game/snake.html`**, never at `pac-arena.vercel.app`.
2. **Vercel env vars marked "Sensitive" are WRITE-ONLY.** `ADMIN_SECRET`, `GAME_SECRET`,
   `PRIVY_APP_SECRET`, `ESCROW_SECRET`, `SETTLE_SECRET` cannot be revealed, copied or pulled — only
   rotated. Don't design anything that requires the owner to read one. Put owner tools behind the mod
   panel's existing login instead.
3. **Prod `server.js` is CRLF + double-spaced, mixed within the file.** `repr()` the real bytes of
   every patch site first. Flow: read → dry-run assert each anchor appears exactly once → `cp` a
   `.bak` → `write_bytes` → `node --check` (auto-restore on fail) → `pm2 restart` → `curl /health`.
   `_server_na.js` in the repo is a point-in-time mirror; pull prod before patching, re-sync after.
4. **`next build` dies on Windows** with `EXDEV` writing Next's telemetry config → always
   `NEXT_TELEMETRY_DISABLED=1`.
5. **Bash heredocs for commit messages**: apostrophes in prose break `git commit -m "$(cat <<'EOF')"`.
   Use `git commit -F -` with a heredoc.

---

## ✅ SHIPPED TODAY (verified live — don't redo)

**Money / joins**
- `/api/join` **preflight** — client asks if the endpoint can answer BEFORE signing the deposit, so an
  outage costs the player nothing. Says "NOT CHARGED" out loud.
- **Deposit-reuse rule**: a resume needs same-txSig (`pwtx:`) + unconsumed `pw:` + <180s. Legacy `'1'`
  tx records can never resume. Another wallet's deposit refused. **8/8 unit tests** —
  scratchpad `test-join-resume.js`, keep it green.
- Client confirm loop 18→8 polls; `getBlockHeight` expiry probe deleted (it threw "Transaction
  expired" at players whose deposit HAD landed).
- PLAY AGAIN no longer boots on one stale balance read after cash-out.
- **Name squatting blocked** — `nameReg:<NAME>` was an unconditional overwrite, so anyone could take a
  name and redirect payments meant for that player. Cost the owner $3.80. First claim now permanent.

**Kart (all on `kart-arena`, both nodes)**
- **FREE-RACE EXPLOIT CLOSED** — `tryStart` placed *every* racer on the grid, not just the paid field.
  You could sit in a paid lobby, never READY, never pay, and race for the pot. Non-field racers are
  now removed from `lb.racers` at race start.
- Queue promotion no longer looks like a paid seat; LEAVE no longer triggers a race start.
- Ready **countdown** now in `k-state` (it was only ever sent to the home-page lobby list).
- READY is a **lock** in paid lobbies; LEAVE refunds in full pre-start and returns home.

**Combat**
- `grazeScaleK` added — size scaling for the graze margin, live slider, clamp widened to `[-2, 1.5]`.
- Scaling anchor `SS_GRAZE_REF_REACH` **16 → 48.34** (two ns=30 snakes). 16 was ns=0, a size no player
  is ever at, so every real size measured as a departure from an unreachable point.
- **FINAL LOCKED VALUES**: `grazePx 1.16, grazeHead 1.20, bodyScale 0.75, grazeReach 1.00,
  grazeScaleK 1.15, circDeg 360, faceDeg 21`.
- **TUNING IS LOCKED** — `SS_TUNE_LOCKED = true` in server.js refuses every `ss-tune` write before the
  signature check; `_TUNING_LOCKED = true` in the client hides the panel. Locked to the owner too, by
  request. To unlock: server constant false + restart (client flag alone unlocks nothing).

**Platform**
- **Spectator chat + voice** in snake and Pac-Man (server + client, verified end-to-end with real
  sockets). A watcher's name is UNVERIFIED, so every message carries `spec:true` + a `__spec__` id and
  renders dimmed — otherwise they can impersonate a paying player. **Never broadcast a join line**
  (reconnect storms would spam chat).
- Pac-Man `sendChat` double-echo fixed (server `io.to` includes the sender).
- Clipboard fixed everywhere — `writeText` is async and can be permission-denied; `execCommand`
  fallback. Worst case was `copyBackupKey` claiming a **private key** was saved when it wasn't.
- CDN caching on read endpoints + visibility-gated polling (`lib/pollInterval.js`) — the Hobby plan's
  Fluid Active CPU was exceeded and `/api/join` was measurably CPU-throttled.
- One-wallet-per-account guard, **plus the fix for my own regression** where permanent guards left new
  players with NO wallet and a dead Retry. **All guards must self-expire.**
- **Site-wide bans** — `ban:` only blocked paid joins before. `/api/banned` + `BanGate` in the root
  layout, checking every wallet on the account, failing OPEN on KV error.
- Mod panel: **OLD WALLETS** lookup (scans Privy embedded wallets AND stored old-game keypairs, labels
  which), **Credit a referral by hand** card. `api/admin.js` maxDuration 15→60.
- Referral: diagnostic logging on every bind failure path; resume-path now accrues (it returned before
  `accrueReferral`, silently losing referrals whose first paid join was a retry).
- Recruiter-of-the-Week podium on the hub home.
- Kart mirror buffer 288×80 → **288×120** (3.6:1 letterbox had almost no depth in it).

---

## ❌ NOT DONE

### 1. Bet-creation UI — the big one
Nobody can open a bet. `/bets` correctly says bets are created inside a live arena; that in-arena flow
**does not exist** for snake or kart. Markets, `verifySnakeSig`, the `beat` market, settlement and the
take-side UI all exist. Read `memory/project_p2p_betting_exchange.md` and
`project_kart_betting_and_paid.md` first. Even money, **8% on winnings only**, unmatched refunded in
full, and the self-bet check must be used.

### 2. Custom login screen (now unblocked)
Owner enabled Google in Privy (leave OAuth Client ID/secret blank — Privy's shared creds work). They
want a styled "Continue with Google" screen like playpulp.io. Privy's built-in modal can't be laid out
that way — use headless `useLoginWithOAuth`.

### 3. Privy device-recovery prompt
`couldn't create your wallet: '0x853f…' not loaded on this device` — the account has an embedded wallet
Privy can't initialise in that browser. Should trigger Privy's recovery flow, not show a raw failure.

### 4. Kart: remove the race-picker
Owner, verbatim: *"this page should not be a thing"*. Home screen → straight into a lobby; join and
ready in-game; spectate between matches. LEAVE already goes home; the entry path still routes through
the picker. Files: `_karttest/index.html`, `app/games/kart/page.jsx`, `app/play/kart/page.jsx`.

### 5. Kart spectator chat/voice
Done for snake + Pac-Man on `/opt/pac-arena/server.js`. Kart runs a **separate** server
(`/opt/kart-arena/kart-server.js`). Mirror it — and keep the `spec:true` + namespaced-id rule.

### 6. Verify Pac-Man + blackjack paid joins
The client-side preflight-before-charging was applied to **snake only**. `api/join.js` protects them
server-side, but check whether `index.html` and the blackjack ante can still charge before confirming
the endpoint is alive, and port it.

### 7. Mirror control hints
`,` `.` angle · `;` position · `'` size · `k` toggle — all work, none is shown on screen.

### 8. Circling-player kill case — UNRESOLVED
Owner reported a circler surviving what looked like a clear wrap. **I misread the screenshot once
(mistook their tail for their head) and built a wrong explanation on it — don't repeat that.** Ask for
a shot with **both heads** visible and trace the real geometry before theorising.

---

## Owner action items (remind, don't do)
1. **One real $1 paid join** — the join fixes have never been exercised with real money.
2. **One paid join from LUCKMAN's referred friend** → the logs name the failing step. Or credit him now
   via the mod panel card. His code is `NGVW34`, wallet `WfpZbpUtcqLs3nTsfT71RGDHEmvgNuGuz5ibyEyz3no`.
3. **Mark `KV_REST_API_TOKEN` Sensitive** in Vercel — it's full read/write to all game data.
4. **Decide on Vercel Pro** (~$20/mo) or wait for the monthly reset.
5. **The $7.34 on `CVW1EsXZ…PRAk` is NOT on any server** — full scan: 65 accounts, 18 embedded wallets,
   0 old-game wallets, no match. It's a local keypair in the original browser's `localStorage`
   (`ss_kp_*` / `pa_kp_*`). If that profile is gone, so is the money. Don't build more lookups.

---

## Facts worth not re-deriving
- `INIT_SECTIONS = 30`; players boost down to ~8 and cap around **65**. **The real range is ns 8–65** —
  any table running to ns 200 is fiction.
- `ssSectionRadius(ns) = 8 + (ns*5)^0.6 * 0.8`.
- **Sink-in depth and difficulty are the SAME quantity**: `sink = (Ra + Rd) − killDist`. You cannot
  reduce visible overlap without making the graze harder. Say so plainly rather than hunting for a
  setting that separates them.
- "Max body overlap" is only literal visible depth when `bodyScale = 1.00`, `grazeHead = 1.00` and
  `grazeScaleK = 0`. Otherwise part of the hitbox sits inside the sprite and the margin is size-scaled.
- Escrow `2SYFfCsSmKr8qwK1AfWd36JtAc1BCaRaSSxyECKUJjBb` is a **live hot wallet** — payouts leave it
  every few seconds, so manual Phantom sends from it race those and fail before broadcast.

**Start by reading** `~/.claude/projects/C--Users-morri-Downloads-PAC-ARENA/memory/MEMORY.md` — ~80
one-line pointers to hard-won root causes. Then pick #1 unless the owner says otherwise.
