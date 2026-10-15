'use strict';

/**
 * Cloud Functions entry point.
 *
 *   api                 the REST interface (Hosting rewrites /api/** to it)
 *   reconcilePayments   scheduled every 5 minutes: settles registrations whose
 *                       seat hold expired, using Stripe's own payment status
 *   matchReminders      scheduled hourly: emails players about matches today
 *                       or tomorrow (each reminder is sent once)
 *
 * Stripe credentials come from environment variables, which the Firebase
 * CLI loads from functions/.env (excluded from source control). For
 * production these move to Cloud Secret Manager.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createServer } = require('./src/server');
const { createStripeAdapter } = require('./src/adapters/stripeAdapter');
const { reconcilePending } = require('./src/payments');
const { sendMatchReminders } = require('./src/reminders');
const { createResendMailer, createLogMailer } = require('./src/adapters/emailAdapter');

initializeApp();
const db = getFirestore();

const payments = createStripeAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});

// Email: Resend when a key is configured, otherwise messages are only logged.
// EMAIL_REDIRECT_TO (optional) sends every message to one address, for
// testing before a sending domain is verified with the provider.
const mailer = process.env.RESEND_API_KEY
  ? createResendMailer({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM || 'TLMS <onboarding@resend.dev>',
      redirectTo: process.env.EMAIL_REDIRECT_TO || null,
    })
  : createLogMailer();

const server = createServer({ db, auth: getAuth(), payments, mailer });

exports.api = onRequest(server);

exports.reconcilePayments = onSchedule('every 5 minutes', async () => {
  const summary = await reconcilePending(db, payments, { mailer });
  console.log('Reconciliation summary', summary);
});

exports.matchReminders = onSchedule('every 60 minutes', async () => {
  const summary = await sendMatchReminders(db, mailer);
  console.log('Reminder summary', summary);
});
