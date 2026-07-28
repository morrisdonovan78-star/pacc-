'use strict';
// lib/p2pbet.js — PURE peer-to-peer betting-exchange engine for SNAKE POT.
//
// ZERO I/O. Deterministic transforms only. All KV, on-chain transfers, websocket pushes and auth
// live in the callers (api/settle.js for money, server.js for authoritative outcomes). Keeping the
// rules pure is what lets the offline harness prove them before a lamport moves.
//
// MODEL — the house NEVER takes a side and NEVER risks funds:
//   * Every wager is 1-v-1 and EVEN MONEY. Creator stakes S on one side; an opponent stakes the
//     SAME S on the other side. Pot = 2S, held in escrow.
//   * On settlement the winner receives 2S minus the 8% platform fee → 1.84 × S for S=1.
//   * If nobody accepts before betting closes, the creator gets 100% of S back. NO fee, ever.
//   * The platform only escrows, matches, settles and takes 8% of COMPLETED (matched) wagers.
//
// Every bet type is a BINARY proposition with exactly two opposing sides, so the two stakes are
// always symmetric and the pot is always exactly 2S. New types just register here.

const FEE_BPS   = 800;    // 8.00% platform fee, taken ONLY on matched+settled wagers
const BPS_DENOM = 10000;

// ── payout math ───────────────────────────────────────────────────────────────
// Given one side's stake, returns the full settlement breakdown. fee + winnerPayout === pot exactly
// (fee is ceil'd so the platform can never distribute more than it holds).
function settlementMath(stakeLamports) {
  const stake = Math.max(0, Math.floor(Number(stakeLamports) || 0));
  const pot   = stake * 2;                                   // both sides staked the same
  const fee   = Math.min(pot, Math.ceil((pot * FEE_BPS) / BPS_DENOM));
  return { stake, pot, fee, winnerPayout: pot - fee };
}
// What a bettor sees BEFORE placing: "risk S to win X".
function potentialWin(stakeLamports) { return settlementMath(stakeLamports).winnerPayout; }

// An unmatched wager is returned in full — no fee under any circumstance.
function returnAmount(stakeLamports) { return Math.max(0, Math.floor(Number(stakeLamports) || 0)); }

// ── bet-type registry (expandable) ────────────────────────────────────────────
// Each type is binary. `sides` are the two opposing outcome keys; `label(side)` renders them.
// `resolve(ctx)` is documented here but EXECUTED by the game server (authoritative), which posts the
// winning side to settle. Kept in one place so the server, API and UI agree on semantics.
const BET_TYPES = {
  // "Does this snake complete a cash-out (bank its money) rather than die?"
  cashout: {
    id: 'cashout',
    needsSubject2: false,
    sides: ['YES', 'NO'],
    label: s => (s === 'YES' ? 'Cashes out' : 'Dies'),
    question: w => `Does ${w.subjectName || 'this snake'} cash out?`,
    // Server truth: snake._cashResolved === 'paid' → YES; snake died/forfeited → NO.
  },
  // "Is this snake still in the arena (alive OR already cashed out) after N ms?"
  survive: {
    id: 'survive',
    needsSubject2: false,
    sides: ['YES', 'NO'],
    label: s => (s === 'YES' ? 'Survives' : 'Dies'),
    question: w => `Does ${w.subjectName || 'this snake'} survive ${Math.round((w.durationMs || 0) / 1000)}s?`,
    // Server truth at deadline: alive || cashed-out → YES; died before deadline → NO.
  },
  // "Does snake A outlast snake B?" (whoever leaves the arena LAST wins)
  outlast: {
    id: 'outlast',
    needsSubject2: true,
    sides: ['A', 'B'],
    label: (s, w) => (s === 'A' ? (w && w.subjectName || 'Snake A') : (w && w.subject2Name || 'Snake B')),
    question: w => `Does ${w.subjectName || 'A'} outlast ${w.subject2Name || 'B'}?`,
    // Server truth: the snake that leaves the arena later (died or cashed out) wins.
  },
  /*
   * KART: "Does racer A finish ahead of racer B?" — a private duel inside a bigger field.
   *
   * This is the bet people actually want on a race. Backing an outright winner in an eight-car field
   * is mostly a lottery, and it dies the moment one driver is clearly quicker; picking two drivers and
   * asking which of them comes out ahead stays live all race and is a judgement about DRIVERS rather
   * than about the field. It is also the only shape that works while a race is running, because the
   * pair can both still be on track when the bet is matched.
   *
   * Settled on FINISH ORDER, which the kart server computes itself from validated sector crossings —
   * not from anything a client reports. A racer who does not finish loses to one who does; if neither
   * finishes, the one who completed more of the race is ahead; if that ties too, it is void and both
   * stakes come back rather than being decided by a coin toss.
   */
  beat: {
    id: 'beat',
    needsSubject2: true,
    sides: ['A', 'B'],
    label: (s, w) => (s === 'A' ? (w && w.subjectName || 'Racer A') : (w && w.subject2Name || 'Racer B')),
    question: w => `Does ${w.subjectName || 'A'} finish ahead of ${w.subject2Name || 'B'}?`,
    // Server truth: the kart server posts the winning side from the finish order it validated.
  },
};
function betTypeIds() { return Object.keys(BET_TYPES); }
function getBetType(id) { return BET_TYPES[id] || null; }
function isValidSide(typeId, side) {
  const t = BET_TYPES[typeId];
  return !!(t && t.sides.indexOf(side) >= 0);
}
// The side an ACCEPTOR automatically takes = the one the creator didn't.
function opposingSide(typeId, side) {
  const t = BET_TYPES[typeId];
  if (!t || t.sides.indexOf(side) < 0) return null;
  return t.sides[0] === side ? t.sides[1] : t.sides[0];
}

