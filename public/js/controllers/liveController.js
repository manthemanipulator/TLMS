// Controller: live view. Shows a tournament's bracket or standings and keeps
// it current by listening to the match documents in Firestore, so scores
// appear for everyone as soon as an administrator records them.
import { collection, doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { api } from '../models/api.js';
import { db } from '../models/firebase.js';
import { esc, statusBadge, formatName, toast } from '../views/format.js';
import { renderBracket, renderStandings } from '../views/bracketView.js';

/**
 * Renders the live bracket into `container`. Returns an unsubscribe function.
 * `admin` adds score entry; `onRefresh` lets the admin screen re-fetch.
 */
export async function mountLiveBracket(container, tournamentId, { admin = false } = {}) {
  let board;
  try {
    board = await api.leaderboard(tournamentId);
  } catch (err) {
    container.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return () => {};
  }
  if (!board.matches) {
    container.innerHTML = `<p class="muted">${esc(board.message || 'The bracket has not been generated yet.')}</p>`;
    return () => {};
  }

  // Standings depend on every result, so for round robin the summary is
  // re-fetched from the API when matches change; brackets render directly.
  const draw = async (matches) => {
    if (board.format === 'round_robin') {
      board = await api.leaderboard(tournamentId);
      container.innerHTML = renderStandings(board, { admin });
    } else {
      container.innerHTML = renderBracket({ ...board, matches }, { admin });
    }
  };

  const unsubMatches = onSnapshot(collection(db, 'tournaments', tournamentId, 'matches'), (snap) => {
    const matches = snap.docs.map((d) => d.data()).sort((a, b) => a.round - b.round || a.index - b.index);
    draw(matches).catch((err) => toast(err.message, 'error'));
  });
  const unsubTournament = onSnapshot(doc(db, 'tournaments', tournamentId), (snap) => {
    board.championId = snap.data()?.championId ?? null;
  });
  return () => {
    unsubMatches();
    unsubTournament();
  };
}

export async function showEvent(root, tournamentId) {
  const { tournaments } = await api.listTournaments();
  const t = tournaments.find((x) => x.id === tournamentId);
  if (!t) {
    root.innerHTML = '<p class="error">Tournament not found.</p>';
    return () => {};
  }
  root.innerHTML = `<p><a href="#/events">← All tournaments</a></p>
    <h2>${esc(t.name)} ${statusBadge(t.status)}</h2>
    <p class="muted">${formatName[t.format]} · ${t.registeredCount} players</p>
    <div id="live"></div>`;
  return mountLiveBracket(document.getElementById('live'), tournamentId);
}
