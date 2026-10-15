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
const { requireUser, requireAdmin, requireScorer } = require('./auth');
const paperGolf = require('./adapters/paperGolfAdapter');
const { createLogMailer } = require('./adapters/emailAdapter');
const { sendRegistrationReceipt, sendRefundConfirmation } = require('./notifications');
const { sendMatchReminders } = require('./reminders');
const { badRequest, notFound, conflict, errorHandler } = require('./errors');
const { engine, toEngineSchedule, scheduleMetadata, changedMatches, isComplete, runEngine } = require('./schedule');
const { forbidden } = require('./errors');
const { confirmPayment, releaseSeat, completeRefund, claimEvent, reconcilePending, SEAT_RELEASED } = require('./payments');

const FORMATS = ['single_elimination', 'round_robin'];
const MAX_PLAYERS = 128;
// How long an unpaid registration holds a seat before it can be released.
const SEAT_HOLD_MINUTES = 15;
// Firestore allows at most 500 writes per batch.
const BATCH_LIMIT = 450;

function createApp({ db, auth, payments, mailer = createLogMailer() }) {
  const app = express();

  // -------------------------------------------------------------------------
  // POST /v1/webhooks/payment  (Stripe, verified by signature)
  //
  // Registered before the JSON parser because signature verification needs
  // the exact raw bytes Stripe sent. Cloud Functions provides req.rawBody;
  // elsewhere (tests) express.raw collects it. No user token is involved:
  // the Stripe-Signature header is what proves the request came from Stripe.
  // -------------------------------------------------------------------------
  app.post('/v1/webhooks/payment', rawBody, async (req, res, next) => {
    try {
      const event = payments.verifyWebhook(req.rawBody, req.get('Stripe-Signature'));
      if (!(await claimEvent(db, event.id, event.type))) {
        return res.json({ received: true, duplicate: true });
      }
      try {
        await handlePaymentEvent(db, payments, event, mailer);
      } catch (err) {
        // Un-claim so Stripe's automatic retry can process it again.
        await db.collection('webhookEvents').doc(event.id).delete();
        throw err;
      }
      res.json({ received: true });
    } catch (err) {
      // Log the reason (never the payload or secret) so failed deliveries
      // can be diagnosed from the server log.
      console.warn(`Webhook rejected: ${err.message}`);
      next(err);
    }
  });

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
  // POST /v1/registrations  (player) - hold a roster seat and start payment
  //
  // The registration document ID is `${tournamentId}_${uid}`, so a second
  // attempt by the same player finds the existing document and fails with
  // 409 instead of creating a duplicate. (A player whose earlier hold was
  // released or refunded may register again.) The capacity check, the seat
  // count and the registration are written in one transaction, so two
  // players cannot both take the last seat.
  //
  // For paid events a Stripe PaymentIntent is created after the transaction
  // and its client secret is returned for the browser's payment form. The
  // seat stays on hold until the signed webhook (or the reconciliation job)
  // confirms the payment. Free events are confirmed immediately.
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

      const { t, attempt, free } = await db.runTransaction(async (tx) => {
        const [tSnap, rSnap, pSnap] = await Promise.all([tx.get(tRef), tx.get(rRef), tx.get(pRef)]);
        if (!tSnap.exists) throw notFound('Tournament not found');
        const tData = tSnap.data();
        const previous = rSnap.exists ? rSnap.data() : null;
        if (previous && !SEAT_RELEASED.includes(previous.paymentStatus)) {
          throw conflict('You are already registered for this tournament');
        }
        if (tData.status !== 'open') throw conflict('Registration is closed for this tournament');
        if (Date.now() > Date.parse(tData.registrationDeadline)) {
          throw conflict('The registration deadline has passed');
        }
        if (tData.registeredCount >= tData.capacity) throw conflict('This tournament is full');

        const isFree = tData.entryFeeCents === 0;
        const nextAttempt = (previous?.attempt || 0) + 1;
        const now = Timestamp.now();
        tx.set(rRef, {
          playerId: uid,
          tournamentId,
          paymentStatus: isFree ? 'paid' : 'pending_payment',
          paymentReference: null,
          attempt: nextAttempt,
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
        return { t: tData, attempt: nextAttempt, free: isFree };
      });

      if (free) {
        await sendRegistrationReceipt(db, mailer, rRef.id);
        return res.status(201).json({ registrationId: rRef.id, paymentStatus: 'paid' });
      }

      let intent;
      try {
        intent = await payments.createPaymentIntent({
          amountCents: t.entryFeeCents,
          registrationId: rRef.id,
          attempt,
          tournamentId,
          playerId: uid,
          description: `Entry fee: ${t.name}`,
        });
      } catch (err) {
        // Stripe was unreachable: give the seat back so the player can retry.
        await releaseSeat(db, rRef.id);
        throw err;
      }
      await rRef.update({ paymentReference: intent.id });
      res.status(201).json({
        registrationId: rRef.id,
        paymentStatus: 'pending_payment',
        clientSecret: intent.client_secret,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/registrations/:id/withdraw  (the registered player, or admin)
  //
  // Allowed until the roster closes. An unpaid hold is released at once. A
  // paid registration moves to 'withdrawing' and a full refund is requested;
  // the charge.refunded webhook then marks it refunded and releases the seat
  // in one transaction. (This also covers the administrator refund endpoint
  // from the design table.)
  // -------------------------------------------------------------------------
  v1.post('/registrations/:id/withdraw', async (req, res, next) => {
    try {
      const rRef = db.collection('registrations').doc(req.params.id);
      const rSnap = await rRef.get();
      if (!rSnap.exists) throw notFound('Registration not found');
      const reg = rSnap.data();
      if (reg.playerId !== req.user.uid && !req.user.admin) throw forbidden();

      const t = (await db.collection('tournaments').doc(reg.tournamentId).get()).data();
      if (t.status !== 'open') throw conflict('Withdrawals close when the roster closes');

      if (reg.paymentStatus === 'pending_payment') {
        if (reg.paymentReference) {
          await payments.cancelPaymentIntent(reg.paymentReference).catch(() => {});
        }
        const status = await releaseSeat(db, rRef.id, 'withdrawn');
        return res.json({ paymentStatus: status });
      }
      if (reg.paymentStatus !== 'paid') {
        throw conflict(`This registration is ${reg.paymentStatus} and cannot be withdrawn`);
      }

      // Mark withdrawing first so a second click cannot request a second
      // refund; the Stripe idempotency key backs that up.
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(rRef);
        if (snap.data().paymentStatus !== 'paid') return false;
        tx.update(rRef, { paymentStatus: 'withdrawing' });
        return true;
      });
      if (!claimed) throw conflict('A withdrawal is already in progress');

      try {
        await payments.refund({ paymentIntentId: reg.paymentReference, registrationId: rRef.id, attempt: reg.attempt || 1 });
      } catch (err) {
        await rRef.update({ paymentStatus: 'paid' });
        throw err;
      }
      res.json({ paymentStatus: 'withdrawing' });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/reminders  (administrator)
  // Sends match reminders now. In production the same job runs every hour
  // as a scheduled function; the emulator does not run schedules, so this
  // endpoint (and `npm run send:reminders`) is how it is triggered locally.
  // -------------------------------------------------------------------------
  v1.post('/admin/reminders', requireAdmin, async (req, res, next) => {
    try {
      res.json(await sendMatchReminders(db, mailer));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/admin/reconcile  (administrator)
  // Runs the pending-payment reconciliation on demand. In production the
  // same job runs every five minutes as a scheduled function; the emulator
  // does not run schedules, so this endpoint is how it is exercised locally.
  // -------------------------------------------------------------------------
  v1.post('/admin/reconcile', requireAdmin, async (req, res, next) => {
    try {
      res.json(await reconcilePending(db, payments, { mailer }));
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
  // POST /v1/tournaments/:id/matches/:matchId/paper-golf
  //   (administrator or scoring-engine service account)
  //
  // Paper Golf integration: each player in a match plays one Paper Golf
  // round, submitted here in the game's own format. The first round is
  // stored; when the opponent's round arrives, the two totals are recorded
  // as the match result (lower wins) and the bracket advances. Storing the
  // round and checking for the opponent's happen in one transaction, so two
  // rounds arriving at once still produce exactly one result.
  // -------------------------------------------------------------------------
  v1.post('/tournaments/:id/matches/:matchId/paper-golf', requireScorer, async (req, res, next) => {
    try {
      const { playerId } = req.body || {};
      if (typeof playerId !== 'string' || !playerId) throw badRequest('playerId is required');
      let round;
      try {
        round = paperGolf.validateRound(req.body.round);
      } catch (err) {
        throw badRequest(`Invalid Paper Golf round: ${err.message}`);
      }

      const tRef = db.collection('tournaments').doc(req.params.id);
      const mRef = tRef.collection('matches').doc(req.params.matchId);
      const roundsRef = tRef.collection('paperGolfRounds');

      const scores = await db.runTransaction(async (tx) => {
        const [tSnap, mSnap] = await Promise.all([tx.get(tRef), tx.get(mRef)]);
        if (!tSnap.exists) throw notFound('Tournament not found');
        if (!mSnap.exists) throw notFound('Match not found');
        if (tSnap.data().status !== 'in_progress') throw conflict(`Tournament is ${tSnap.data().status}`);
        const match = mSnap.data();
        if (match.status !== 'scheduled') throw conflict(`Match is ${match.status}`);
        if (![match.player1Id, match.player2Id].includes(playerId)) {
          throw conflict('That player is not in this match');
        }
        const opponentId = playerId === match.player1Id ? match.player2Id : match.player1Id;
        const [mine, theirs] = await Promise.all([
          tx.get(roundsRef.doc(`${match.id}_${playerId}`)),
          tx.get(roundsRef.doc(`${match.id}_${opponentId}`)),
        ]);
        if (mine.exists) throw conflict('This player has already submitted a round for this match');

        tx.create(roundsRef.doc(`${match.id}_${playerId}`), {
          ...round,
          matchId: match.id,
          playerId,
          submittedBy: req.user.uid,
          submittedAt: FieldValue.serverTimestamp(),
        });
        const rounds = { [playerId]: round };
        if (theirs.exists) rounds[opponentId] = theirs.data();
        return paperGolf.resultFromRounds(match, rounds);
      });

      if (!scores) {
        return res.status(202).json({ outcome: 'waiting_for_opponent' });
      }
      if (scores.score1 === scores.score2) {
        const t = (await tRef.get()).data();
        if (t.format === 'single_elimination') {
          // Elimination needs a winner: leave the match open for an
          // administrator to enter the playoff result.
          return res.json({ outcome: 'tied', message: 'Both rounds tied; enter the playoff result manually', ...scores });
        }
      }
      const result = await updateSchedule(db, req.params.id, (schedule) =>
        schedule.format === 'single_elimination'
          ? engine.recordResult(schedule, req.params.matchId, scores.score1, scores.score2)
          : engine.recordRoundRobinResult(schedule, req.params.matchId, scores.score1, scores.score2)
      );
      res.json({ outcome: 'recorded', ...scores, ...result });
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
      // Player profiles are private in Firestore, so the leaderboard supplies
      // the display names needed to show a bracket (names only, no emails).
      const profiles = await db.getAll(...t.seedOrder.map((uid) => db.collection('players').doc(uid)));
      const players = Object.fromEntries(profiles.map((p) => [p.id, p.exists ? p.data().name : 'Player']));
      if (t.format === 'round_robin') {
        return res.json({
          status: t.status,
          format: t.format,
          players,
          standings: engine.computeStandings(schedule, t.seedOrder),
          matches: schedule.matches,
        });
      }
      res.json({ status: t.status, format: t.format, players, championId: t.championId ?? null, matches: schedule.matches });
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

/** Ensures req.rawBody holds the exact request bytes (see webhook route). */
function rawBody(req, res, next) {
  if (req.rawBody) return next();
  express.raw({ type: '*/*', limit: '1mb' })(req, res, (err) => {
    if (err) return next(err);
    req.rawBody = req.body;
    next();
  });
}

/** Applies a verified Stripe event to the matching registration. */
async function handlePaymentEvent(db, payments, event, mailer) {
  const obj = event.data.object;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const registrationId = obj.metadata?.registrationId;
      if (!registrationId) return;
      const status = await confirmPayment(db, registrationId, obj.id);
      if (status === 'paid') await sendRegistrationReceipt(db, mailer, registrationId);
      if (status === 'refund_due') {
        const reg = (await db.collection('registrations').doc(registrationId).get()).data();
        await payments.refund({ paymentIntentId: obj.id, registrationId, attempt: reg.attempt || 1 });
      }
      return;
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const registrationId = obj.metadata?.registrationId;
      if (registrationId) await releaseSeat(db, registrationId);
      return;
    }
    case 'charge.refunded': {
      // Look the registration up by its PaymentIntent, which every charge
      // created from a PaymentIntent carries.
      const snap = await db.collection('registrations').where('paymentReference', '==', obj.payment_intent).limit(1).get();
      if (!snap.empty) {
        const status = await completeRefund(db, snap.docs[0].id);
        if (status === 'refunded') await sendRefundConfirmation(db, mailer, snap.docs[0].id);
      }
      return;
    }
    default:
      // Other event types are acknowledged and ignored.
  }
}

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
