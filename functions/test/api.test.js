'use strict';

// Integration tests for the REST API. They start the Express app in-process
// and point the Admin SDK at the Auth and Firestore emulators, so every test
// uses real ID tokens, real custom claims and real Firestore transactions.
// Run with: npm run test:api

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createApp } = require('../src/app');

const PROJECT = 'demo-tlms';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const HAS_FIRESTORE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

let server;
let base;
const tokens = {};

/** Creates an emulator user and returns a fresh ID token (with claims). */
async function makeUser(email, claims) {
  const url = (op) => `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:${op}?key=fake-key`;
  const body = { email, password: 'test-password', returnSecureToken: true };
  const signUp = await (await fetch(url('signUp'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (claims) await auth.setCustomUserClaims(signUp.localId, claims);
  const signIn = await (await fetch(url('signInWithPassword'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { uid: signUp.localId, token: signIn.idToken };
}

/** Calls the API and returns { status, body }. */
async function call(method, path, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tokens[who]?.token ?? who}`;
  const res = await fetch(`${base}/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

/** Marks a registration paid, standing in for the Stripe webhook (not built yet). */
async function markPaid(tournamentId, who) {
  await db.doc(`registrations/${tournamentId}_${tokens[who].uid}`).update({ paymentStatus: 'paid' });
}

const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const tournamentBody = (overrides = {}) => ({
  name: 'Fall Classic',
  format: 'single_elimination',
  date: future(10).slice(0, 10),
  registrationDeadline: future(5),
  capacity: 8,
  entryFeeCents: 1500,
  ...overrides,
});

test.before(async () => {
  const app = createApp({ db, auth });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await makeUser('admin@venue.test', { admin: true });
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank']) {
    tokens[name] = await makeUser(`${name}@venue.test`);
  }
});

test.after(() => server.close());

// --- Authentication and validation (no Firestore needed) -------------------

test('requests without a token get 401', async () => {
  assert.equal((await call('GET', '/tournaments')).status, 401);
});

test('requests with a forged token get 401', async () => {
  assert.equal((await call('GET', '/tournaments', 'not-a-real-token')).status, 401);
});

test('players cannot create tournaments (403)', async () => {
  assert.equal((await call('POST', '/tournaments', 'alice', tournamentBody())).status, 403);
});

test('invalid tournament details are rejected with 400', async () => {
  const r = await call('POST', '/tournaments', 'admin', tournamentBody({ capacity: 500, format: 'swiss', entryFeeCents: 9.99 }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /capacity/);
  assert.match(r.body.error, /format/);
  assert.match(r.body.error, /entryFeeCents/);
});

// --- Full tournament flows (need the Firestore emulator) -------------------

const flow = { skip: !HAS_FIRESTORE && 'Firestore emulator not running' };

test('single elimination: register, close, play to a champion', flow, async () => {
  const created = await call('POST', '/tournaments', 'admin', tournamentBody({ capacity: 3 }));
  assert.equal(created.status, 201);
  const id = created.body.id;

  const list = await call('GET', '/tournaments', 'alice');
  assert.ok(list.body.tournaments.some((t) => t.id === id));

  // Registration, duplicate (409) and capacity (409).
  assert.equal((await call('POST', '/registrations', 'alice', { tournamentId: id })).status, 201);
  const dup = await call('POST', '/registrations', 'alice', { tournamentId: id });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already registered/);
  assert.equal((await call('POST', '/registrations', 'bob', { tournamentId: id })).status, 201);
  assert.equal((await call('POST', '/registrations', 'carol', { tournamentId: id })).status, 201);
  const full = await call('POST', '/registrations', 'dave', { tournamentId: id });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full/);

  // Players can see only their own registration in Firestore terms; here we
  // check the API created the player profile and seat count.
  const t = (await db.doc(`tournaments/${id}`).get()).data();
  assert.equal(t.registeredCount, 3);
  assert.ok((await db.doc(`players/${tokens.alice.uid}`).get()).exists);

  // Closing with fewer than two paid players fails and leaves it open.
  const early = await call('POST', `/tournaments/${id}/close`, 'admin');
  assert.equal(early.status, 409);
  assert.equal((await db.doc(`tournaments/${id}`).get()).data().status, 'open');

  for (const p of ['alice', 'bob', 'carol']) await markPaid(id, p);
  assert.equal((await call('POST', `/tournaments/${id}/close`, 'alice')).status, 403);
  const closed = await call('POST', `/tournaments/${id}/close`, 'admin');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.matches, 3); // bracket of 4: two semis (one bye) + final
  assert.equal((await call('POST', `/tournaments/${id}/close`, 'admin')).status, 409);

  // Alice registered first, so she is seed 1 and has the bye.
  const board = await call('GET', `/tournaments/${id}/leaderboard`, 'bob');
  const semi = board.body.matches.find((m) => m.id === 'R1-M1');
  assert.deepEqual([semi.player1Id, semi.player2Id], [tokens.bob.uid, tokens.carol.uid]);

  // Results: players cannot enter scores, ties are refused, golf scoring.
  const path = (m) => `/tournaments/${id}/matches/${m}/result`;
  assert.equal((await call('POST', path('R1-M1'), 'bob', { score1: 70, score2: 72 })).status, 403);
  assert.equal((await call('POST', path('R1-M1'), 'admin', { score1: 72, score2: 72 })).status, 409);
  assert.equal((await call('POST', path('R1-M9'), 'admin', { score1: 70, score2: 72 })).status, 404);
  const semiResult = await call('POST', path('R1-M1'), 'admin', { score1: 74, score2: 71 });
  assert.equal(semiResult.status, 200);
  assert.deepEqual(semiResult.body.updatedMatches.sort(), ['R1-M1', 'R2-M0']);

  const final = await call('POST', path('R2-M0'), 'admin', { score1: 69, score2: 73 });
  assert.equal(final.body.status, 'completed');
  assert.equal(final.body.championId, tokens.alice.uid);

  // A completed tournament accepts no more changes.
  assert.equal((await call('POST', path('R1-M1'), 'admin', { score1: 70, score2: 72 })).status, 409);
});

test('registration is refused after the roster closes', flow, async () => {
  const id = (await call('POST', '/tournaments', 'admin', tournamentBody())).body.id;
  for (const p of ['alice', 'bob']) {
    await call('POST', '/registrations', p, { tournamentId: id });
    await markPaid(id, p);
  }
  await call('POST', `/tournaments/${id}/close`, 'admin');
  const late = await call('POST', '/registrations', 'carol', { tournamentId: id });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /closed/);
});

test('unpaid registrations are not seeded into the bracket', flow, async () => {
  const id = (await call('POST', '/tournaments', 'admin', tournamentBody())).body.id;
  for (const p of ['alice', 'bob', 'carol']) await call('POST', '/registrations', p, { tournamentId: id });
  await markPaid(id, 'alice');
  await markPaid(id, 'bob');
  const closed = await call('POST', `/tournaments/${id}/close`, 'admin');
  assert.equal(closed.body.players, 2);
});

test('administrators can swap first-round players before play starts', flow, async () => {
  const id = (await call('POST', '/tournaments', 'admin', tournamentBody())).body.id;
  const players = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank'];
  for (const p of players) {
    await call('POST', '/registrations', p, { tournamentId: id });
    await markPaid(id, p);
  }
  await call('POST', `/tournaments/${id}/close`, 'admin');
  // Seeds follow registration order: R1-M0 is alice (1) vs hank (8),
  // R1-M1 is dave (4) vs erin (5).
  const swap = await call('POST', `/tournaments/${id}/swap`, 'admin', { playerA: tokens.hank.uid, playerB: tokens.erin.uid });
  assert.equal(swap.status, 200);
  const m0 = (await db.doc(`tournaments/${id}/matches/R1-M0`).get()).data();
  assert.equal(m0.player2Id, tokens.erin.uid);
  // Swapping into a played match is refused.
  await call('POST', `/tournaments/${id}/matches/R1-M0/result`, 'admin', { score1: 70, score2: 72 });
  assert.equal((await call('POST', `/tournaments/${id}/swap`, 'admin', { playerA: tokens.alice.uid, playerB: tokens.bob.uid })).status, 409);
});

test('round robin: schedule, results with a tie, and standings', flow, async () => {
  const id = (await call('POST', '/tournaments', 'admin', tournamentBody({ format: 'round_robin' }))).body.id;
  for (const p of ['alice', 'bob', 'carol']) {
    await call('POST', '/registrations', p, { tournamentId: id });
    await markPaid(id, p);
  }
  const closed = await call('POST', `/tournaments/${id}/close`, 'admin');
  assert.equal(closed.body.matches, 3);

  const matches = (await db.collection(`tournaments/${id}/matches`).get()).docs.map((d) => d.data());
  const score = { [tokens.alice.uid]: 68, [tokens.bob.uid]: 72, [tokens.carol.uid]: 72 };
  let last;
  for (const m of matches) {
    last = await call('POST', `/tournaments/${id}/matches/${m.id}/result`, 'admin', { score1: score[m.player1Id], score2: score[m.player2Id] });
    assert.equal(last.status, 200);
  }
  assert.equal(last.body.status, 'completed');

  const board = await call('GET', `/tournaments/${id}/leaderboard`, 'carol');
  assert.equal(board.body.standings[0].playerId, tokens.alice.uid);
  assert.equal(board.body.standings[0].points, 2);
  // Bob and Carol tied their match; Bob registered first, so he ranks ahead.
  assert.deepEqual(board.body.standings.slice(1).map((r) => r.playerId), [tokens.bob.uid, tokens.carol.uid]);
});
