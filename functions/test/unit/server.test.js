'use strict';

// Routing test for the Cloud Functions entry point. Guards against the bug
// where the webhook path (/v1/...) returned 404 because of how the app was
// mounted. Uses the real Stripe adapter so an unsigned webhook must reach
// signature verification (400), not fall through to a 404.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../src/server');
const { createStripeAdapter } = require('../../src/adapters/stripeAdapter');

let server;
let base;

test.before(async () => {
  const deps = {
    db: {},
    auth: { verifyIdToken: async () => { throw new Error('invalid'); } },
    payments: createStripeAdapter({ secretKey: 'sk_test_fake', webhookSecret: 'whsec_test', client: {} }),
  };
  await new Promise((resolve) => { server = createServer(deps).listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

for (const prefix of ['/v1', '/api/v1']) {
  test(`webhook route is reachable at ${prefix}/webhooks/payment`, async () => {
    const res = await fetch(`${base}${prefix}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=bad' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /signature/i);
  });

  test(`API routes are reachable at ${prefix} (401 without a token, not 404)`, async () => {
    const res = await fetch(`${base}${prefix}/tournaments`);
    assert.equal(res.status, 401);
  });
}
