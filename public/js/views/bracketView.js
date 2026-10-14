// View: renders a single-elimination bracket or round-robin standings.
import { esc } from './format.js';

const name = (players, uid) => (uid ? esc(players[uid] || 'Player') : '<span class="muted">TBD</span>');
const score = (v) => (v === null || v === undefined ? '' : esc(v));

/** Bracket as columns, one per round. `admin` adds score entry controls. */
export function renderBracket({ matches, players, championId }, { admin = false } = {}) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const last = rounds[rounds.length - 1];
  const title = (r) => (r === last ? 'Final' : r === last - 1 ? 'Semifinals' : `Round ${r}`);
  const columns = rounds.map((r) => {
    const cards = matches.filter((m) => m.round === r).map((m) => matchCard(m, players, admin)).join('');
    return `<div class="round"><h4>${title(r)}</h4>${cards}</div>`;
  });
  const champ = championId ? `<p class="champion">Champion: <strong>${name(players, championId)}</strong></p>` : '';
  return `${champ}<div class="bracket">${columns.join('')}</div>`;
}

function matchCard(m, players, admin) {
  if (m.status === 'bye') {
    return `<div class="match bye"><div class="slot winner">${name(players, m.winnerId)}</div><div class="slot muted">Bye</div></div>`;
  }
  const row = (uid, s) => `<div class="slot ${m.winnerId && m.winnerId === uid ? 'winner' : ''}">
      <span>${name(players, uid)}</span><span class="score">${score(s)}</span></div>`;
  const entry = admin && m.player1Id && m.player2Id ? scoreForm(m) : '';
  return `<div class="match" data-match="${esc(m.id)}">${row(m.player1Id, m.score1)}${row(m.player2Id, m.score2)}${entry}</div>`;
}

function scoreForm(m) {
  return `<form class="score-form" data-match="${esc(m.id)}">
      <input name="score1" type="number" step="1" required aria-label="Score 1" value="${score(m.score1)}">
      <input name="score2" type="number" step="1" required aria-label="Score 2" value="${score(m.score2)}">
      <button type="submit" class="small">${m.status === 'completed' ? 'Correct' : 'Save'}</button>
    </form>`;
}

/** Round-robin standings table plus the match list. */
export function renderStandings({ standings, matches, players }, { admin = false } = {}) {
  const rows = standings.map((r) => `<tr><td>${r.rank}</td><td>${name(players, r.playerId)}</td>
      <td>${r.played}</td><td>${r.wins}</td><td>${r.ties}</td><td>${r.losses}</td><td>${r.points}</td>
      <td>${r.differential > 0 ? '+' : ''}${r.differential}</td></tr>`).join('');
  const table = `<table class="standings"><thead><tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>T</th><th>L</th><th>Pts</th><th>Diff</th></tr></thead><tbody>${rows}</tbody></table>`;
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const list = rounds.map((r) => `<div class="round"><h4>Round ${r}</h4>${matches.filter((m) => m.round === r).map((m) => matchCard(m, players, admin)).join('')}</div>`).join('');
  return `${table}<div class="bracket rr">${list}</div>`;
}
