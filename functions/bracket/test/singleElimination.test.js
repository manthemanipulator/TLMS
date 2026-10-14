'use strict';

// Unit tests for the single-elimination engine. The structural tests run for
// every participant count from 2 through 128, the full range the requirements
// specify.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateSingleElimination,
  recordResult,
  swapPlayers,
  seedPositions,
} = require('../singleElimination');

const MIN = 2;
const MAX = 128;
const roster = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

/** Plays every match in round order; the lower seed number always wins. */
function playOut(bracket, playerIds) {
  const seedOf = new Map(playerIds.map((id, i) => [id, i + 1]));
  let current = bracket;
  for (let round = 1; round <= current.rounds; round++) {
    for (const m of current.matches.filter((x) => x.round === round && x.status === 'scheduled')) {
      const p1Better = seedOf.get(m.player1Id) < seedOf.get(m.player2Id);
      current = recordResult(current, m.id, p1Better ? 70 : 75, p1Better ? 75 : 70);
    }
  }
  return current;
}

test('seed placement keeps the top two seeds apart until the final', () => {
  assert.deepEqual(seedPositions(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

for (let n = MIN; n <= MAX; n++) {
  test(`single elimination structure is valid for ${n} players`, () => {
    const players = roster(n);
    const bracket = generateSingleElimination(players);
    const size = bracket.size;

    // Size is the smallest power of two at or above n.
    assert.ok(size >= n && size / 2 < n, `size ${size} for ${n} players`);
    assert.equal(bracket.matches.length, size - 1);

    const roundOne = bracket.matches.filter((m) => m.round === 1);
    const byes = roundOne.filter((m) => m.status === 'bye');
    assert.equal(byes.length, size - n, 'one bye per empty slot');

    // Every player appears exactly once in round one.
    const seen = roundOne.flatMap((m) => [m.player1Id, m.player2Id]).filter(Boolean);
    assert.equal(seen.length, n);
    assert.equal(new Set(seen).size, n);

    // Byes go to the highest seeds and only appear in round one.
    const byeRecipients = byes.map((m) => m.winnerId).sort();
    assert.deepEqual(byeRecipients, players.slice(0, size - n).sort());
    assert.ok(bracket.matches.every((m) => m.round === 1 || m.status !== 'bye'));

    // Playing it out produces exactly one champion: the top seed, since the
    // better seed always wins in this simulation.
    const finished = playOut(bracket, players);
    assert.equal(finished.championId, 'p1');
    const played = finished.matches.filter((m) => m.status === 'completed');
    assert.equal(played.length, n - 1, 'n - 1 matches eliminate n - 1 players');
  });
}

test('high-score formats advance the higher score', () => {
  const b = generateSingleElimination(['a', 'b'], { lowScoreWins: false });
  assert.equal(recordResult(b, 'R1-M0', 10, 3).championId, 'a');
  assert.equal(recordResult(b, 'R1-M0', 3, 10).championId, 'b');
});

test('recordResult does not modify the bracket it is given', () => {
  const b = generateSingleElimination(roster(4));
  const before = JSON.stringify(b);
  recordResult(b, 'R1-M0', 70, 72);
  assert.equal(JSON.stringify(b), before);
});

test('ties are rejected in elimination play', () => {
  const b = generateSingleElimination(roster(4));
  assert.throws(() => recordResult(b, 'R1-M0', 72, 72), /tie/);
});

test('results cannot be recorded before both players are known', () => {
  const b = generateSingleElimination(roster(4));
  assert.throws(() => recordResult(b, 'R2-M0', 70, 72), /waiting/);
});

test('a result can be corrected while the next match is unplayed', () => {
  let b = generateSingleElimination(roster(4)); // R1-M0: p1 vs p4
  b = recordResult(b, 'R1-M0', 70, 72);          // p1 wins
  b = recordResult(b, 'R1-M0', 74, 72);          // corrected: p4 wins
  const final = b.matches.find((m) => m.id === 'R2-M0');
  assert.equal(final.player1Id, 'p4');
});

test('a result cannot be corrected once the next match has a result', () => {
  let b = generateSingleElimination(roster(4));
  b = recordResult(b, 'R1-M0', 70, 72);
  b = recordResult(b, 'R1-M1', 70, 72);
  b = recordResult(b, 'R2-M0', 68, 71);
  assert.throws(() => recordResult(b, 'R1-M0', 74, 72), /already has a result/);
});

test('administrators can swap players between unplayed first-round matches', () => {
  const b = generateSingleElimination(roster(8)); // R1-M0: p1 vs p8, R1-M1: p4 vs p5
  const edited = swapPlayers(b, 'p8', 'p5');
  assert.equal(edited.matches[0].player2Id, 'p5');
  assert.equal(edited.matches[1].player2Id, 'p8');
});

test('swaps are refused for byes, played matches and same-match pairs', () => {
  const withBye = generateSingleElimination(roster(3)); // p1 has a bye
  assert.throws(() => swapPlayers(withBye, 'p1', 'p2'), /bye/);

  const b = generateSingleElimination(roster(8));
  assert.throws(() => swapPlayers(b, 'p1', 'p8'), /already paired/);
  const played = recordResult(b, 'R1-M0', 70, 72);
  assert.throws(() => swapPlayers(played, 'p1', 'p5'), /completed/);
});

test('invalid rosters are rejected', () => {
  assert.throws(() => generateSingleElimination([]), RangeError);
  assert.throws(() => generateSingleElimination(['solo']), RangeError);
  assert.throws(() => generateSingleElimination(['a', 'a']), /Duplicate/);
  assert.throws(() => generateSingleElimination(['a', '']), TypeError);
});
