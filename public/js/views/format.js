// View helpers shared by every screen.

/** Escapes text before it is inserted into HTML (prevents script injection). */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const money = (cents) => (cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}`);
export const formatName = { single_elimination: 'Single elimination', round_robin: 'Round robin' };
// A date-only string such as "2026-10-23" is a calendar day, not a moment in
// time. new Date("2026-10-23") would read it as midnight UTC, which displays
// as the previous day anywhere west of UTC, so it is shown in UTC instead.
export const dateText = (iso) => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso));
  return new Date(dateOnly ? `${iso}T12:00:00Z` : iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
};
export const dateTimeText = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const statusLabels = {
  open: 'Registration open', closing: 'Closing', in_progress: 'In progress', completed: 'Completed',
  pending_payment: 'Payment pending', paid: 'Confirmed', withdrawing: 'Refund in progress',
  refunded: 'Refunded', released: 'Hold expired', withdrawn: 'Withdrawn', refund_due: 'Refund in progress',
};
export const statusBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(statusLabels[s] || s)}</span>`;

/** Shows a short message in the page's status bar. */
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast toast-${kind} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 5000);
}
