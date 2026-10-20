// Front-end configuration.
//
// STRIPE_PUBLISHABLE_KEY: the *publishable* test key (pk_test_...) from the
// Stripe Dashboard. Publishable keys are designed to be public and are safe
// in client code. The restricted secret key never goes here: it lives in
// functions/.secret.local locally and in Cloud Secret Manager in production.
export const STRIPE_PUBLISHABLE_KEY = 'pk_test_51UQHJG5GTiF1kYZF4nGR1kCaV3UieCqzcB6zslEsrfpWWiuZls2bslZFgmEYA4CKX6Hpc48Zyky0e54aBSArXG7l00ZKaoI7LJ';

// Firebase web configuration. These values identify the project to the
// browser and are public by design; access is controlled by Firebase
// Authentication, the Firestore security rules, and the server's checks.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// Local development uses the emulator-only demo project.
const DEMO_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-tlms.firebaseapp.com',
  projectId: 'demo-tlms',
};

// Production project (Firebase console > Project settings > Your apps).
const PRODUCTION_CONFIG = {
  apiKey: 'AIzaSyDUCWAEHqBxCazAnVA-ZxIwD_0hIM7JiDQ',
  authDomain: 'tlms-venue.firebaseapp.com',
  projectId: 'tlms-venue',
  storageBucket: 'tlms-venue.firebasestorage.app',
  messagingSenderId: '402722188106',
  appId: '1:402722188106:web:f931cb85a89b870cc56fb3',
};

export const FIREBASE_CONFIG = LOCAL ? DEMO_CONFIG : PRODUCTION_CONFIG;

// Use the local emulators when the page is served from localhost.
export const USE_EMULATORS = LOCAL;
