'use strict';

/**
 * Paper Golf scoring adapter.
 *
 * Paper Golf (github.com/manthemanipulator/Paper-Golf) is an existing game
 * that records 18-hole stroke-play rounds. This adapter lets a TLMS match be
 * decided by each player playing one Paper Golf round: the lower total wins.
 * Paper Golf itself is not modified; the adapter accepts rounds in the same
 * shape the game produces and translates them into a TLMS match result.
 *
 * Paper Golf round shape (from the game's submitScore function):
 *   { score: <integer stroke total>, holeScores: [18 integers], initials, mode }
 *
 * The validation rules mirror the game's own server-side checks, so a round
 * the game would reject is also rejected here.
 */

const HOLES = 18;
// Paper Golf's anti-cheat floor: below 3 strokes per hole is not plausible.
const MIN_SCORE = 54;
const MAX_STROKES_PER_HOLE = 30;

/**
 * Validates a Paper Golf round and returns a normalized copy, or throws an
 * Error describing the first problem found.
 */
function validateRound(round) {
  if (!round || typeof round !== 'object') throw new Error('Round data is required');
  const { score, holeScores } = round;
  if (!Number.isInteger(score) || score < MIN_SCORE) {
    throw new Error(`Score must be a whole number of at least ${MIN_SCORE}`);
  }
  if (!Array.isArray(holeScores) || holeScores.length !== HOLES) {
    throw new Error(`holeScores must list all ${HOLES} holes`);
  }
  if (!holeScores.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_STROKES_PER_HOLE)) {
    throw new Error(`Each hole score must be a whole number from 1 to ${MAX_STROKES_PER_HOLE}`);
  }
  const sum = holeScores.reduce((a, b) => a + b, 0);
  if (sum !== score) {
    throw new Error(`Reported total (${score}) does not match the hole-by-hole sum (${sum})`);
  }
  return {
    score,
    holeScores: [...holeScores],
    initials: typeof round.initials === 'string' ? round.initials.slice(0, 3).toUpperCase() : null,
    mode: typeof round.mode === 'string' ? round.mode : null,
  };
}

/**
 * Given a match and the rounds submitted so far (keyed by player ID),
 * returns the scores to record once both players have played, or null if
 * the match is still waiting for a round.
 */
function resultFromRounds(match, roundsByPlayer) {
  const r1 = roundsByPlayer[match.player1Id];
  const r2 = roundsByPlayer[match.player2Id];
  if (!r1 || !r2) return null;
  return { score1: r1.score, score2: r2.score };
}

module.exports = { validateRound, resultFromRounds, HOLES, MIN_SCORE };