// ── RIGGING MODEL — which snakes must FAIL for a given side to win ────────────
// The integrity rule is DIRECTIONAL, not "never bet on yourself":
//   * Backing your own snake to SUCCEED is fine — you cannot guarantee it (anyone can kill you),
//     and it only makes you play harder. Betting on yourself to win is not riggable.
//   * Backing your own snake to FAIL is trivially riggable — you just drive into a wall and collect.
// So the question is never "is this your snake", it is "does this side pay out when a snake YOU
// CONTROL performs badly". Returns the subjects that must fail for `side` to win; a bettor who
// controls any of them could simply throw that snake.
//
// Note it also covers the two-snake case: backing A to outlast B needs B to go out first, so if B is
// your own alt you could sacrifice B to guarantee it — that is caught here too.
function riggableSubjects(typeId, side, subject, subject2) {
  if (typeId === 'cashout' || typeId === 'survive') {
    return side === 'NO' ? [subject] : [];        // NO wins when the subject dies
  }
  if (typeId === 'outlast') {
    return side === 'A' ? [subject2] : [subject]; // whichever snake you need to go out first
  }
  return [subject, subject2].filter(Boolean);      // unknown type → be maximally strict
}
// Convenience: can `bettor` take `side`, given the snakes they're known to control?
// `controlled` is a Set/array of subject ids the bettor owns or shares a network with.
function isRiggableFor(typeId, side, subject, subject2, controlled) {
  const need = riggableSubjects(typeId, side, subject, subject2);
  const own = new Set(controlled || []);
  return need.some(s => s && own.has(s));
}

// ── wager state machine ───────────────────────────────────────────────────────
// open      — created + funded by the creator, publicly listed, waiting for an opponent
// reserved  — an acceptor has atomically claimed it and is depositing (short TTL; reverts to open)
// matched   — both sides funded and locked; no cancels, no edits
// settled   — outcome known, winner paid, fee taken
// returned  — betting closed with no opponent → creator refunded 100%, no fee
// cancelled — creator withdrew while still open (unmatched) → refunded 100%, no fee
const STATUS = { OPEN: 'open', RESERVED: 'reserved', MATCHED: 'matched', SETTLED: 'settled', RETURNED: 'returned', CANCELLED: 'cancelled' };
// NOTE: there is deliberately NO cancel path. Once placed, a wager must run to a conclusion: it is
// either matched and SETTLED on game truth, or nobody takes it and it is RETURNED in full at lock.
// Allowing a pull-back would also hand the creator a free option — post a wager, watch how the snake
// starts doing, and yank it before anyone can take the other side.
// CANCELLED is retained only so records written before this rule still render in history.
const LEGAL_TRANSITIONS = {
  open:      ['reserved', 'returned'],
  reserved:  ['matched', 'open'],          // back to open if the acceptor's deposit never lands
  matched:   ['settled'],
  settled:   [],
  returned:  [],
  cancelled: [],
};
function canTransition(from, to) {
  const allowed = LEGAL_TRANSITIONS[from];
  return !!(allowed && allowed.indexOf(to) >= 0);
}
// A wager is only shown in the public order book while it is genuinely takeable.
function isOpenForAccept(w, nowMs) {
  if (!w) return false;
  if (w.status !== STATUS.OPEN) return false;
  return nowMs < Number(w.lockTs);
}

