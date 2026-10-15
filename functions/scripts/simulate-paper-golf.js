'use strict';

/**
 * Simulates the Paper Golf scoring engine reporting rounds to TLMS.
 *
 *   npm run test:scoring                 # uses the "fall-classic" tournament
 *   npm run test:scoring -- <tournamentId>
 *
 * Run while the emulators are running and after the roster has been closed.
 * It signs in as the emulator-only admin account, finds the first match
 * that is waiting for a result, generates a plausible 18-hole round for each
 * player in Paper Golf's own format, and submits both through the same API
 * endpoint the integration uses. The bracket in the browser updates live.
 */
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key';
const API = 'http://127.0.0.1:5002/api/v1';
const tournamentId = process.argv[2] || 'fall-classic';

/** A believable Paper Golf round: mostly pars and bogeys, the odd birdie. */
function randomRound() {
  const holeScores = Array.from({ length: 18 }, () => {
    const r = Math.random();
    return r < 0.15 ? 3 : r < 0.6 ? 4 : r < 0.9 ? 5 : 6;
  });
  return { score: holeScores.reduce((a, b) => a + b, 0), holeScores, initials: 'SIM', mode: 'random' };
}

async function main() {
  const login = await (await fetch(AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@venue.test', password: 'AdminPassword123', returnSecureToken: true }),
  })).json();
  if (!login.idToken) throw new Error('Could not sign in as admin@venue.test. Are the emulators running and seeded?');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.idToken}` };

  const board = await (await fetch(`${API}/tournaments/${tournamentId}/leaderboard`, { headers })).json();
  if (!board.matches) throw new Error(`No bracket yet for "${tournamentId}". Close the roster first.`);
  const match = board.matches.find((m) => m.status === 'scheduled');
  if (!match) return console.log('Every match already has a result.');

  console.log(`Match ${match.id}: ${board.players[match.player1Id]} vs ${board.players[match.player2Id]}`);
  for (const playerId of [match.player1Id, match.player2Id]) {
    const round = randomRound();
    const res = await fetch(`${API}/tournaments/${tournamentId}/matches/${match.id}/paper-golf`, {
      method: 'POST', headers, body: JSON.stringify({ playerId, round }),
    });
    const body = await res.json();
    console.log(`  ${board.players[playerId]} shot ${round.score} -> ${res.status} ${body.outcome || body.error}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
