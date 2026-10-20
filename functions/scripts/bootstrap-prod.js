'use strict';

/**
 * One-time setup of the production project: creates the administrator and
 * demo player accounts and the demonstration tournaments.
 *
 *   gcloud auth application-default login     # once, signs in as you
 *   node scripts/bootstrap-prod.js tlms-venue
 *
 * Passwords are typed when prompted (input is hidden) and are never written
 * to a file, so they cannot end up in the repository. Running it again
 * resets the demo tournaments and updates the account passwords.
 */
const readline = require('node:readline');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { seed } = require('./seed');

const projectId = process.argv[2];

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  if (!projectId || projectId.startsWith('demo-')) {
    throw new Error('Usage: node scripts/bootstrap-prod.js <production-project-id>');
  }
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Emulator variables are set; unset them to target production.');
  }
  const admin = await askHidden('Password for admin@venue.test (8+ characters): ');
  const player = await askHidden('Password for the demo player accounts (8+ characters): ');
  if (admin.length < 8 || player.length < 8) throw new Error('Passwords must be at least 8 characters.');

  initializeApp({ credential: applicationDefault(), projectId });
  await seed({ db: getFirestore(), auth: getAuth(), passwords: { admin, player } });
  console.log(`Production project ${projectId} is set up: admin@venue.test, player@venue.test, demo1-6@venue.test, and 3 demo tournaments.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
