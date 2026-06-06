import { importSharedSongbook } from '../storage.js';
import { getTab } from '../catalog.js';
import { escapeHtml } from '../util.js';
import { t, tabCountLabel } from '../i18n.js';

export function render(state, root) {
  const { shareName, tab_ids } = state.route;

  const rows = tab_ids.map(tid => {
    const r = getTab(tid);
    if (!r) return `<li class="missing"><span class="muted">${t('missing_local_tab', { id: tid })}</span></li>`;
    const { tab, song, artist } = r;
    return `<li><a href="#/tab/${tab.id}">${escapeHtml(artist.name)} &mdash; ${escapeHtml(song.name)}</a></li>`;
  }).join('');

  const missing = tab_ids.filter(tid => !getTab(tid)).length;

  root.innerHTML = `
    <p><a href="#/">&larr; ${t('home')}</a></p>
    <h1>${escapeHtml(shareName)}</h1>
    <p class="muted">${t('shared_songbook_meta', {
      count: tab_ids.length,
      tabs: tabCountLabel(tab_ids.length),
      missing: missing > 0 ? t('missing_count', { count: missing }) : '',
    })}</p>
    ${tab_ids.length === 0
      ? `<p>${t('link_has_no_tabs')}</p>`
      : `<ol class="songbook-tabs">${rows}</ol>`}
    <p>
      <button id="save-btn">${t('save_to_songbooks')}</button>
    </p>
  `;

  root.querySelector('#save-btn').addEventListener('click', () => {
    if (tab_ids.length === 0) {
      alert(t('empty_songbook_save'));
      return;
    }
    const id = importSharedSongbook(shareName, tab_ids);
    location.hash = `#/songbook/${encodeURIComponent(id)}`;
  });
}
