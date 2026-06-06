import {
  getSongbook,
  removeFromSongbook,
  renameSongbook,
  deleteSongbook,
  moveTabInSongbook,
} from '../storage.js';
import { getTab } from '../catalog.js';
import { escapeHtml } from '../util.js';
import { buildExportHTML, exportFilename } from '../exporter.js';
import { getLanguage, songbookDisplayName, t } from '../i18n.js';

function buildShareUrl(songbook) {
  const ids = songbook.tab_ids.join(',');
  const name = encodeURIComponent(songbookDisplayName(songbook));
  const base = `${location.origin}${location.pathname}`;
  return `${base}#/share?name=${name}&ids=${ids}`;
}

export function render(state, root) {
  const sb = getSongbook(state.route.id);
  if (!sb) {
    root.innerHTML = `<p><a href="#/songbooks">&larr; ${t('songbooks')}</a></p><p>${t('songbook_not_found')}</p>`;
    return;
  }

  const sbParam = `?sb=${encodeURIComponent(sb.id)}`;
  const total = sb.tab_ids.length;
  // Synthetic songbooks (UG-import-main) auto-track their tabs from the
  // local-imports store — manual remove/reorder is meaningless because the
  // next read regenerates them. Render rows without those controls.
  const isSynthetic = !!sb._synthetic;
  const tabRows = sb.tab_ids.map((tid, idx) => {
    const reorderBtns = isSynthetic ? '' : `
      <span class="reorder">
        <button data-action="up" data-tab="${tid}" ${idx === 0 ? 'disabled' : ''} title="${t('move_up')}">↑</button>
        <button data-action="down" data-tab="${tid}" ${idx === total - 1 ? 'disabled' : ''} title="${t('move_down')}">↓</button>
      </span>
    `;
    const removeBtn = isSynthetic ? '' : `<button data-action="remove" data-tab="${tid}">${t('remove')}</button>`;
    const r = getTab(tid);
    if (!r) {
      return `<li class="missing">
        ${reorderBtns}
        <span class="muted">${t('missing_local_tab', { id: tid })}</span>
        ${removeBtn}
      </li>`;
    }
    const { tab, song, artist } = r;
    const ugCls = artist._source === 'ug' || song._source === 'ug' ? ' class="ug-import"' : '';
    return `<li${ugCls}>
      ${reorderBtns}
      <a href="#/tab/${tab.id}${sbParam}">${escapeHtml(artist.name)} &mdash; ${escapeHtml(song.name)}</a>
      ${removeBtn}
    </li>`;
  }).join('');

  const isFav = sb.id === 'fav';
  const canDelete = !isFav && !isSynthetic;
  const canRename = !isFav && !isSynthetic;

  root.innerHTML = `
    <p><a href="#/songbooks">&larr; ${t('songbooks')}</a></p>
    <h1>${escapeHtml(songbookDisplayName(sb))}</h1>
    <div class="songbook-actions">
      <button id="share-btn">${t('share_link')}</button>
      <button id="export-btn">${t('export_html')}</button>
      ${canRename ? `<button id="rename-btn">${t('rename')}</button>` : ''}
      ${canDelete ? `<button id="delete-btn" class="danger">${t('delete_songbook')}</button>` : ''}
    </div>
    ${sb.tab_ids.length === 0
      ? `<p class="muted">${t('empty_songbook')}</p>`
      : `<ol class="songbook-tabs">${tabRows}</ol>`}
  `;

  root.querySelector('#share-btn').addEventListener('click', async () => {
    const url = buildShareUrl(sb);
    try {
      await navigator.clipboard.writeText(url);
      alert(t('link_copied', { url }));
    } catch {
      prompt(t('copy_link'), url);
    }
  });

  root.querySelector('#export-btn').addEventListener('click', () => {
    const tabs = sb.tab_ids.map(tid => {
      const ref = getTab(tid);
      if (!ref) return null;
      return {
        id: ref.tab.id,
        artist: ref.artist.name,
        song: ref.song.name,
        body: ref.tab.body || '',
        chordnames: ref.tab.chordnames || [],
      };
    });
    const html = buildExportHTML({
      name: songbookDisplayName(sb),
      tabs,
      exportedAt: new Date(),
      language: getLanguage(),
    });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    // Open in new tab so the user can verify the content looks right.
    window.open(url, '_blank');
    // And trigger a download so they have a file to email/share.
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(sb.name);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a delay so both the open and download can resolve.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  if (canRename) {
    root.querySelector('#rename-btn').addEventListener('click', () => {
      const name = prompt(t('new_name'), sb.name);
      if (!name || !name.trim()) return;
      renameSongbook(sb.id, name.trim());
      render(state, root);
    });
  }

  if (canDelete) {
    root.querySelector('#delete-btn').addEventListener('click', () => {
      if (!confirm(t('delete_confirm', { name: sb.name }))) return;
      deleteSongbook(sb.id);
      location.hash = '#/songbooks';
    });
  }

  for (const btn of root.querySelectorAll('button[data-action="remove"]')) {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.tab;
      const tid = /^\d+$/.test(raw) ? Number(raw) : raw;
      removeFromSongbook(sb.id, tid);
      render(state, root);
    });
  }

  for (const btn of root.querySelectorAll('button[data-action="up"], button[data-action="down"]')) {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.tab;
      const tid = /^\d+$/.test(raw) ? Number(raw) : raw;
      const dir = btn.dataset.action === 'up' ? -1 : 1;
      moveTabInSongbook(sb.id, tid, dir);
      render(state, root);
    });
  }
}
