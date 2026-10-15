'use strict';

// Unit tests for the email adapter. A fake fetch records the request so no
// email is sent and no network is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendMailer, createLogMailer, RESEND_URL } = require('../../src/adapters/emailAdapter');

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 300, status, json: async () => ({ id: 'email_1' }), text: async () => 'bad request' };
  };
  fn.calls = calls;
  return fn;
}

test('sends through the Resend API with the key, sender and idempotency key', async () => {
  const fetchImpl = fakeFetch();
  const mailer = createResendMailer({ apiKey: 're_test', from: 'TLMS <onboarding@resend.dev>', fetchImpl });
  await mailer.send({ to: 'p@x.test', subject: 'Hi', text: 'Body', idempotencyKey: 'receipt-r1-1' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, RESEND_URL);
  assert.equal(call.init.headers.Authorization, 'Bearer re_test');
  assert.equal(call.init.headers['Idempotency-Key'], 'receipt-r1-1');
  assert.deepEqual(call.body.to, ['p@x.test']);
  assert.equal(call.body.from, 'TLMS <onboarding@resend.dev>');
});

test('redirect mode sends to the test address and names the real recipient', async () => {
  const fetchImpl = fakeFetch();
  const mailer = createResendMailer({ apiKey: 're_test', from: 'x', redirectTo: 'sam@test.example', fetchImpl });
  await mailer.send({ to: 'player@venue.test', subject: 'Receipt', text: 'b' });
  assert.deepEqual(fetchImpl.calls[0].body.to, ['sam@test.example']);
  assert.equal(fetchImpl.calls[0].body.subject, '[to player@venue.test] Receipt');
});

test('provider errors are raised so the caller can log them', async () => {
  const mailer = createResendMailer({ apiKey: 're_test', from: 'x', fetchImpl: fakeFetch(422) });
  await assert.rejects(mailer.send({ to: 'a@b.test', subject: 's', text: 't' }), /422/);
});

test('without an API key, the log mailer records instead of sending', async () => {
  const lines = [];
  await createLogMailer((l) => lines.push(l)).send({ to: 'a@b.test', subject: 'Receipt' });
  assert.match(lines[0], /not sent.*a@b\.test.*Receipt/);
});
