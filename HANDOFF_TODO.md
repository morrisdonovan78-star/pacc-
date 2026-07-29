# SNAKE POT / PAC ARENA — handoff (2026-07-29, end of a long session)

Paste this whole file as your first message. Written to be self-contained.

---

## Who you are

You are taking over a **live, real-money** Solana gaming platform. Players deposit SOL and play for it.

- **Never claim something works because you deployed it.** Verify at the URL players actually use.
- **A failed join is refunded by the owner by hand**, so a leftover paid entry is never a free game.
- Do **not** move funds, handle private keys, or log into the owner's dashboards. Tell them to do it.
- The owner describes feel in words that shift between messages. **Restate the spec in numbers and
  confirm** before changing money- or combat-critical values.
- **Verify layout changes against a local production build before deploying.** I shipped a homepage
  grid change unchecked and broke the page for the owner.

**Working dir:** `C:\Users\morri\Downloads\PAC ARENA`

| Surface | Where | Deploy |
|---|---|---|
| Hub (snakepot.com) | `pulp-platform/` (own git repo) | `XDG_DATA_HOME=C:/Users/morri/.vercel-cli NEXT_TELEMETRY_DISABLED=1 npx vercel --prod --yes` |
| APIs + standalone games | repo root: `api/`, `slither-snakes.html`, `index.html`, `admin.html`, `_karttest/index.html` | `git push pacc master:main` (**never** `origin` — stale lineage) |
| Game servers | 2 Vultr boxes: pm2 `pac-arena` :3001, `kart-arena` :3002 | patch over SSH, **both nodes always** |

SSH creds: `~/.claude/projects/C--Users-morri-Downloads-PAC-ARENA/memory/reference_vultr_server.md`.
Rebuild `srv.py` in scratchpad (paramiko `read_bytes` / `write_bytes` / `run`); pattern is in memory.

---

## ⚠️ TRAPS THAT COST REAL HOURS

1. **snakepot.com serves its OWN copy of every game** from `pulp-platform/public/game/*.html`, not
   from pac-arena. A full day of correct join fixes reached zero players because `sync:game` was
   manual. Now wired into `build`. **Verify game fixes at `https://snakepot.com/game/snake.html`.**
2. **Vercel "Sensitive" env vars are WRITE-ONLY** — `ADMIN_SECRET`, `GAME_SECRET`,
   `PRIVY_APP_SECRET`, `ESCROW_SECRET`, `SETTLE_SECRET` cannot be read, only rotated. Never design
   anything requiring the owner to read one; put owner tools behind the mod panel's own login.
3. **Prod `server.js` is CRLF + double-spaced, mixed within the file.** `repr()` the real bytes of
   every patch site. Flow: read → dry-run assert each anchor appears exactly once → `cp` a `.bak` →
   `write_bytes` → `node --check` (auto-restore on fail) → `pm2 restart` → `curl /health`.
   `_server_na.js` is a point-in-time mirror; pull prod before patching, re-sync after.
4. **`next build` dies on Windows** with `EXDEV` → always `NEXT_TELEMETRY_DISABLED=1`.
5. **Commit messages**: apostrophes break `-m "$(cat <<'EOF')"`. Use `git commit -F -` + heredoc.
6. **curl gets a Vercel Security Checkpoint 403** on snakepot.com after repeated calls. Real browsers
   pass. Verify via the Browser tool's `javascript_tool` fetch instead of curl.
7. **Compare IMAGES, not file sizes.** `pacman.png` is byte-identical to `arena-bg.png`, but
   `arena-bg.png` and `arena-bg.webp` are *different pictures sharing a base name*. I told the owner
   the card art was correct three times based on a size check. Open the file.

---

## 🔴 TASK 1 — ADMIN PANEL REWORK (owner's current priority, IN PROGRESS, nothing written yet)

`admin.html` → LIVE tab. Owner's words: *"it should always show every player in all games live and
say what game and dollar increment lobby they are in… I don't see anyone from new websites… it just
shows the wrong dollar increment lobbies and only a few games… maybe a page for each… and BOTH
servers."*

**Why it is wrong now:** `api/admin.js action:'status'` → `callAllServers('status','GET')` only hits
the pac-arena server. Kart is a **separate process** (`kart-arena` :3002) and blackjack is **KV-based**
(`api/blackjack`), so neither appears at all.

**Data sources confirmed available (all already exist, no server work needed):**
- `GET {node}/counts` — snake + Pac-Man. Returns per-lobby counts **and `_players`** (names). Includes
  live custom-stake rooms (e.g. `ss-paid-lobby-0.25`) alongside a fixed base set. Stake is parsed
  from the lobby id: `ss-paid-lobby-<usd>` = snake, `paid-lobby-<usd>` = Pac-Man, `*free*` = free.
  ⚠️ This is almost certainly the "wrong dollar increments" bug — the fixed base ids are shown even
  when empty, and custom stakes only appear while live.
- `GET {node}/kart/lobbies` (also `/lobbies` on :3002) — kart lobby list. **Shape not yet inspected —
  check it first.**
- `GET {node}/wager-roster` — signed live subjects, both games (added this session).
- Blackjack: no HTTP list yet; tables live in KV via `api/blackjack`. May need a small `list` action.

