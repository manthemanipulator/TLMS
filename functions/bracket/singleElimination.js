'use strict';

/**
 * Single-elimination bracket generation and result handling.
 *
 * Every function here is pure: it takes plain data in and returns new plain
 * data out, without touching Firestore. That keeps the logic deterministic
 * (the same roster always produces the same bracket) and lets the unit tests
 * exercise every participant count without a database. The Cloud Functions
 * layer is responsible for loading a tournament, calling these functions,
 * and writing the returned bracket back in a single transaction.
 *
 * Bracket shape:
 *   {
 *     format: 'single_elimination',
 *     size,            // power of two at or above the participant count
 *     rounds,          // log2(size)
 *     lowScoreWins,    // true for stroke-play games such as golf
 *     matches: [Match],
 *     championId       // null until the final is completed
 *   }
 *
 * Match shape:
 *   {
 *     id: 'R1-M0',     // round number and zero-based index within the round
 *     round, index,
 *     player1Id, player2Id,   // null while waiting for an earlier match
 *     score1, score2,         // null until a result is recorded
 *     winnerId,               // null until decided
 *     status,                 // 'scheduled' | 'pending' | 'bye' | 'completed'
 *     nextMatchId, nextSlot   // where the winner goes (null for the final)
 *   }
 */

/**
 * Returns the seed order for a bracket of the given size so that seed 1 and
 * seed 2 can only meet in the final, seeds 1-4 only in the semifinals, and so
 * on. For size 8 the result is [1, 8, 4, 5, 2, 7, 3, 6]; consecutive pairs are
 * the first-round matches.
 */
function seedPositions(size) {
  let positions = [1];
  while (positions.length < size) {
    const nextLength = positions.length * 2;
    const expanded = [];
    for (const seed of positions) {
      // Each seed is paired with the seed that "mirrors" it in the larger bracket.
      expanded.push(seed, nextLength + 1 - seed);
    }
    positions = expanded;
  }
  return positions;
}

