// Controller: registration and payment.
//
// Registering asks the API to hold a seat. For paid events the API returns a
// Stripe client secret; Stripe's Payment Element collects the card inside a
// Stripe-hosted frame, so card numbers never pass through this app. After
// Stripe accepts the payment, the seat is confirmed by the server's signed
// webhook, not by the browser, and this page waits for that confirmation by
// listening to the player's own registration document.
import { doc, onSnapshot, collection, query, where } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { api } from '../models/api.js';
import { db } from '../models/firebase.js';
import { session } from './authController.js';
import { STRIPE_PUBLISHABLE_KEY } from '../config.js';
import { esc, statusBadge, toast } from '../views/format.js';

let stripe;
function getStripe() {
  if (!stripe) {
    if (!STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_')) {
      throw new Error('Add your Stripe test publishable key (pk_test_...) to public/js/config.js');
    }
    stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
  }
  return stripe;
}

export async function startRegistration(tournament) {
  try {
    const result = await api.register(tournament.id);
    if (result.paymentStatus === 'paid') {
      toast(`You're registered for ${tournament.name}.`, 'success');
      location.hash = '#/my';
      return;
    }
    await openPayment(tournament, result);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openPayment(tournament, { clientSecret, registrationId }) {
  const dialog = document.getElementById('pay-dialog');
  dialog.querySelector('#pay-title').textContent = `Entry fee: ${tournament.name}`;
  const errorEl = dialog.querySelector('#pay-error');
  errorEl.textContent = '';
  const s = getStripe();
  const elements = s.elements({ clientSecret });
  const paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');
  dialog.showModal();

  const form = dialog.querySelector('#pay-form');
  const button = form.querySelector('button[type=submit]');
  const cleanup = () => {
    paymentElement.destroy();
    form.onsubmit = null;
    dialog.close();
  };
  dialog.querySelector('#pay-cancel').onclick = async () => {
    cleanup();
    // Release the held seat right away instead of waiting for the hold to expire.
    await api.withdraw(registrationId).catch(() => {});
    toast('Registration canceled.');
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = 'Processing…';
    const { error } = await s.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: `${location.origin}/#/my` },
    });
    button.disabled = false;
    button.textContent = 'Pay';
    if (error) {
      errorEl.textContent = error.message;
      return;
    }
    cleanup();
    toast('Payment received. Confirming your seat…');
    waitForConfirmation(registrationId, tournament.name);
  };
}

/** Waits up to 30 seconds for the webhook to mark the registration paid. */
function waitForConfirmation(registrationId, name) {
  const unsubscribe = onSnapshot(doc(db, 'registrations', registrationId), (snap) => {
    if (snap.data()?.paymentStatus === 'paid') {
      clearTimeout(timer);
      unsubscribe();
      toast(`Seat confirmed for ${name}.`, 'success');
    }
  });
  const timer = setTimeout(() => {
    unsubscribe();
    toast('Payment is still being confirmed. Your registration will update automatically.', 'info');
  }, 30000);
  location.hash = '#/my';
}

/** "My registrations": a live list of the signed-in player's registrations. */
export function showMyRegistrations(root) {
  root.innerHTML = '<h2>My registrations</h2><div id="my-regs">Loading…</div>';
  const q = query(collection(db, 'registrations'), where('playerId', '==', session.user.uid));
  const unsubscribe = onSnapshot(q, async (snap) => {
    const el = document.getElementById('my-regs');
    if (!el) return unsubscribe();
    if (snap.empty) {
      el.innerHTML = '<p class="muted">You have not registered for anything yet. <a href="#/events">Browse tournaments</a>.</p>';
      return;
    }
    const { tournaments } = await api.listTournaments();
    const byId = Object.fromEntries(tournaments.map((t) => [t.id, t]));
    el.innerHTML = `<table><thead><tr><th>Tournament</th><th>Status</th><th></th></tr></thead><tbody>${snap.docs
      .map((d) => {
        const r = d.data();
        const t = byId[r.tournamentId] || { name: r.tournamentId, status: '' };
        const canWithdraw = t.status === 'open' && ['paid', 'pending_payment'].includes(r.paymentStatus);
        return `<tr><td><a href="#/event/${esc(r.tournamentId)}">${esc(t.name)}</a></td>
          <td>${statusBadge(r.paymentStatus)}</td>
          <td>${canWithdraw ? `<button class="secondary small" data-withdraw="${esc(d.id)}">Withdraw</button>` : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  });
  root.onclick = async (e) => {
    const btn = e.target.closest('button[data-withdraw]');
    if (!btn) return;
    // Two-step confirmation: the first click arms the button.
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to withdraw';
      return;
    }
    btn.disabled = true;
    try {
      const r = await api.withdraw(btn.dataset.withdraw);
      toast(r.paymentStatus === 'withdrawing' ? 'Withdrawn. Your refund is being processed.' : 'Withdrawn.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
  return unsubscribe;
}