Nodes: `https://us.pac-arena.com` (NA) and `https://eu.pac-arena.com` (EU). **Both, always.**

**Suggested shape:** one `api/admin.js` action (e.g. `live-all`) that fans out to all four endpoints ×
two regions, normalises to `{ game, region, lobby, stakeUsd, players:[{name, address}] }`, and returns
a flat list. Then rework the LIVE tab to group by game — owner suggested a page/tab per game, which
also fixes the "only a few games" complaint. Fail soft per source: one dead node must mean fewer rows,
not a blank panel.

---

## 🔴 TASK 2 — MID-RACE DISCONNECTS (instrumented, needs one reproduction)

Players drop mid-race in kart. The server has **no `disconnect()` calls of its own** and its error log
is clean, so it is the transport. Both nodes now log socket.io's `reason` for paid/mid-race drops:
`[kart] DISCONNECT reason=… lobby=… state=… midRace=… transport=… upSec=…`

Ask the owner to race and drop, then read `/root/.pm2/logs/kart-arena-out.log`. The reason decides the
fix and they are unrelated: `ping timeout` (client stopped answering — throttled tab, GC pause, or the
physics loop blocking the event loop), `transport close` (network), `transport error` (bad frame, e.g.
over `maxHttpBufferSize`, currently 1e5). **Do not guess before you have this line.**

---

## 🟡 TASK 3 — PAC ARENA card art is still cropped

`public/games/pacman.webp` is now the correct art (byte-identical to `pac-arena.com`'s background) but
it is **1640×959** in a **224×224** tile, so `cover` crops the champion sprites off the sides.
⚠️ I tried widening every tile to 384×224 and **broke the homepage** — the other cards are 1.0–1.5
ratio (kart and snakepot are square). Reverted. The real fix is a **cropped 1:1 version of the
artwork** saved over `pacman.webp` — an image edit, not a code change.

---

## ✅ SHIPPED AND VERIFIED (do not redo)

**The big one:** `lib/kv.js` `kvSetNX` sent `EX undefined` when called without a ttl. Redis rejects
that, `_cmd` swallows it, and the null return read as "already done" — silently suppressing **every
kart payout, kart refund, Bounty Hour prize, Recruiter prize, referral code write and qualified-recruit
flag** since launch. One line. `ensureRefCode` also now heals codes written during the broken period,
which is why **referral links were re-minted — LUCKMAN is `GAFQAY`, not `NGVW34`.**

**Money safety:** join preflight before charging (snake, Pac-Man, blackjack) · deposit-reuse rule
(same-txSig + unconsumed + <180s, 8/8 tests in scratchpad `test-join-resume.js`) · kart pay requires a
**click** (`k-need-pay` arms the READY button; auto-pay + auto-ready was charging the owner 4× in 9
minutes) · single-use kart tickets · kart free-race exploit closed (only the paid field goes on the
grid) · a race always resolves even if everyone leaves · name-squatting blocked (`nameReg` first-claim).

**Combat:** graze size-fairness (`grazeScaleK`), anchor `SS_GRAZE_REF_REACH` 16 → **48.34** (16 was
ns=0, a size no player is ever at). **LOCKED**: `grazePx 1.16, grazeHead 1.20, bodyScale 0.75,
grazeReach 1.00, grazeScaleK 1.15`. `SS_TUNE_LOCKED = true` refuses every `ss-tune` write server-side.
⚠️ **sink-in depth and difficulty are the SAME number** (`sink = Ra + Rd − killDist`); real play range
is **ns 8–65**.

**Platform:** custom `/login` page (Google first — Privy's modal ignores `loginMethods` order) ·
**Unlock wallet** button triggering Privy `setWalletRecovery` for device-locked wallets · bet creation
on `/bets` (both games, via new `/wager-roster` endpoints + `/api/live-subjects`) · spectator chat +
voice (snake, Pac-Man) · site-wide bans · mod-panel OLD WALLETS lookup + manual referral credit ·
clipboard fixed everywhere · CDN caching + visibility-gated polling · kart mirror 288×80 → 288×120.

**Also fixed:** the EU node had `WG_REGION` undefined and signed every wager roster as region `NA`.

---

## Owner action items (remind, don't do)
1. **One paid kart race** — confirm a payout actually lands. The kvSetNX fix is unproven in the wild.
2. **One $1 paid join** and **one bet on `/bets`** — both untested with real money.
3. **Reshare referral links** — `GAFQAY` for LUCKMAN; the old codes are dead.
4. **$0.40 owed** — four kart races that charged and never paid.
5. **Vercel Pro or wait for reset** — over on Fluid Active CPU.
6. **The $7 on `CVW1EsXZ…PRAk` is NOT on any server** (65 accounts, 18 embedded wallets, 0 old-game
   wallets, no match). Only in the original browser's `localStorage` (`ss_kp_*` / `pa_kp_*`). Don't
   build more lookups.

**Start by reading** `~/.claude/projects/C--Users-morri-Downloads-PAC-ARENA/memory/MEMORY.md` — ~80
one-line pointers to root causes already paid for. Then pick TASK 1.
