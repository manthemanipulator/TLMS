'use strict';

/**
 * In-memory stand-in for the Stripe API's network calls, used by the
 * integration tests (the "recorded responses" approach from the risk plan).
 * It honors idempotency keys the way Stripe does: repeating a request with
 * the same key returns the original object instead of creating a new one.
 * Webhook signatures are NOT faked; tests sign events with the real library.
 */
function createFakeStripe() {
  const intents = new Map();
  const byKey = new Map();
  const calls = [];
  let counter = 0;
  let failNext = false;

  const once = (key, make) => {
    if (key && byKey.has(key)) return byKey.get(key);
    const value = make();
    if (key) byKey.set(key, value);
    return value;
  };
  const maybeFail = () => {
    if (failNext) {
      failNext = false;
      throw new Error('simulated Stripe outage');
    }
  };

  return {
    calls,
    intents,
    /** Makes the next API call throw, to simulate Stripe being unreachable. */
    failNextCall() { failNext = true; },
    paymentIntents: {
      async create(params, opts = {}) {
        maybeFail();
        calls.push({ op: 'paymentIntents.create', params, idempotencyKey: opts.idempotencyKey });
        return once(opts.idempotencyKey, () => {
          const id = `pi_test_${++counter}`;
          const intent = { id, client_secret: `${id}_secret`, status: 'requires_payment_method', ...params };
          intents.set(id, intent);
          return intent;
        });
      },
      async retrieve(id) {
        maybeFail();
        calls.push({ op: 'paymentIntents.retrieve', id });
        return intents.get(id);
      },
      async cancel(id) {
        maybeFail();
        calls.push({ op: 'paymentIntents.cancel', id });
        intents.get(id).status = 'canceled';
        return intents.get(id);
      },
    },
    refunds: {
      async create(params, opts = {}) {
        maybeFail();
        calls.push({ op: 'refunds.create', params, idempotencyKey: opts.idempotencyKey });
        return once(opts.idempotencyKey, () => ({ id: `re_test_${++counter}`, ...params, status: 'succeeded' }));
      },
    },
  };
}

module.exports = { createFakeStripe };
