// Controller: tournament catalog. Lists events and starts registration.
import { api } from '../models/api.js';
import { esc, money, formatName, dateText, dateTimeText, statusBadge, toast } from '../views/format.js';
import { startRegistration } from './registrationController.js';

export async function showCatalog(root) {
  root.innerHTML = '<h2>Tournaments</h2><div class="cards" id="catalog">Loading…</div>';
  try {
    const { tournaments } = await api.listTournaments();
    const el = document.getElementById('catalog');
    if (!tournaments.length) {
      el.innerHTML = '<p class="muted">No tournaments yet.</p>';
      return;
    }
    el.innerHTML = tournaments.map(card).join('');
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-register]');
      if (btn) startRegistration(tournaments.find((t) => t.id === btn.dataset.register));
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function card(t) {
  const seatsLeft = t.capacity - t.registeredCount;
  const canRegister = t.status === 'open' && seatsLeft > 0 && Date.now() < Date.parse(t.registrationDeadline);
  return `<article class="card">
    <header><h3>${esc(t.name)}</h3>${statusBadge(t.status)}</header>
    <dl>
      <dt>Date</dt><dd>${dateText(t.date)}${t.venue ? ` · ${esc(t.venue)}` : ''}</dd>
      <dt>Format</dt><dd>${formatName[t.format]}</dd>
      <dt>Entry</dt><dd>${money(t.entryFeeCents)}</dd>
      <dt>Seats</dt><dd>${t.registeredCount} / ${t.capacity}</dd>
      <dt>Deadline</dt><dd>${dateTimeText(t.registrationDeadline)}</dd>
    </dl>
    <footer>
      ${canRegister ? `<button data-register="${esc(t.id)}">Register${t.entryFeeCents ? ' & pay' : ''}</button>` : ''}
      ${t.status !== 'open' ? `<a class="button secondary" href="#/event/${esc(t.id)}">View bracket</a>` : ''}
    </footer>
  </article>`;
}
