'use strict';

/**
 * Seeds the local emulators with demo accounts and tournaments so the app can
 * be tried immediately. Run while `firebase emulators:start` is running:
 *
 *   npm run seed
 *
 * Accounts (emulator only, never used outside local testing):
 *   admin@venue.test  / AdminPassword123   (administrator)
 *   player@venue.test / Password123        (player)
 *
 * It refuses to run unless it is pointed at the emulators, so it can never
 * write to a real Firebase project.
 */
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const PROJECT = 'demo-tlms';
if (!PROJECT.startsWith('demo-')) throw new Error('Seed script only runs against demo projects');

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

async function user(email, password, name, claims) {
  let record;
  try {
    record = await auth.getUserByEmail(email);
  } catch {
    record = await auth.createUser({ email, password, displayName: name });
  }
  if (claims) await auth.setCustomUserClaims(record.uid, claims);
  await db.doc(`players/${record.uid}`).set(
    { name, email, authUid: record.uid, handicap: null, createdAt: Timestamp.now() },
    { merge: true }
  );
  return record.uid;
}

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function main() {
  const adminUid = await user('admin@venue.test', 'AdminPassword123', 'Venue Admin', { admin: true });
  await user('player@venue.test', 'Password123', 'Sam Player');

  // Six players who are already registered and paid, so the administrator
  // can close a roster and play a bracket right away.
  const names = ['Avery Brooks', 'Jordan Lee', 'Riley Chen', 'Morgan Diaz', 'Casey Patel', 'Taylor Kim'];
  const paid = [];
  for (const [i, name] of names.entries()) {
    paid.push(await user(`demo${i + 1}@venue.test`, 'Password123', name));
  }

  const tournaments = [
    {
      id: 'fall-classic',
      name: 'Fall Classic',
      format: 'single_elimination',
      date: days(10).slice(0, 10),
      registrationDeadline: days(7),
      capacity: 16,
      entryFeeCents: 1500,
      venue: 'Main Course',
      prereg: paid.slice(0, 5),
    },
    {
      id: 'thursday-league',
      name: 'Thursday League Night',
      format: 'round_robin',
      date: days(3).slice(0, 10),
      registrationDeadline: days(2),
      capacity: 8,
      entryFeeCents: 0,
      venue: 'Practice Green',
      prereg: paid.slice(2, 6),
    },
    {
      // Happens tomorrow, so match reminders can be tried right away:
      // close the roster as admin, then run `npm run send:reminders`.
      id: 'friday-match-play',
      name: 'Friday Match Play',
      format: 'single_elimination',
      date: days(1).slice(0, 10),
      registrationDeadline: days(0.5),
      capacity: 8,
      entryFeeCents: 0,
      venue: 'Back Nine',
      prereg: [paid[0], paid[1], paid[4], paid[5]],
    },
  ];

  for (const { id, prereg, ...t } of tournaments) {
    await db.doc(`tournaments/${id}`).set({
      ...t,
      lowScoreWins: true,
      adminId: adminUid,
      status: 'open',
      registeredCount: prereg.length,
      createdAt: Timestamp.now(),
    });
    for (const [i, uid] of prereg.entries()) {
      const created = Timestamp.fromMillis(Date.now() - (prereg.length - i) * 60000);
      await db.doc(`registrations/${id}_${uid}`).set({
        playerId: uid,
        tournamentId: id,
        paymentStatus: 'paid',
        paymentReference: t.entryFeeCents ? 'seeded' : null,
        attempt: 1,
        createdAt: created,
        holdExpiresAt: created,
      });
    }
  }
  console.log('Seeded: 1 admin, 7 players, 3 tournaments. Sign in at http://localhost:5002');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
