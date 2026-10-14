// Front-end configuration.
//
// STRIPE_PUBLISHABLE_KEY: the *publishable* test key (pk_test_...) from the
// Stripe Dashboard. Publishable keys are designed to be public and are safe
// in client code; the secret/restricted key stays in functions/.env only.
export const STRIPE_PUBLISHABLE_KEY = 'pk_test_51UQHJG5GTiF1kYZF4nGR1kCaV3UieCqzcB6zslEsrfpWWiuZls2bslZFgmEYA4CKX6Hpc48Zyky0e54aBSArXG7l00ZKaoI7LJ';

// Firebase web config. While developing on the emulators, the demo project
// needs no real API key. Replace with the production project's config at
// deployment.
export const FIREBASE_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-tlms.firebaseapp.com',
  projectId: 'demo-tlms',
};

// Use the local emulators when the page is served from localhost.
export const USE_EMULATORS = ['localhost', '127.0.0.1'].includes(location.hostname);
