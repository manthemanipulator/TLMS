'use strict';

// Unit tests for the Paper Golf adapter's round validation and pairing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRound, resultFromRounds } = require('../../src/adapters/paperGolfAdapter');

const holes = (n = 4) => Array(18).fill(n); // 18 holes of n strokes
const round = (strokes) => ({ score: strokes.reduce((a, b) => a + b, 0), holeScores: strokes, initials: 'sam', mode: 'random' });

test('a valid Paper Golf round is accepted and normalized', () => {
  const r = validateRound(round(holes(4)));
  assert.equal(r.score, 72);
  assert.equal(r.initials, 'SAM');
  assert.equal(r.holeScores.length, 18);
});

test('rounds the game itself would reject are rejected', () => {
  assert.throws(() => validateRound(null), /required/);
  assert.throws(() => validateRound({ score: 18, holeScores: holes(1) }), /at least 54/);
  assert.throws(() => validateRound({ score: 72.5, holeScores: holes(4) }), /whole number/);
  assert.throws(() => validateRound({ score: 68, holeScores: holes(4).slice(0, 17) }), /all 18 holes/);
  assert.throws(() => validateRound({ score: 72, holeScores: [...holes(4).slice(0, 17), 0] }), /1 to 30/);
  assert.throws(() => validateRound({ score: 70, holeScores: holes(4) }), /does not match/);
});

test('a result is produced only when both players have a round', () => {
  const match = { player1Id: 'a', player2Id: 'b' };
  assert.equal(resultFromRounds(match, { a: { score: 70 } }), null);
  assert.deepEqual(resultFromRounds(match, { a: { score: 70 }, b: { score: 74 } }), { score1: 70, score2: 74 });
  assert.deepEqual(resultFromRounds(match, { b: { score: 74 }, a: { score: 70 } }), { score1: 70, score2: 74 });
});
