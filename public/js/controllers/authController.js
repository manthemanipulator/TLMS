// Controller: authentication. Handles sign-in, account creation and sign-out,
// and tells the rest of the app who is signed in and whether they are an
// administrator (from the custom "admin" claim in the ID token).
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { auth } from '../models/firebase.js';
import { toast } from '../views/format.js';

const listeners = [];
export const session = { user: null, admin: false };

/** Registers a callback that runs whenever the signed-in user changes. */
export function onSessionChange(fn) {
  listeners.push(fn);
}

export function initAuth() {
  const form = document.getElementById('auth-form');
  const nameRow = document.getElementById('name-row');
  let mode = 'signin';

  document.getElementById('toggle-mode').addEventListener('click', (e) => {
    e.preventDefault();
    mode = mode === 'signin' ? 'signup' : 'signin';
    nameRow.hidden = mode === 'signin';
    form.querySelector('button[type=submit]').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    e.target.textContent = mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password, displayName } = Object.fromEntries(new FormData(form));
    try {
      if (mode === 'signup') {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: displayName || email });
        await cred.user.getIdToken(true); // refresh so the token carries the name
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      form.reset();
    } catch (err) {
      toast(friendlyAuthError(err), 'error');
    }
  });

  document.getElementById('sign-out').addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    session.user = user;
    session.admin = user ? (await user.getIdTokenResult()).claims.admin === true : false;
    document.getElementById('auth-screen').hidden = Boolean(user);
    document.getElementById('app-screen').hidden = !user;
    document.getElementById('admin-link').hidden = !session.admin;
    document.getElementById('who').textContent = user ? `${user.displayName || user.email}${session.admin ? ' (admin)' : ''}` : '';
    listeners.forEach((fn) => fn(session));
  });
}

function friendlyAuthError(err) {
  const map = {
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-email': 'Enter a valid email address.',
  };
  return map[err.code] || err.message;
}
