import { getSongbooks, createSongbook } from '../storage.js';
import { isConfigured, isSignedIn, signIn, signOut, getLastSyncedAt } from '../drive-sync.js';
import { getLocalImports } from '../catalog.js';
import { syncRoundTrip } from '../app.js';
import { escapeHtml } from '../util.js';

export function render(state, root) {
  const songbooks = getSongbooks();
  root.innerHTML = `
    <p><a href="#/">&larr; Hjem</a></p>
    <h1>Sangbøker</h1>
    <ul class="songbook-list">
      ${songbooks.map(sb => `
        <li>
          <a href="#/songbook/${encodeURIComponent(sb.id)}">${escapeHtml(sb.name)}</a>
          <span class="muted">${sb.tab_ids.length} ${sb.tab_ids.length === 1 ? 'tab' : 'tabs'}</span>
        </li>
      `).join('')}
    </ul>
    <p>
      <button id="new-songbook">+ Ny sangbok</button>
      <a href="#/import/ug" class="import-link" style="margin-left:.6rem">⤓ Importer UG-tabs</a>
    </p>

    <section class="drive-sync card">
      <h3>Sync til Google Drive</h3>
      <p class="muted">
        Hold UG-importene dine i sync p&aring; tvers av enheter via din egen Google Drive (skjult per-app-mappe).
        Vi lagrer ingenting &mdash; alt g&aring;r mellom deg og Google.
      </p>
      <div id="drive-status-area">${renderDriveStatus()}</div>
      <p id="drive-msg" class="muted" aria-live="polite"></p>
    </section>
  `;

  root.querySelector('#new-songbook').addEventListener('click', () => {
    const name = prompt('Navn på sangbok:');
    if (!name || !name.trim()) return;
    const id = createSongbook(name.trim());
    location.hash = `#/songbook/${encodeURIComponent(id)}`;
  });

  wireDriveButtons(root, state);
}

function renderDriveStatus() {
  if (!isConfigured()) {
    return `<p class="muted">Drive-sync er ikke konfigurert (Client ID mangler). Se <code>DRIVE-SETUP.md</code>.</p>`;
  }
  if (!isSignedIn()) {
    return `<button id="drive-signin">Logg inn med Google</button>`;
  }
  const last = getLastSyncedAt();
  const tabCount = Object.keys(getLocalImports()?.tabs || {}).length;
  const tabSuffix = tabCount ? `, ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} synket` : '';
  const lastText = last
    ? `Sist synket: ${new Date(last).toLocaleString('no')}${tabSuffix}`
    : 'Ikke synket ennå.';
  return `
    <p class="muted">${lastText}</p>
    <button id="drive-syncnow">Sync nå</button>
    <button id="drive-signout" class="muted-btn">Logg ut</button>
  `;
}

function wireDriveButtons(root, state) {
  const statusArea = root.querySelector('#drive-status-area');
  const msg = root.querySelector('#drive-msg');
  const setMsg = t => { if (msg) msg.textContent = t; };
  const refresh = () => { if (statusArea) statusArea.innerHTML = renderDriveStatus(); wireDriveButtons(root, state); };

  const signInBtn = root.querySelector('#drive-signin');
  if (signInBtn) {
    signInBtn.addEventListener('click', async () => {
      setMsg('Logger inn…');
      try {
        await signIn();
        setMsg('Henter Drive-data og sletter konflikter…');
        // First-sign-in does a full round-trip so existing Drive data
        // (from another device) merges into local immediately. If Drive
        // is empty, the merge is a no-op and the push uploads local.
        await syncRoundTrip();
        setMsg('Synket.');
        refresh();
      } catch (err) {
        setMsg(`Innlogging/sync feilet: ${err.message}`);
        refresh();
      }
    });
  }

  const syncBtn = root.querySelector('#drive-syncnow');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      setMsg('Synker…');
      syncBtn.disabled = true;
      try {
        await syncRoundTrip();
        setMsg('Synket.');
        refresh();
      } catch (err) {
        setMsg(`Sync feilet: ${err.message}`);
      } finally {
        syncBtn.disabled = false;
      }
    });
  }

  const signOutBtn = root.querySelector('#drive-signout');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      signOut();
      setMsg('Logget ut. Lokal data uendret; Drive-blob beholdes.');
      refresh();
    });
  }
}
