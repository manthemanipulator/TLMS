// Application entry point: wires the controllers together and routes between
// screens using the URL hash (#/events, #/my, #/event/:id, #/admin, ...).
import { initAuth, onSessionChange, session } from './controllers/authController.js';
import { showCatalog } from './controllers/catalogController.js';
import { showMyRegistrations } from './controllers/registrationController.js';
import { showEvent } from './controllers/liveController.js';
import { showAdmin, showAdminEvent } from './controllers/adminController.js';
import { toast } from './views/format.js';

const root = document.getElementById('view');
let cleanup = () => {};

async function route() {
  if (!session.user) return;
  cleanup();
  cleanup = () => {};
  root.onclick = null;
  const [, page, id] = (location.hash || '#/events').split('/');

  document.querySelectorAll('nav a[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  try {
    if (page === 'my') cleanup = showMyRegistrations(root) || cleanup;
    else if (page === 'event' && id) cleanup = (await showEvent(root, id)) || cleanup;
    else if (page === 'admin' && session.admin) cleanup = (await (id ? showAdminEvent(root, id) : showAdmin(root))) || cleanup;
    else await showCatalog(root);
  } catch (err) {
    toast(err.message, 'error');
  }
}

window.addEventListener('hashchange', route);
onSessionChange(route);
initAuth();
