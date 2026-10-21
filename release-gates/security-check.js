'use strict';

/**
 * Release gate: security verification against the DEPLOYED system.
 *
 *   node release-gates/security-check.js
 *
 * Signs in as the demo player and attempts actions the design says must be
 * refused. Every check passes only if the system refuses (or, for the
 * last checks, if no secret is exposed and HTTP is redirected to HTTPS).
 * It never needs administrator credentials and changes no data.
 */
const { SITE, PROJECT, askHidden, signIn, saveResults } = require('./common');

const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const results = [];

async function check(name, expectation, fn) {
  try {
    const { ok, detail } = await fn();
    results.push({ check: name, expected: expectation, passed: ok, detail });
  } catch (err) {
    results.push({ check: name, expected: expectation, passed: false, detail: `error: ${err.message}` });
  }
}

const api = (path, token, init = {}) =>
  fetch(`${SITE}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });

async function main() {
  const password = await askHidden('Password for player@venue.test: ');
  const { token, uid } = await signIn('player@venue.test', password);
  const bearer = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // --- Firestore security rules, called directly as a signed-in player ------
  await check('Player creates a tournament directly in Firestore', 'refused (403)', async () => {
    const r = await fetch(`${FIRESTORE}/tournaments?documentId=security-check`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ fields: { name: { stringValue: 'Forged' } } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player marks their own registration paid directly in Firestore', 'refused (403)', async () => {
    const r = await fetch(`${FIRESTORE}/registrations/fall-classic_${uid}?updateMask.fieldPaths=paymentStatus`, {
      method: 'PATCH', headers: bearer, body: JSON.stringify({ fields: { paymentStatus: { stringValue: 'paid' } } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player lists every registration (other players’ included)', 'refused (403)', async () => {
    const r = await fetch(`${FIRESTORE}:runQuery`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'registrations' }] } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player lists every player profile', 'refused (403)', async () => {
    const r = await fetch(`${FIRESTORE}:runQuery`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'players' }] } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player reads processed webhook records', 'refused (403)', async () => {
    const r = await fetch(`${FIRESTORE}:runQuery`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'webhookEvents' }] } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });

  // --- API authorization ------------------------------------------------------
  await check('API call with no token', 'refused (401)', async () => {
    const r = await api('/tournaments');
    return { ok: r.status === 401, detail: `HTTP ${r.status}` };
  });
  await check('API call with a forged token', 'refused (401)', async () => {
    const r = await api('/tournaments', 'eyJhbGciOiJub25lIn0.eyJhZG1pbiI6dHJ1ZX0.');
    return { ok: r.status === 401, detail: `HTTP ${r.status}` };
  });
  await check('Player creates a tournament through the API', 'refused (403)', async () => {
    const r = await api('/tournaments', token, { method: 'POST', body: JSON.stringify({ name: 'Forged' }) });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player runs payment reconciliation (admin job)', 'refused (403)', async () => {
    const r = await api('/admin/reconcile', token, { method: 'POST' });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });
  await check('Player submits a Paper Golf round (scorer-only)', 'refused (403)', async () => {
    const r = await api('/tournaments/fall-classic/matches/R1-M0/paper-golf', token, {
      method: 'POST', body: JSON.stringify({ playerId: uid, round: { score: 54, holeScores: Array(18).fill(3) } }),
    });
    return { ok: r.status === 403, detail: `HTTP ${r.status}` };
  });

  // --- Webhook integrity -----------------------------------------------------
  await check('Webhook with no Stripe signature', 'refused (400)', async () => {
    const r = await api('/webhooks/payment', null, { method: 'POST', body: JSON.stringify({ type: 'payment_intent.succeeded' }) });
    return { ok: r.status === 400, detail: `HTTP ${r.status}` };
  });
  await check('Webhook with a forged Stripe signature', 'refused (400)', async () => {
    const r = await api('/webhooks/payment', null, {
      method: 'POST',
      headers: { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
      body: JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x', metadata: { registrationId: `fall-classic_${uid}` } } } }),
    });
    return { ok: r.status === 400, detail: `HTTP ${r.status}` };
  });

  // --- Exposure --------------------------------------------------------------
  await check('No secret keys in the files served to browsers', 'none found', async () => {
    const files = ['/', '/js/config.js', '/js/app.js', '/js/models/api.js', '/js/controllers/registrationController.js'];
    const found = [];
    for (const f of files) {
      const text = await (await fetch(`${SITE}${f}`)).text();
      if (/(sk|rk)_(test|live)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{15,}/.test(text)) found.push(f);
    }
    return { ok: found.length === 0, detail: found.length ? `found in ${found.join(', ')}` : `${files.length} files scanned` };
  });
  await check('Plain HTTP is redirected to HTTPS', 'redirect to https', async () => {
    const r = await fetch(SITE.replace('https:', 'http:') + '/', { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    return { ok: r.status >= 300 && r.status < 400 && loc.startsWith('https://'), detail: `HTTP ${r.status} -> ${loc}` };
  });

  const passed = results.filter((r) => r.passed).length;
  console.log('');
  for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.check}  [expected ${r.expected}; got ${r.detail}]`);
  console.log(`\n${passed} of ${results.length} security checks passed.`);
  const file = saveResults('security-check', { site: SITE, runAt: new Date().toISOString(), passed, total: results.length, results });
  console.log(`Results saved to ${file}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
