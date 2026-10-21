'use strict';

/**
 * Shared helpers for the release-gate scripts, which run against the
 * DEPLOYED system (https://tlms-venue.web.app). Nothing here is needed by
 * the application itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SITE = 'https://tlms-venue.web.app';
const PROJECT = 'tlms-venue';

/** Reads the public Firebase web API key from the front-end config. */
function apiKey() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/config.js'), 'utf8');
  const block = src.slice(src.indexOf('PRODUCTION_CONFIG'));
  return block.match(/apiKey:\s*'([^']+)'/)[1];
}

/** Prompts for a value without echoing it to the terminal. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

/**
 * Signs in through the Firebase Auth REST API. The web API key is
 * restricted to the site's addresses, so the request carries the site as
 * its Referer, exactly as a browser on the site would.
 */
async function signIn(email, password) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${SITE}/` },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!body.idToken) throw new Error(`Sign-in failed for ${email}: ${body.error?.message || res.status}`);
  return { token: body.idToken, uid: body.localId };
}

function saveResults(name, data) {
  const file = path.join(__dirname, 'results', `${name}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

module.exports = { SITE, PROJECT, apiKey, askHidden, signIn, saveResults };
