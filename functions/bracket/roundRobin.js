'use strict';

/**
 * Round-robin schedule generation and standings, using the circle method.
 *
 * Like the single-elimination engine, these are pure functions: no database
 * access, deterministic output for a given roster, and safe to unit test for
 * every participant count.
 *
 * Schedule shape:
 *   {
 *     format: 'round_robin',
 *     lowScoreWins,
 *     rounds: [{ round, byePlayerId }],  // byePlayerId is null for even fields
 *     matches: [Match]                    // same fields as single elimination,
 *                                         // without nextMatchId/nextSlot
 *   }
 */

const { validateRoster } = require('./singleElimination');

const BYE = null; // Placeholder that pads an odd field to an even count.

/**
 * Builds a round-robin schedule in which every player meets every other
 * player exactly once.
 *
 * Circle method: the first entry stays fixed and the rest rotate one place
 * each round. With an odd field a BYE placeholder is added, and because the
 * placeholder takes part in the rotation, each player sits out exactly once.
 * The unit tests check that property for every odd field size.
 */
function generateRoundRobin(playerIds, options = {}) {
  validateRoster(playerIds);
  const lowScoreWins = options.lowScoreWins !== false;

  const entries = playerIds.length % 2 === 0 ? [...playerIds] : [...playerIds, BYE];
  const count = entries.length;
  const roundTotal = count - 1;
  const half = count / 2;

  const rounds = [];
  const matches = [];
  let rotating = entries.slice(1);

  for (let round = 1; round <= roundTotal; round++) {
    const lineup = [entries[0], ...rotating];
    let byePlayerId = null;
    let index = 0;

    // Pair the first half of the lineup against the reversed second half.
    for (let i = 0; i < half; i++) {
      const a = lineup[i];
      const b = lineup[count - 1 - i];
      if (a === BYE || b === BYE) {
        byePlayerId = a === BYE ? b : a;
        continue;
      }
      matches.push({
        id: `RR${round}-M${index}`,
        round,
        index,
        player1Id: a,
        player2Id: b,
        score1: null,
        score2: null,
        winnerId: null,
        status: 'scheduled',
      });
      index++;
    }
    rounds.push({ round, byePlayerId });

    // Rotate: the last entry moves to the front of the rotating group.
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }

  return { format: 'round_robin', lowScoreWins, rounds, matches };
}

/**
 * Records a round-robin result. Unlike elimination play, a tie is allowed and
 * leaves winnerId null. Results can be corrected at any time because no other
 * match depends on them. Returns a new schedule.
 */
function recordRoundRobinResult(schedule, id, score1, score2) {
  if (!Number.isFinite(score1) || !Number.isFinite(score2)) {
    throw new TypeError('Scores must be finite numbers');
  }
  const next = structuredClone(schedule);
  const match = next.matches.find((m) => m.id === id);
  if (!match) throw new Error(`No match with ID ${id}`);

  match.score1 = score1;
  match.score2 = score2;
  if (score1 === score2) {
    match.winnerId = null;
  } else {
    const player1Won = next.lowScoreWins ? score1 < score2 : score1 > score2;
    match.winnerId = player1Won ? match.player1Id : match.player2Id;
  }
  match.status = 'completed';
  return next;
}

/**
 * Computes standings from completed matches.
 *
 * Points: win = 1, tie = 0.5, loss = 0. Ties in points are broken, in order,
 * by the head-to-head points among only the tied players, then by score
 * differential (computed so that a positive number is always good, whether
 * low or high scores win), then by seed (the roster order, which defaults to
 * registration timestamp).
 */
function computeStandings(schedule, playerIds) {
  const rows = new Map(
    playerIds.map((id, i) => [
      id,
      { playerId: id, seed: i + 1, played: 0, wins: 0, losses: 0, ties: 0, points: 0, differential: 0 },
    ])
  );
  const completed = schedule.matches.filter((m) => m.status === 'completed');

  for (const m of completed) {
    const p1 = rows.get(m.player1Id);
    const p2 = rows.get(m.player2Id);
    p1.played++;
    p2.played++;
    const margin = schedule.lowScoreWins ? m.score2 - m.score1 : m.score1 - m.score2;
    p1.differential += margin;
    p2.differential -= margin;
    if (m.winnerId === null) {
      p1.ties++; p2.ties++; p1.points += 0.5; p2.points += 0.5;
    } else if (m.winnerId === m.player1Id) {
      p1.wins++; p2.losses++; p1.points += 1;
    } else {
      p2.wins++; p1.losses++; p2.points += 1;
    }
  }

  const headToHead = (group) => {
    const ids = new Set(group.map((r) => r.playerId));
    const pts = new Map(group.map((r) => [r.playerId, 0]));
    for (const m of completed) {
      if (!ids.has(m.player1Id) || !ids.has(m.player2Id)) continue;
      if (m.winnerId === null) {
        pts.set(m.player1Id, pts.get(m.player1Id) + 0.5);
        pts.set(m.player2Id, pts.get(m.player2Id) + 0.5);
      } else {
        pts.set(m.winnerId, pts.get(m.winnerId) + 1);
      }
    }
    return pts;
  };

  // Group by points, then order each tied group with the tiebreakers.
  const byPoints = new Map();
  for (const row of rows.values()) {
    if (!byPoints.has(row.points)) byPoints.set(row.points, []);
    byPoints.get(row.points).push(row);
  }
  const ordered = [];
  for (const points of [...byPoints.keys()].sort((a, b) => b - a)) {
    const group = byPoints.get(points);
    const h2h = group.length > 1 ? headToHead(group) : new Map();
    group.sort(
      (a, b) =>
        (h2h.get(b.playerId) ?? 0) - (h2h.get(a.playerId) ?? 0) ||
        b.differential - a.differential ||
        a.seed - b.seed
    );
    ordered.push(...group);
  }
  return ordered.map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { generateRoundRobin, recordRoundRobinResult, computeStandings };
