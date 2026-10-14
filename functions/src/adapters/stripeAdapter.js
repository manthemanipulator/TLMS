'use strict';

/**
 * Stripe adapter. This is the only module that talks to Stripe, so a change
 * of payment provider (or a Stripe API change) is absorbed here without
 * touching the registration logic.
 *
 * Every request that moves money carries an idempotency key derived from the
 * registration ID and attempt number, so a retried request (for example after
 * a network timeout) can never create a second charge or a second refund,
 * while a player who re-registers after a released hold gets a fresh payment.
 *
 * The `client` parameter exists for testing: tests pass a fake client for
 * the network calls, while webhook signature verification always uses the
 * real Stripe library (it is pure cryptography and needs no network).
 */
const Stripe = require('stripe');
const { HttpError } = require('../errors');

function createStripeAdapter({ secretKey, webhookSecret, client }) {
  const stripe = new Stripe(secretKey || 'sk_test_unset');
  const api = client || stripe;

  /** Wraps provider failures as 502 Bad Gateway, per the interface contract. */
  async function call(fn) {
    try {
      return await fn();
    } catch (err) {
      throw new HttpError(502, `Payment provider error: ${err.message}`);
    }
  }

  return {
    /** Creates a PaymentIntent for an entry fee (amount in cents). */
    createPaymentIntent({ amountCents, currency = 'usd', registrationId, attempt = 1, tournamentId, playerId, description }) {
      return call(() =>
        api.paymentIntents.create(
          {
            amount: amountCents,
            currency,
            description,
            automatic_payment_methods: { enabled: true },
            metadata: { registrationId, tournamentId, playerId },
          },
          { idempotencyKey: `pi-${registrationId}-${attempt}` }
        )
      );
    },

    retrievePaymentIntent(id) {
      return call(() => api.paymentIntents.retrieve(id));
    },

    cancelPaymentIntent(id) {
      return call(() => api.paymentIntents.cancel(id));
    },

    /** Refunds a PaymentIntent in full. */
    refund({ paymentIntentId, registrationId, attempt = 1 }) {
      return call(() =>
        api.refunds.create(
          { payment_intent: paymentIntentId, metadata: { registrationId } },
          { idempotencyKey: `refund-${registrationId}-${attempt}` }
        )
      );
    },

    /**
     * Verifies a webhook's Stripe-Signature header against the signing secret
     * and returns the parsed event. Throws 400 if the signature is missing or
     * wrong, so forged requests can never confirm a registration.
     */
    verifyWebhook(rawBody, signature) {
      try {
        return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err) {
        throw new HttpError(400, `Webhook signature verification failed: ${err.message}`);
      }
    },
  };
}

module.exports = { createStripeAdapter };
