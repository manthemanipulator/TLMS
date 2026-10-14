'use strict';

/**
 * Cloud Functions entry point.
 *
 *   api                 the REST interface (Hosting rewrites /api/** to it)
 *   reconcilePayments   scheduled every 5 minutes: settles registrations whose
 *                       seat hold expired, using Stripe's own payment status
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
const express = require('express');
const { createApp } = require('./src/app');
const { createStripeAdapter } = require('./src/adapters/stripeAdapter');
const { reconcilePending } = require('./src/payments');

initializeApp();
const db = getFirestore();

const payments = createStripeAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});

// Serve the same app at /api/v1/... (through the Hosting rewrite) and at
// /v1/... (when calling the function URL directly, e.g. for Stripe webhooks).
const server = express();
server.use(['/api', '/'], createApp({ db, auth: getAuth(), payments }));

exports.api = onRequest(server);

exports.reconcilePayments = onSchedule('every 5 minutes', async () => {
  const summary = await reconcilePending(db, payments);
  console.log('Reconciliation summary', summary);
});
