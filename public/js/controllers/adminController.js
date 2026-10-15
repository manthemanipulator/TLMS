// Controller: administration. Creating events, reviewing registrations,
// closing rosters, entering scores, swapping first-round players, and
// running payment reconciliation. Only shown to accounts with the admin
// claim, and every action is re-checked by the API.
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { api } from '../models/api.js';
import { db } from '../models/firebase.js';
import { esc, money, formatName, dateText, statusBadge, toast } from '../views/format.js';
import { mountLiveBracket } from './liveController.js';

export async function showAdmin(root) {
  root.innerHTML = `<h2>Administration</h2>
    <section class="panel">
      <h3>Create a tournament</h3>
      <form id="create-form" class="grid-form">
        <label>Name <input name="name" required maxlength="80"></label>
        <label>Venue <input name="venue" maxlength="80"></label>
        <label>Format <select name="format"><option value="single_elimination">Single elimination</option><option value="round_robin">Round robin</option></select></label>
        <label>Date <input name="date" type="date" required></label>
        <label>Registration deadline <input name="registrationDeadline" type="datetime-local" required></label>
        <label>Capacity <input name="capacity" type="number" min="2" max="128" value="16" required></label>
        <label>Entry fee (USD) <input name="entryFee" type="number" min="0" step="0.01" value="15.00" required></label>
        <label>Scoring <select name="lowScoreWins"><option value="true">Low score wins (golf)</option><option value="false">High score wins</option></select></label>
        <button type="submit">Create tournament</button>
      </form>
    </section>
    <section class="panel">
      <h3>Tournaments</h3>
      <div id="admin-list">Loading…</div>
    </section>
    <section class="panel">
      <h3>Scheduled jobs</h3>
      <p class="muted">These run automatically in production. The local emulator does not run schedules, so they can be started here.</p>
      <p><strong>Payment reconciliation</strong> (every 5 minutes): settles registrations whose 15-minute hold expired, using Stripe's record of each payment.</p>
      <button id="reconcile" class="secondary">Run reconciliation now</button>
      <p><strong>Match reminders</strong> (hourly): emails both players in each ready match for events today or tomorrow. Each reminder is sent once.</p>
      <button id="reminders" class="secondary">Send match reminders now</button>
      <pre id="reconcile-out" class="muted"></pre>
    </section>`;

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api.createTournament({
        name: f.name,
        venue: f.venue,
        format: f.format,
        date: f.date,
        registrationDeadline: new Date(f.registrationDeadline).toISOString(),
        capacity: Number(f.capacity),
        entryFeeCents: Math.round(Number(f.entryFee) * 100),
        lowScoreWins: f.lowScoreWins === 'true',
      });
      toast('Tournament created.', 'success');
      e.target.reset();
      loadList();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('reconcile').addEventListener('click', async () => {
    try {
      document.getElementById('reconcile-out').textContent = JSON.stringify(await api.reconcile(), null, 2);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('reminders').addEventListener('click', async () => {
    try {
      const r = await api.sendReminders();
      document.getElementById('reconcile-out').textContent = JSON.stringify(r, null, 2);
      toast(`Reminders sent: ${r.sent}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function loadList() {
    const { tournaments } = await api.listTournaments();
    document.getElementById('admin-list').innerHTML = `<table><thead><tr><th>Tournament</th><th>Date</th><th>Format</th><th>Entry</th><th>Seats</th><th>Status</th><th></th></tr></thead><tbody>${tournaments
      .map((t) => `<tr><td>${esc(t.name)}</td><td>${dateText(t.date)}</td><td>${formatName[t.format]}</td><td>${money(t.entryFeeCents)}</td>
        <td>${t.registeredCount}/${t.capacity}</td><td>${statusBadge(t.status)}</td>
        <td><a class="button small" href="#/admin/${esc(t.id)}">Manage</a></td></tr>`)
      .join('')}</tbody></table>`;
  }
  loadList().catch((err) => toast(err.message, 'error'));
  return () => {};
}

export async function showAdminEvent(root, tournamentId) {
  const { tournaments } = await api.listTournaments();
  const t = tournaments.find((x) => x.id === tournamentId);
  if (!t) {
    root.innerHTML = '<p class="error">Tournament not found.</p>';
    return () => {};
  }
  root.innerHTML = `<p><a href="#/admin">← Administration</a></p>
    <h2>${esc(t.name)} ${statusBadge(t.status)}</h2>
    <section class="panel">
      <h3>Registrations</h3>
      <div id="reg-table">Loading…</div>
      ${t.status === 'open' ? '<button id="close-roster">Close roster and generate bracket</button>' : ''}
    </section>
    ${t.status !== 'open' && t.format === 'single_elimination' ? `<section class="panel">
      <h3>Edit bracket</h3>
      <p class="muted">Swap two players between first-round matches that have not been played.</p>
      <form id="swap-form" class="inline-form"><select name="a" required></select><select name="b" required></select><button type="submit" class="secondary">Swap</button></form>
    </section>` : ''}
    <section class="panel"><h3>Bracket</h3><div id="admin-bracket"></div></section>`;

  const cleanups = [];

  // Live registration list (admins can read all registrations).
  const regQuery = query(collection(db, 'registrations'), where('tournamentId', '==', tournamentId));
  let board = null;
  cleanups.push(onSnapshot(regQuery, async (snap) => {
    const el = document.getElementById('reg-table');
    if (!el) return;
    if (snap.empty) {
      el.innerHTML = '<p class="muted">No registrations yet.</p>';
      return;
    }
    const regs = snap.docs.map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
    el.innerHTML = `<table><thead><tr><th>#</th><th>Player</th><th>Registered</th><th>Payment</th></tr></thead><tbody>${regs
      .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(board?.players?.[r.playerId] || r.playerId.slice(0, 8))}</td>
        <td>${r.createdAt.toDate().toLocaleString()}</td><td>${statusBadge(r.paymentStatus)}</td></tr>`)
      .join('')}</tbody></table>`;
  }));

  document.getElementById('close-roster')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.closeRoster(tournamentId);
      toast(`Roster closed: ${r.players} players, ${r.matches} matches.`, 'success');
      showAdminEvent(root, tournamentId); // re-render in its new state
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  });

  if (t.status !== 'open') {
    board = await api.leaderboard(tournamentId).catch(() => null);
    const bracketEl = document.getElementById('admin-bracket');
    cleanups.push(await mountLiveBracket(bracketEl, tournamentId, { admin: true }));

    bracketEl.addEventListener('submit', async (e) => {
      const form = e.target.closest('form.score-form');
      if (!form) return;
      e.preventDefault();
      const { score1, score2 } = Object.fromEntries(new FormData(form));
      try {
        const r = await api.recordResult(tournamentId, form.dataset.match, Number(score1), Number(score2));
        toast(r.status === 'completed' ? 'Final result saved. Tournament complete!' : 'Result saved.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    const swapForm = document.getElementById('swap-form');
    if (swapForm && board) {
      const options = Object.entries(board.players).map(([uid, n]) => `<option value="${esc(uid)}">${esc(n)}</option>`).join('');
      swapForm.a.innerHTML = options;
      swapForm.b.innerHTML = options;
      swapForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.swap(tournamentId, swapForm.a.value, swapForm.b.value);
          toast('Players swapped.', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  } else {
    document.getElementById('admin-bracket').innerHTML = '<p class="muted">The bracket is generated when the roster closes.</p>';
  }
  return () => cleanups.forEach((fn) => fn());
}
