'use strict';

/**
 * Triggers the match reminder job now (the emulator does not run the hourly
 * schedule). Run while the emulators are running:
 *
 *   npm run send:reminders
 *
 * Reminders go to players in matches that are ready to play, in tournaments
 * whose event day is today or tomorrow. Each reminder is sent only once.
 */
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key';
const API = 'http://127.0.0.1:5002/api/v1';

async function main() {
  const login = await (await fetch(AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@venue.test', password: 'AdminPassword123', returnSecureToken: true }),
  })).json();
  if (!login.idToken) throw new Error('Could not sign in as admin@venue.test. Are the emulators running and seeded?');
  const res = await fetch(`${API}/admin/reminders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.idToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  console.log(`Reminders sent: ${body.sent}, already sent earlier: ${body.alreadySent}, failed: ${body.failed}, tournaments checked: ${body.tournaments}`);
  if (!body.tournaments) console.log('No in-progress tournament is happening today or tomorrow, so there was nothing to remind.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
