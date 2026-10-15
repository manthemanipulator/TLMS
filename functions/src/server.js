'use strict';

/**
 * Builds the HTTP server that Cloud Functions runs. The app is mounted twice:
 *   /api/v1/...  reached through the Firebase Hosting rewrite (the website)
 *   /v1/...      reached by calling the function URL directly (Stripe webhooks)
 * These are two separate mounts on purpose: Express 5 does not match '/'
 * inside an array mount, which once made the webhook path return 404.
 * Kept separate from index.js so the routing can be tested.
 */
const express = require('express');
const { createApp } = require('./app');

function createServer(deps) {
  const app = createApp(deps);
  const server = express();
  server.use('/api', app);
  server.use(app);
  return server;
}

module.exports = { createServer };
