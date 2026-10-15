// Model: REST API client. Attaches the signed-in user's Firebase ID token to
// every request and turns error responses into exceptions with the server's
// message, so controllers can show it directly.
import { auth } from './firebase.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const token = await user.getIdToken();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  listTournaments: () => request('GET', '/tournaments'),
  createTournament: (t) => request('POST', '/tournaments', t),
  register: (tournamentId) => request('POST', '/registrations', { tournamentId }),
  withdraw: (registrationId) => request('POST', `/registrations/${encodeURIComponent(registrationId)}/withdraw`),
  closeRoster: (id) => request('POST', `/tournaments/${id}/close`),
  recordResult: (id, matchId, score1, score2) =>
    request('POST', `/tournaments/${id}/matches/${matchId}/result`, { score1, score2 }),
  swap: (id, playerA, playerB) => request('POST', `/tournaments/${id}/swap`, { playerA, playerB }),
  leaderboard: (id) => request('GET', `/tournaments/${id}/leaderboard`),
  reconcile: () => request('POST', '/admin/reconcile'),
  sendReminders: () => request('POST', '/admin/reminders'),
};
