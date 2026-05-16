import { getSong } from '../catalog.js';
import { getSongbook } from '../storage.js';
import { escapeHtml } from '../util.js';
import { renderTabUI } from './tab.js';

export function render(state, root) {
  const result = getSong(state.route.id);
  if (!result) {
    root.innerHTML = `<p><a href="#/">&larr; Letters</a></p><p>Song not found.</p>`;
    return;
  }
  const { song, artist } = result;

  // Single-tab songs render the tab UI inline — the URL stays `#/song/:id`,
  // and the back-link skips straight to the artist (or to the originating
  // songbook when `?sb=` is set — UG-imported songs always have exactly
  // one tab, so the songbook is the natural back target). Avoids a useless
  // "1 of 1" intermediate page without breaking URL sharing.
  if (song.tabs.length === 1) {
    const tab = song.tabs[0];
    const sbId = state.route.sb;
    const sb = sbId ? getSongbook(sbId) : null;
    const backLink = sb
      ? { href: `#/songbook/${encodeURIComponent(sb.id)}`, label: sb.name }
      : { href: `#/artist/${artist.id}`, label: artist.name };
    renderTabUI(root, { tab, song, artist }, backLink, {
      songbookId: sb ? null : sbId,
    });
    return;
  }

  root.innerHTML = `
    <p><a href="#/artist/${artist.id}">&larr; ${escapeHtml(artist.name)}</a></p>
    <h1>${escapeHtml(song.name)}</h1>
    ${song.tabs.length === 0
      ? '<p>No tabs.</p>'
      : `<ul>${song.tabs.map(t => {
          const by = t.uploaded_by_name ? ` by ${escapeHtml(t.uploaded_by_name)}` : '';
          return `<li><a href="#/tab/${t.id}">Tab #${t.id}${by}</a></li>`;
        }).join('')}</ul>`}
  `;
}
