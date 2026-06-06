import { getSongbooks, createSongbook } from '../storage.js';
import { isConfigured, isSignedIn, signIn, signOut, getLastSyncedAt } from '../drive-sync.js';
import { getLocalImports } from '../catalog.js';
import { syncRoundTrip } from '../app.js';
import { escapeHtml } from '../util.js';
import { getLocale, songbookDisplayName, t, tabCountLabel } from '../i18n.js';

export function render(state, root) {
  const songbooks = getSongbooks();
  root.innerHTML = `
    <p><a href="#/">&larr; ${t('home')}</a></p>
    <h1>${t('songbooks')}</h1>
    <ul class="songbook-list">
      ${songbooks.map(sb => `
        <li>
          <a href="#/songbook/${encodeURIComponent(sb.id)}">${escapeHtml(songbookDisplayName(sb))}</a>
          <span class="muted">${sb.tab_ids.length} ${tabCountLabel(sb.tab_ids.length)}</span>
        </li>
      `).join('')}
    </ul>
    <p>
      <button id="new-songbook">${t('new_songbook')}</button>
      <a href="#/import/ug" class="import-link" style="margin-left:.6rem">⤓ ${t('import_ug_short')}</a>
    </p>

    <section class="drive-sync card">
      <h3>${t('drive_heading')}</h3>
      <p class="muted">
        ${t('drive_description')}
      </p>
      <div id="drive-status-area">${renderDriveStatus()}</div>
      <p id="drive-msg" class="muted" aria-live="polite"></p>
    </section>
  `;

  root.querySelector('#new-songbook').addEventListener('click', () => {
    const name = prompt(t('songbook_name_prompt'));
    if (!name || !name.trim()) return;
    const id = createSongbook(name.trim());
    location.hash = `#/songbook/${encodeURIComponent(id)}`;
  });

  wireDriveButtons(root, state);
}

function renderDriveStatus() {
  if (!isConfigured()) {
    return `<p class="muted">${t('drive_not_configured')}</p>`;
  }
  if (!isSignedIn()) {
    return `<button id="drive-signin">${t('drive_sign_in')}</button>`;
  }
  const last = getLastSyncedAt();
  const tabCount = Object.keys(getLocalImports()?.tabs || {}).length;
  const tabSuffix = tabCount ? t('drive_tabs_synced', {
    count: tabCount,
    tabs: tabCountLabel(tabCount),
  }) : '';
  const lastText = last
    ? t('drive_last_synced', { date: new Date(last).toLocaleString(getLocale()), tabs: tabSuffix })
    : t('drive_never_synced');
  return `
    <p class="muted">${lastText}</p>
    <button id="drive-syncnow">${t('drive_sync_now')}</button>
    <button id="drive-signout" class="muted-btn">${t('drive_sign_out')}</button>
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
      setMsg(t('drive_signing_in'));
      try {
        await signIn();
        setMsg(t('drive_merging'));
        // First-sign-in does a full round-trip so existing Drive data
        // (from another device) merges into local immediately. If Drive
        // is empty, the merge is a no-op and the push uploads local.
        await syncRoundTrip();
        setMsg(t('drive_synced'));
        refresh();
      } catch (err) {
        setMsg(t('drive_signin_failed', { error: err.message }));
        refresh();
      }
    });
  }

  const syncBtn = root.querySelector('#drive-syncnow');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      setMsg(t('drive_syncing'));
      syncBtn.disabled = true;
      try {
        await syncRoundTrip();
        setMsg(t('drive_synced'));
        refresh();
      } catch (err) {
        setMsg(t('drive_sync_failed', { error: err.message }));
      } finally {
        syncBtn.disabled = false;
      }
    });
  }

  const signOutBtn = root.querySelector('#drive-signout');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      signOut();
      setMsg(t('drive_signed_out'));
      refresh();
    });
  }
}