/** Smallest power of two that is greater than or equal to n. */
function bracketSizeFor(n) {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/**
 * Validates a roster of player IDs. The array order is the seed order, which
 * the caller derives from handicap or, by default, registration timestamp.
 */
function validateRoster(playerIds) {
  if (!Array.isArray(playerIds)) {
    throw new TypeError('playerIds must be an array');
  }
  if (playerIds.length < 2) {
    throw new RangeError('A tournament needs at least two players');
  }
  const seen = new Set();
  for (const id of playerIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('Every player ID must be a non-empty string');
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate player ID in roster: ${id}`);
    }
    seen.add(id);
  }
}

/**
 * Builds a single-elimination bracket from a seeded roster.
 *
 * Byes go to the highest seeds and are confined to round one: when the field
 * is not a power of two, the seed slots above the participant count are empty,
 * and the standard seed placement guarantees every empty slot is paired with
 * a top seed. Those players are advanced into round two immediately.
 */
function generateSingleElimination(playerIds, options = {}) {
  validateRoster(playerIds);
  const lowScoreWins = options.lowScoreWins !== false;
  const size = bracketSizeFor(playerIds.length);
  const rounds = Math.log2(size);
  const matches = [];

  // Create every match up front so each one can point to the match its winner
  // feeds into. Round r has size / 2^r matches.
  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let index = 0; index < count; index++) {
      const isFinal = round === rounds;
      matches.push({
        id: matchId(round, index),
        round,
        index,
        player1Id: null,
        player2Id: null,
        score1: null,
        score2: null,
        winnerId: null,
        status: 'pending',
        nextMatchId: isFinal ? null : matchId(round + 1, Math.floor(index / 2)),
        nextSlot: isFinal ? null : (index % 2 === 0 ? 1 : 2),
      });
    }
  }

  const bracket = {
    format: 'single_elimination',
    size,
    rounds,
    lowScoreWins,
    matches,
    championId: null,
  };

  // Fill round one from the seed placement. Seeds above the roster length are
  // empty slots, which become byes.
  const positions = seedPositions(size);
  for (let index = 0; index < size / 2; index++) {
    const match = findMatch(bracket, matchId(1, index));
    const seedA = positions[index * 2];
    const seedB = positions[index * 2 + 1];
    match.player1Id = playerIds[seedA - 1] ?? null;
    match.player2Id = playerIds[seedB - 1] ?? null;

    if (match.player1Id && match.player2Id) {
      match.status = 'scheduled';
    } else {
      // Exactly one side is empty (two empty slots cannot share a match when
      // size is the smallest power of two at or above the field size).
      match.status = 'bye';
      match.winnerId = match.player1Id ?? match.player2Id;
      placeWinner(bracket, match);
    }
  }

  return bracket;
}

/**
 * Records a result and advances the winner. Returns a new bracket; the input
 * is not modified.
 *
 * An administrator can also call this on a match that is already completed to
 * correct a score, as long as the match the winner moved into has not been
 * played yet. That rule keeps later rounds consistent: a correction can only
 * change who appears in a match that has no result of its own.
 */
function recordResult(bracket, id, score1, score2) {
  const next = structuredClone(bracket);
  const match = findMatch(next, id);

  if (match.status === 'bye') {
    throw new Error(`Match ${id} is a bye and has no result to record`);
  }
  if (!match.player1Id || !match.player2Id) {
    throw new Error(`Match ${id} is still waiting for its players`);
  }
  if (!Number.isFinite(score1) || !Number.isFinite(score2)) {
    throw new TypeError('Scores must be finite numbers');
  }
  if (score1 === score2) {
    // Elimination play needs a winner; a tied round is settled by a playoff
    // and the playoff result is what gets recorded.
    throw new Error('Elimination matches cannot end in a tie');
  }

  const downstream = match.nextMatchId ? findMatch(next, match.nextMatchId) : null;
  if (match.status === 'completed' && downstream && downstream.status === 'completed') {
    throw new Error(
      `Cannot change ${id}: the match its winner advanced to (${downstream.id}) already has a result`
    );
  }

  const player1Won = next.lowScoreWins ? score1 < score2 : score1 > score2;
  match.score1 = score1;
  match.score2 = score2;
  match.winnerId = player1Won ? match.player1Id : match.player2Id;
  match.status = 'completed';

  if (downstream) {
    placeWinner(next, match);
  } else {
    next.championId = match.winnerId;
  }
  return next;
}

/**
 * Administrative bracket edit: swaps two players between first-round matches
 * that have not been played. Byes are excluded because a bye recipient has
 * already been advanced into round two.
 */
function swapPlayers(bracket, playerA, playerB) {
  if (playerA === playerB) {
    throw new Error('Choose two different players to swap');
  }
  const next = structuredClone(bracket);
  const slotA = findRoundOneSlot(next, playerA);
  const slotB = findRoundOneSlot(next, playerB);

  for (const slot of [slotA, slotB]) {
    if (slot.match.status !== 'scheduled') {
      throw new Error(
        `Match ${slot.match.id} is ${slot.match.status}; only unplayed first-round matches can be edited`
      );
    }
  }
  if (slotA.match.id === slotB.match.id) {
    throw new Error('Those players are already paired against each other');
  }

  slotA.match[slotA.key] = playerB;
  slotB.match[slotB.key] = playerA;
  return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchId(round, index) {
  return `R${round}-M${index}`;
}

function findMatch(bracket, id) {
  const match = bracket.matches.find((m) => m.id === id);
  if (!match) throw new Error(`No match with ID ${id}`);
  return match;
}

/** Locates the round-one match and field ('player1Id'/'player2Id') holding a player. */
function findRoundOneSlot(bracket, playerId) {
  for (const match of bracket.matches) {
    if (match.round !== 1) continue;
    if (match.player1Id === playerId) return { match, key: 'player1Id' };
    if (match.player2Id === playerId) return { match, key: 'player2Id' };
  }
  throw new Error(`Player ${playerId} is not in the first round`);
}

/**
 * Writes a match's winner into the slot of the match it feeds, and marks that
 * match scheduled once both of its players are known.
 */
function placeWinner(bracket, match) {
  if (!match.nextMatchId) {
    bracket.championId = match.winnerId;
    return;
  }
  const target = findMatch(bracket, match.nextMatchId);
  target[match.nextSlot === 1 ? 'player1Id' : 'player2Id'] = match.winnerId;
  target.status = target.player1Id && target.player2Id ? 'scheduled' : 'pending';
}

module.exports = {
  generateSingleElimination,
  recordResult,
  swapPlayers,
  seedPositions,
  bracketSizeFor,
  validateRoster,
};
