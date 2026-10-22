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
 * Secrets (Stripe keys, Resend key) are declared with defineSecret, so in
 * production they are stored encrypted in Cloud Secret Manager and exposed
 * only to the functions that declare them. Locally, the emulator reads them
 * from functions/.secret.local, which is never deployed or committed.
 * Non-secret settings (EMAIL_REDIRECT_TO, EMAIL_FROM) come from functions/.env.
 *
 * Adapters are created on first use rather than at load time, because
 * secret values are only available while a function is running.
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createServer } = require('./src/server');
const { createStripeAdapter } = require('./src/adapters/stripeAdapter');
const { createResendMailer, createLogMailer } = require('./src/adapters/emailAdapter');
const { reconcilePending } = require('./src/payments');
const { sendMatchReminders } = require('./src/reminders');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

// Least privilege: every function runs as a dedicated service account that
// holds only the roles it needs (Firestore read/write, the three secrets, log
// writing), instead of the default compute account, which has Editor on the
// whole project. The full address is required: the deploy step that grants
// secret access rejects the "name@" shorthand. The emulator ignores this.
setGlobalOptions({ serviceAccount: 'tlms-functions@tlms-venue.iam.gserviceaccount.com' });

initializeApp();
const db = getFirestore();

// Trim secret values: a pasted secret can carry a trailing newline or space,
// which silently breaks Stripe signature checks.
const secret = (param) => (param.value() || '').trim();

let deps;
/** Builds the adapters once per function instance, on first use. */
function getDeps() {
  if (!deps) {
    const resendKey = secret(RESEND_API_KEY);
    deps = {
      db,
      auth: getAuth(),
      payments: createStripeAdapter({
        secretKey: secret(STRIPE_SECRET_KEY),
        webhookSecret: secret(STRIPE_WEBHOOK_SECRET),
      }),
      // Email: Resend when a key is configured, otherwise messages are only
      // logged. EMAIL_REDIRECT_TO (optional) sends every message to one
      // address, for use before a sending domain is verified.
      mailer: resendKey
        ? createResendMailer({
            apiKey: resendKey,
            from: process.env.EMAIL_FROM || 'TLMS <onboarding@resend.dev>',
            redirectTo: process.env.EMAIL_REDIRECT_TO || null,
          })
        : createLogMailer(),
    };
  }
  return deps;
}

let server;
exports.api = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY] },
  (req, res) => {
    server ||= createServer(getDeps());
    return server(req, res);
  }
);

exports.reconcilePayments = onSchedule(
  { schedule: 'every 5 minutes', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY] },
  async () => {
    const { payments, mailer } = getDeps();
    console.log('Reconciliation summary', await reconcilePending(db, payments, { mailer }));
  }
);

exports.matchReminders = onSchedule(
  { schedule: 'every 60 minutes', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY] },
  async () => {
    console.log('Reminder summary', await sendMatchReminders(db, getDeps().mailer));
  }
);
