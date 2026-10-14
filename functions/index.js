'use strict';

/**
 * Cloud Functions entry point. The whole REST interface is served by one
 * HTTPS function named "api"; Firebase Hosting rewrites /api/** to it.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const express = require('express');
const { createApp } = require('./src/app');

initializeApp();

// Mount the v1 app under /api so the same paths work through the Hosting
// rewrite (/api/v1/...) and when calling the function URL directly.
const server = express();
server.use('/api', createApp({ db: getFirestore(), auth: getAuth() }));

exports.api = onRequest(server);
