'use strict';

// Unit tests for the round-robin engine, including the odd-field bye rotation
// that failed in the alpha. Structural tests run for every count from 2 to 128.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateRoundRobin,
  recordRoundRobinResult,
  computeStandings,
} = require('../roundRobin');

const MIN = 2;
const MAX = 128;
const roster = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

for (let n = MIN; n <= MAX; n++) {
  test(`round robin schedule is valid for ${n} players`, () => {
    const players = roster(n);
    const s = generateRoundRobin(players);
    const expectedRounds = n % 2 === 0 ? n - 1 : n;

    assert.equal(s.rounds.length, expectedRounds);
    assert.equal(s.matches.length, (n * (n - 1)) / 2, 'every pair meets once');

    // No pair meets twice.
    const pairs = new Set(s.matches.map((m) => [m.player1Id, m.player2Id].sort().join('|')));
    assert.equal(pairs.size, s.matches.length);

    // Nobody plays twice in one round, and everyone not on a bye plays.
    for (const { round, byePlayerId } of s.rounds) {
      const inRound = s.matches
        .filter((m) => m.round === round)
        .flatMap((m) => [m.player1Id, m.player2Id]);
      assert.equal(new Set(inRound).size, inRound.length, `round ${round} repeats a player`);
      assert.equal(inRound.length + (byePlayerId ? 1 : 0), n);
    }

    // Odd fields: each player sits out exactly once. Even fields: no byes.
    const byes = s.rounds.map((r) => r.byePlayerId).filter(Boolean);
    if (n % 2 === 1) {
      assert.equal(byes.length, n);
      assert.deepEqual([...byes].sort(), [...players].sort());
    } else {
      assert.equal(byes.length, 0);
    }
  });
}

test('round-robin results allow ties and corrections', () => {
  let s = generateRoundRobin(['a', 'b']);
  s = recordRoundRobinResult(s, s.matches[0].id, 72, 72);
  assert.equal(s.matches[0].winnerId, null);
  s = recordRoundRobinResult(s, s.matches[0].id, 70, 72);
  assert.equal(s.matches[0].winnerId, s.matches[0].player1Id);
});

test('standings rank by points, then head-to-head, differential and seed', () => {
  const players = ['a', 'b', 'c', 'd'];
  let s = generateRoundRobin(players);
  // Low score wins. Results chosen so a and b both finish 2-1, with b having
  // beaten a, while a has the better differential.
  const result = { 'a|b': ['b', 1], 'a|c': ['a', 10], 'a|d': ['a', 10], 'b|c': ['c', 1], 'b|d': ['b', 1], 'c|d': ['d', 1] };
  for (const m of s.matches) {
    const key = [m.player1Id, m.player2Id].sort().join('|');
    const [winner, margin] = result[key];
    const p1Wins = winner === m.player1Id;
    s = recordRoundRobinResult(s, m.id, p1Wins ? 70 : 70 + margin, p1Wins ? 70 + margin : 70);
  }
  const table = computeStandings(s, players);
  assert.deepEqual(table.slice(0, 2).map((r) => r.playerId), ['b', 'a'], 'head-to-head beats differential');
  assert.equal(table[0].points, 2);
});

test('fully tied players fall back to seed order', () => {
  const players = ['a', 'b', 'c'];
  const s = generateRoundRobin(players);
  const table = computeStandings(s, players);
  assert.deepEqual(table.map((r) => r.playerId), players);
});
