'use strict';

// Security rules tests. These run against the Firestore emulator and check
// that clients can read only what their role allows and can never write.
// Run with: npm run test:rules

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-tlms',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') },
  });
  // Seed data with rules disabled, standing in for what the functions write.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'tournaments/t1'), { name: 'Fall Classic', status: 'open' });
    await setDoc(doc(db, 'tournaments/t1/matches/R1-M0'), { player1Id: 'alice', player2Id: 'bob' });
    await setDoc(doc(db, 'players/alice'), { name: 'Alice' });
    await setDoc(doc(db, 'players/bob'), { name: 'Bob' });
    await setDoc(doc(db, 'registrations/t1_alice'), { playerId: 'alice', tournamentId: 't1', paymentStatus: 'paid' });
    await setDoc(doc(db, 'registrations/t1_bob'), { playerId: 'bob', tournamentId: 't1', paymentStatus: 'paid' });
  });
});

test.after(async () => {
  await env.cleanup();
});

const alice = () => env.authenticatedContext('alice').firestore();
const admin = () => env.authenticatedContext('admin1', { admin: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('signed-in players can read tournaments and matches', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'tournaments/t1')));
  await assertSucceeds(getDoc(doc(alice(), 'tournaments/t1/matches/R1-M0')));
});

test('signed-out visitors cannot read anything', async () => {
  await assertFails(getDoc(doc(anon(), 'tournaments/t1')));
  await assertFails(getDoc(doc(anon(), 'registrations/t1_alice')));
});

test('a player can read only their own profile and registration', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'players/alice')));
  await assertSucceeds(getDoc(doc(alice(), 'registrations/t1_alice')));
  await assertFails(getDoc(doc(alice(), 'players/bob')));
  await assertFails(getDoc(doc(alice(), 'registrations/t1_bob')));
});

test('administrators can read every profile and registration', async () => {
  await assertSucceeds(getDoc(doc(admin(), 'players/bob')));
  await assertSucceeds(getDoc(doc(admin(), 'registrations/t1_bob')));
});

test('players cannot write anything directly, including their own records', async () => {
  await assertFails(setDoc(doc(alice(), 'registrations/t1_alice'), { playerId: 'alice', paymentStatus: 'paid' }));
  await assertFails(updateDoc(doc(alice(), 'players/alice'), { name: 'Hacker' }));
  await assertFails(setDoc(doc(alice(), 'tournaments/t2'), { name: 'Fake' }));
  await assertFails(deleteDoc(doc(alice(), 'tournaments/t1/matches/R1-M0')));
});

test('administrators cannot write directly either; writes go through functions', async () => {
  await assertFails(updateDoc(doc(admin(), 'tournaments/t1'), { status: 'closed' }));
  await assertFails(setDoc(doc(admin(), 'tournaments/t1/matches/R1-M0'), { winnerId: 'bob' }));
});

test('unlisted collections are closed', async () => {
  await assertFails(getDoc(doc(admin(), 'secrets/x')));
  await assertFails(setDoc(doc(admin(), 'secrets/x'), { a: 1 }));
});
