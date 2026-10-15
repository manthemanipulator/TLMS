'use strict';

/**
 * Match reminders. For every tournament in progress whose event day is today
 * or tomorrow, each player in a match that is ready to play (both players
 * known, no result yet) gets one reminder email naming their opponent.
 *
 * Each reminder is recorded in the `reminders` collection BEFORE it is sent,
 * using a document ID made from tournament, match and player. Creating that
 * document fails if it already exists, so a reminder can never go out twice,
 * even if the scheduled job runs twice or overlaps a manual run. (The record
 * is server-only: security rules give clients no access to this collection.)
 */
const { FieldValue } = require('firebase-admin/firestore');

const DAY_MS = 86400000;

/** Whole days from today (UTC) until a YYYY-MM-DD event date. */
function daysUntil(isoDate, now) {
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
  return Math.round((Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`) - startOfToday) / DAY_MS);
}

const longDate = (iso) =>
  new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

async function sendMatchReminders(db, mailer, { now = Date.now() } = {}) {
  const summary = { tournaments: 0, sent: 0, alreadySent: 0, failed: 0 };
  const live = await db.collection('tournaments').where('status', '==', 'in_progress').get();

  for (const tDoc of live.docs) {
    const t = tDoc.data();
    const days = daysUntil(t.date, now);
    if (days < 0 || days > 1) continue;
    summary.tournaments++;

    const matches = await tDoc.ref.collection('matches').where('status', '==', 'scheduled').get();
    const playerIds = [...new Set(matches.docs.flatMap((m) => [m.data().player1Id, m.data().player2Id]))];
    if (!playerIds.length) continue;
    const profiles = await db.getAll(...playerIds.map((id) => db.collection('players').doc(id)));
    const people = Object.fromEntries(profiles.map((p) => [p.id, p.exists ? p.data() : {}]));

    for (const mDoc of matches.docs) {
      const m = mDoc.data();
      for (const [me, them] of [[m.player1Id, m.player2Id], [m.player2Id, m.player1Id]]) {
        const ref = db.collection('reminders').doc(`${tDoc.id}_${m.id}_${me}`);
        try {
          await ref.create({ tournamentId: tDoc.id, matchId: m.id, playerId: me, sentAt: FieldValue.serverTimestamp() });
        } catch (err) {
          if (err.code === 6 /* ALREADY_EXISTS */) {
            summary.alreadySent++;
            continue;
          }
          throw err;
        }
        const player = people[me] || {};
        if (!player.email) continue;
        const when = days === 0 ? 'today' : 'tomorrow';
        const lines = [
          `Hi ${player.name || 'there'},`,
          '',
          `Reminder: you play ${people[them]?.name || 'your opponent'} ${when} in ${t.name}.`,
          `Round ${m.round}, ${longDate(t.date)}${t.venue ? ` at ${t.venue}` : ''}.`,
          '',
          'Good luck!',
        ];
        try {
          await mailer.send({
            to: player.email,
            subject: `Match reminder: ${t.name} (${when})`,
            text: lines.join('\n'),
            html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
            idempotencyKey: `reminder-${tDoc.id}-${m.id}-${me}`,
          });
          summary.sent++;
        } catch (err) {
          // Release the claim so the next run retries this reminder.
          await ref.delete();
          summary.failed++;
          console.error(`Reminder failed for ${me} in ${m.id}: ${err.message}`);
        }
      }
    }
  }
  return summary;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { sendMatchReminders, daysUntil };
