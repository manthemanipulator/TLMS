// Model: Firebase initialization. Every other module imports auth and db
// from here so the emulator connection is configured exactly once.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { FIREBASE_CONFIG, USE_EMULATORS } from '../config.js';

const app = initializeApp(FIREBASE_CONFIG);
// initializeAuth (rather than getAuth) leaves out the pop-up/redirect sign-in
// support this site does not use, which otherwise loads Google's sign-in
// iframe and scripts (about 130 KB) on every page load.
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
export const db = getFirestore(app);

if (USE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
