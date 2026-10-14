'use strict';

/**
 * REST interface for the Tournament & League Management System, version 1.
 * Implements the endpoints from Table 2 of the Module 2 design document.
 *
 * createApp() receives the Firestore and Auth instances instead of creating
 * them, so the same app runs inside Cloud Functions and inside the
 * integration tests against the Firebase emulators.
 *
 * Writes use the Admin SDK, which bypasses security rules, so every write
 * handler checks the caller's role itself (requireUser / requireAdmin).
 */
const express = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { requireUser, requireAdmin } = require('./auth');
const { badRequest, notFound, conflict, errorHandler } = require('./errors');
const { engine, toEngineSchedule, scheduleMetadata, changedMatches, isComplete, runEngine } = require('./schedule');

const FORMATS = ['single_elimination', 'round_robin'];
const MAX_PLAYERS = 128;
// How long an unpaid registration holds a seat before it can be released.
const SEAT_HOLD_MINUTES = 15;
// Firestore allows at most 500 writes per batch.
const BATCH_LIMIT = 450;

function createApp({ db, auth }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const v1 = express.Router();
  v1.use(requireUser(auth));

  // -------------------------------------------------------------------------
  // POST /v1/tournaments  (administrator) - create and publish an event
  // -------------------------------------------------------------------------
  v1.post('/tournaments', requireAdmin, async (req, res, next) => {
    try {
      const input = validateTournament(req.body);
      const ref = db.collection('tournaments').doc();
      await ref.set({
        ...input,
        adminId: req.user.uid,
        status: 'open',
        registeredCount: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.status(201).json({ id: ref.id });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/tournaments  (player) - list published events, soonest first
  // -------------------------------------------------------------------------
  v1.get('/tournaments', async (req, res, next) => {
    try {
      const snap = await db.collection('tournaments').get();
      const tournaments = snap.docs
        .map((d) => publicTournament(d.id, d.data()))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      res.json({ tournaments });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/registrations  (player) - hold a roster seat
  //
  // The registration document ID is `${tournamentId}_${uid}`, so a second
  // attempt by the same player finds the existing document and fails with
  // 409 instead of creating a duplicate. The capacity check, the seat count
  // and the new document are written in one transaction, so two players
  // cannot both take the last seat.
  //
  // Payment is not connected yet: the registration is created in the
  // 'pending_payment' state and will be confirmed by the Stripe webhook.
  // -------------------------------------------------------------------------
  v1.post('/registrations', async (req, res, next) => {
    try {
      const { tournamentId } = req.body || {};
      if (typeof tournamentId !== 'string' || !tournamentId) {
        throw badRequest('tournamentId is required');
      }
      const uid = req.user.uid;
      const tRef = db.collection('tournaments').doc(tournamentId);
      const rRef = db.collection('registrations').doc(`${tournamentId}_${uid}`);
      const pRef = db.collection('players').doc(uid);

      await db.runTransaction(async (tx) => {
        const [tSnap, rSnap, pSnap] = await Promise.all([tx.get(tRef), tx.get(rRef), tx.get(pRef)]);
        if (!tSnap.exists) throw notFound('Tournament not found');
        const t = tSnap.data();
        if (rSnap.exists) throw conflict('You are already registered for this tournament');
        if (t.status !== 'open') throw conflict('Registration is closed for this tournament');
        if (Date.now() > Date.parse(t.registrationDeadline)) {
          throw conflict('The registration deadline has passed');
        }
        if (t.registeredCount >= t.capacity) throw conflict('This tournament is full');

        const now = Timestamp.now();
        tx.create(rRef, {
          playerId: uid,
          tournamentId,
          paymentStatus: 'pending_payment',
          paymentReference: null,
          createdAt: now,
          holdExpiresAt: Timestamp.fromMillis(now.toMillis() + SEAT_HOLD_MINUTES * 60000),
        });
        tx.update(tRef, { registeredCount: FieldValue.increment(1) });
        if (!pSnap.exists) {
          tx.create(pRef, {
            name: req.user.name,
            email: req.user.email,
            authUid: uid,
            handicap: null,
            createdAt: now,
          });
        }
      });

      res.status(201).json({ registrationId: rRef.id, paymentStatus: 'pending_payment' });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/tournaments/:id/close  (administrator)
  // Closes the roster and generates the bracket or round-robin schedule.
  // Only paid registrations are seeded, in order of registration time.
  // -------------------------------------------------------------------------
  v1.post('/tournaments/:id/close', requireAdmin, async (req, res, next) => {
    try {
      const tRef = db.collection('tournaments').doc(req.params.id);

      // Step 1: move open -> closing in a transaction so that two
      // simultaneous requests cannot both generate a schedule.
      const t = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tRef);
        if (!snap.exists) throw notFound('Tournament not found');
        const data = snap.data();
        if (data.status !== 'open') throw conflict(`Tournament is ${data.status}, not open`);
        tx.update(tRef, { status: 'closing' });
        return data;
      });

      try {
        const regs = await db.collection('registrations').where('tournamentId', '==', req.params.id).get();
        const seedOrder = regs.docs
          .map((d) => d.data())
          .filter((r) => r.paymentStatus === 'paid')
          .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
          .map((r) => r.playerId);
        if (seedOrder.length < 2) throw conflict('At least two paid players are needed to close the roster');

        const schedule = runEngine(() =>
          engine.generateSchedule(t.format, seedOrder, { lowScoreWins: t.lowScoreWins })
        );

        // Step 2: write every match (in chunks), then mark the event started.
        await writeInChunks(db, schedule.matches, (batch, m) =>
          batch.set(tRef.collection('matches').doc(m.id), m)
        );
        await tRef.update({ ...scheduleMetadata(schedule, seedOrder), status: 'in_progress' });
        res.json({ status: 'in_progress', players: seedOrder.length, matches: schedule.matches.length });
      } catch (err) {
        // Put the tournament back to open so the administrator can retry.
        await tRef.update({ status: 'open' });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/tournaments/:id/matches/:matchId/result  (administrator)
  // Records or corrects a score and advances the bracket. Match IDs are only
  // unique within a tournament, so the route includes the tournament ID
  // (a refinement of the /matches/{id}/result path in the design table).
  // -------------------------------------------------------------------------
  v1.post('/tournaments/:id/matches/:matchId/result', requireAdmin, async (req, res, next) => {
    try {
      const { score1, score2 } = req.body || {};
      if (!Number.isFinite(score1) || !Number.isFinite(score2)) {
        throw badRequest('score1 and score2 must be numbers');
      }
      const result = await updateSchedule(db, req.params.id, (schedule) => {
        if (!schedule.matches.some((m) => m.id === req.params.matchId)) {
          throw notFound('Match not found');
        }
        return schedule.format === 'single_elimination'
          ? engine.recordResult(schedule, req.params.matchId, score1, score2)
          : engine.recordRoundRobinResult(schedule, req.params.matchId, score1, score2);
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/tournaments/:id/swap  (administrator) - bracket editing
  // Swaps two players between unplayed first-round elimination matches.
  // -------------------------------------------------------------------------
  v1.post('/tournaments/:id/swap', requireAdmin, async (req, res, next) => {
    try {
      const { playerA, playerB } = req.body || {};
      if (typeof playerA !== 'string' || typeof playerB !== 'string') {
        throw badRequest('playerA and playerB are required');
      }
      const result = await updateSchedule(db, req.params.id, (schedule) => {
        if (schedule.format !== 'single_elimination') {
          throw conflict('Swaps apply to elimination brackets only');
        }
        return engine.swapPlayers(schedule, playerA, playerB);
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/tournaments/:id/leaderboard  (player) - current standings
  // -------------------------------------------------------------------------
  v1.get('/tournaments/:id/leaderboard', async (req, res, next) => {
    try {
      const tRef = db.collection('tournaments').doc(req.params.id);
      const [tSnap, mSnap] = await Promise.all([tRef.get(), tRef.collection('matches').get()]);
      if (!tSnap.exists) throw notFound('Tournament not found');
      const t = tSnap.data();
      if (!t.seedOrder) {
        return res.json({ status: t.status, message: 'The bracket has not been generated yet' });
      }
      const schedule = toEngineSchedule(t, mSnap.docs.map((d) => d.data()));
      if (t.format === 'round_robin') {
        return res.json({
          status: t.status,
          format: t.format,
          standings: engine.computeStandings(schedule, t.seedOrder),
        });
      }
      res.json({ status: t.status, format: t.format, championId: t.championId ?? null, matches: schedule.matches });
    } catch (err) {
      next(err);
    }
  });

  app.use('/v1', v1);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loads a tournament's schedule inside a transaction, applies an engine
 * change, and writes back only the matches that changed. Running it as a
 * transaction means two administrators entering scores at the same moment
 * cannot overwrite each other's bracket updates.
 */
async function updateSchedule(db, tournamentId, change) {
  const tRef = db.collection('tournaments').doc(tournamentId);
  return db.runTransaction(async (tx) => {
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw notFound('Tournament not found');
    const t = tSnap.data();
    if (t.status !== 'in_progress') throw conflict(`Tournament is ${t.status}`);
    const mSnap = await tx.get(tRef.collection('matches'));
    const before = toEngineSchedule(t, mSnap.docs.map((d) => d.data()));
    const after = runEngine(() => change(before));

    const changed = changedMatches(before, after);
    for (const m of changed) tx.set(tRef.collection('matches').doc(m.id), m);
    const complete = isComplete(after);
    tx.update(tRef, {
      championId: after.championId ?? null,
      status: complete ? 'completed' : 'in_progress',
    });
    return { updatedMatches: changed.map((m) => m.id), status: complete ? 'completed' : 'in_progress', championId: after.championId ?? null };
  });
}

async function writeInChunks(db, items, apply) {
  for (let i = 0; i < items.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const item of items.slice(i, i + BATCH_LIMIT)) apply(batch, item);
    await batch.commit();
  }
}

/** Validates and normalizes the body of a create-tournament request. */
function validateTournament(body) {
  const b = body || {};
  const errors = [];
  if (typeof b.name !== 'string' || !b.name.trim()) errors.push('name is required');
  if (!FORMATS.includes(b.format)) errors.push(`format must be one of ${FORMATS.join(', ')}`);
  if (typeof b.date !== 'string' || Number.isNaN(Date.parse(b.date))) errors.push('date must be an ISO date');
  if (typeof b.registrationDeadline !== 'string' || Number.isNaN(Date.parse(b.registrationDeadline))) {
    errors.push('registrationDeadline must be an ISO date-time');
  }
  if (!Number.isInteger(b.capacity) || b.capacity < 2 || b.capacity > MAX_PLAYERS) {
    errors.push(`capacity must be a whole number from 2 to ${MAX_PLAYERS}`);
  }
  // Entry fees are stored in cents, as Stripe expects minor currency units.
  if (!Number.isInteger(b.entryFeeCents) || b.entryFeeCents < 0) {
    errors.push('entryFeeCents must be a whole number of cents, 0 or more');
  }
  if (b.lowScoreWins !== undefined && typeof b.lowScoreWins !== 'boolean') {
    errors.push('lowScoreWins must be true or false');
  }
  if (errors.length) throw badRequest(errors.join('; '));
  return {
    name: b.name.trim(),
    format: b.format,
    date: b.date,
    registrationDeadline: b.registrationDeadline,
    capacity: b.capacity,
    entryFeeCents: b.entryFeeCents,
    lowScoreWins: b.lowScoreWins !== false,
    venue: typeof b.venue === 'string' ? b.venue.trim() : null,
  };
}

/** Fields a player is allowed to see in the tournament list. */
function publicTournament(id, t) {
  return {
    id,
    name: t.name,
    format: t.format,
    date: t.date,
    venue: t.venue ?? null,
    registrationDeadline: t.registrationDeadline,
    capacity: t.capacity,
    registeredCount: t.registeredCount,
    entryFeeCents: t.entryFeeCents,
    status: t.status,
  };
}

module.exports = { createApp };