// ── validation ────────────────────────────────────────────────────────────────
// Every rule that protects the exchange from abuse. Returns null when OK, else an error string.
// Callers MUST still enforce atomicity (NX locks) — this is the logical layer, not the race guard.
function validateCreate({ typeId, side, stakeLamports, lockTs, nowMs, subject, subject2, minStake, maxStake, creator, duel }) {
  const t = BET_TYPES[typeId];
  if (!t) return 'unknown bet type';
  if (!isValidSide(typeId, side)) return 'invalid side for this bet type';
  const stake = Math.floor(Number(stakeLamports) || 0);
  if (!(stake > 0)) return 'stake must be positive';
  if (minStake && stake < minStake) return 'stake below minimum';
  if (maxStake && stake > maxStake) return 'stake above maximum';
  if (!subject) return 'must pick someone to bet on';
  // ── DUEL — "snake A beats snake B", head to head ─────────────────────────────────────────────
  // Same shape as `outlast` (pick two snakes, pick your winner, someone takes the other side); the
  // difference is SETTLEMENT: a duel only resolves when one of the two actually KILLS the other. A
  // third-party kill, a cash-out or a disconnect leaves it undecided so they can rejoin and finish
  // it, and if they never do, api/settle.js voids it after an hour and refunds both sides in full.
  //
  // Deliberately NOT restricted to your own snake (it was, briefly). You may duel on ANY two
  // players — the protection that actually matters is the DIRECTIONAL rig rule, which is enforced
  // for every type in riggableSubjects/wgRigCheck: you can back your own snake to WIN, never to
  // LOSE. Requiring it to be your own snake on top of that blocked the legitimate case of betting
  // on two other players without closing any real attack.
  if (duel) {
    if (typeId !== 'outlast') return 'a duel is an outlast wager';
    if (!subject2) return 'pick both players for the duel';
    if (subject2 === subject) return 'the two players must be different';
    if (!(Number(lockTs) > Number(nowMs))) return 'betting is already closed for this wager';
    return null;
  }
  if (t.needsSubject2 && !subject2) return 'this bet needs a second player';
  if (t.needsSubject2 && subject2 === subject) return 'the two players must be different';
  if (!(Number(lockTs) > Number(nowMs))) return 'betting is already closed for this wager';
  return null;
}
// A duel's opponent is set at ACCEPT time and must be the acceptor's OWN snake — otherwise someone
// could nominate a third party (which would re-open exactly the collusion the duel shape removes).
function validateDuelAccept({ wager, acceptor, subject2 }) {
  if (!wager || !wager.duel) return 'not a duel';
  if (!acceptor) return 'missing acceptor';
  if (!subject2) return 'pick your own snake to duel with';
  if (subject2 !== acceptor) return 'you must duel with your OWN snake';
  if (subject2 === wager.subject) return 'you cannot duel yourself';
  return null;
}
function validateAccept({ wager, acceptor, nowMs }) {
  if (!wager) return 'wager not found';
  if (wager.status === STATUS.MATCHED) return 'already matched';
  if (wager.status === STATUS.SETTLED || wager.status === STATUS.RETURNED || wager.status === STATUS.CANCELLED) return 'wager is closed';
  if (wager.status === STATUS.RESERVED) return 'someone is already accepting this wager';
  if (wager.status !== STATUS.OPEN) return 'wager is not open';
  if (!acceptor) return 'missing acceptor';
  if (acceptor === wager.creator) return 'you cannot accept your own wager';
  if (!(nowMs < Number(wager.lockTs))) return 'betting has closed for this wager';
  return null;
}

// ── settlement resolution ─────────────────────────────────────────────────────
// Given a matched wager and the winning SIDE (decided by the authoritative game server), work out
// who gets paid and how much. Returns null if the wager isn't settleable.
function resolveWager(wager, winningSide) {
  if (!wager || wager.status !== STATUS.MATCHED) return null;
  if (!isValidSide(wager.type, winningSide)) return null;
  const m = settlementMath(wager.stakeLamports);
  const creatorWon = (wager.side === winningSide);
  return {
    winner: creatorWon ? wager.creator : wager.acceptor,
    loser:  creatorWon ? wager.acceptor : wager.creator,
    winningSide,
    payout: m.winnerPayout,   // 2 × stake − 8%
    fee: m.fee,               // the platform's only revenue, taken here and nowhere else
    pot: m.pot,
  };
}

// ── display helpers (USD-first, SOL underneath) ───────────────────────────────
// Players think in dollars; the chain moves SOL. usdToLamports is what the UI uses to turn a
// dollar stake into the exact lamport amount that gets escrowed.
function lamportsToSol(l) { return (Number(l) || 0) / 1e9; }
function solToLamports(s) { return Math.floor((Number(s) || 0) * 1e9); }
function lamportsToUsd(l, solPriceUsd) { return lamportsToSol(l) * (Number(solPriceUsd) || 0); }
function usdToLamports(usd, solPriceUsd) {
  const price = Number(solPriceUsd) || 0;
  if (price <= 0) return 0;
  return Math.floor((Number(usd) || 0) / price * 1e9);
}

module.exports = {
  FEE_BPS, BPS_DENOM, STATUS, BET_TYPES,
  settlementMath, potentialWin, returnAmount,
  betTypeIds, getBetType, isValidSide, opposingSide,
  riggableSubjects, isRiggableFor, validateDuelAccept,
  canTransition, isOpenForAccept,
  validateCreate, validateAccept,
  resolveWager,
  lamportsToSol, solToLamports, lamportsToUsd, usdToLamports,
};
