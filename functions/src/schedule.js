'use strict';

/**
 * Converts between the bracket engine's in-memory schedule object and its
 * Firestore representation:
 *   tournaments/{id}                 schedule metadata (format, size, rounds,
 *                                    seedOrder, championId, ...)
 *   tournaments/{id}/matches/{mid}   one document per match
 * Keeping each match in its own document matches the MATCH entity in the
 * design and lets the client subscribe to live bracket updates.
 */
const engine = require('../bracket');

/** Rebuilds the engine's schedule object from a tournament and its match docs. */
function toEngineSchedule(tournament, matches) {
  if (tournament.format === 'single_elimination') {
    return {
      format: 'single_elimination',
      size: tournament.size,
      rounds: tournament.rounds,
      lowScoreWins: tournament.lowScoreWins,
      championId: tournament.championId ?? null,
      matches: sortMatches(matches),
    };
  }
  return {
    format: 'round_robin',
    lowScoreWins: tournament.lowScoreWins,
    rounds: tournament.roundByes,
    matches: sortMatches(matches),
  };
}

/** Tournament-level fields to store after generating a schedule. */
function scheduleMetadata(schedule, seedOrder) {
  const base = { seedOrder, championId: null };
  if (schedule.format === 'single_elimination') {
    return { ...base, size: schedule.size, rounds: schedule.rounds };
  }
  return { ...base, roundByes: schedule.rounds, rounds: schedule.rounds.length };
}

/** Returns the matches whose contents differ between two schedules. */
function changedMatches(before, after) {
  const old = new Map(before.matches.map((m) => [m.id, JSON.stringify(m)]));
  return after.matches.filter((m) => old.get(m.id) !== JSON.stringify(m));
}

/** True when every non-bye match has a result. */
function isComplete(schedule) {
  if (schedule.format === 'single_elimination') return Boolean(schedule.championId);
  return schedule.matches.every((m) => m.status === 'completed');
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => a.round - b.round || a.index - b.index);
}

/**
 * Runs an engine function and tags any error it throws, so the HTTP layer can
 * report rule violations (ties, edits to played matches) as 409 conflicts.
 */
function runEngine(fn) {
  try {
    return fn();
  } catch (err) {
    err.engineError = true;
    throw err;
  }
}

module.exports = { engine, toEngineSchedule, scheduleMetadata, changedMatches, isComplete, runEngine };
