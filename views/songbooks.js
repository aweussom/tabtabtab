import { getSongbooks, createSongbook } from '../storage.js';
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
    <button id="new-songbook">+ Ny sangbok</button>
    <a href="#/import/ug" class="import-link" style="margin-left:.6rem">⤓ Importer UG-tabs</a>
  `;
  root.querySelector('#new-songbook').addEventListener('click', () => {
    const name = prompt('Navn på sangbok:');
    if (!name || !name.trim()) return;
    const id = createSongbook(name.trim());
    location.hash = `#/songbook/${encodeURIComponent(id)}`;
  });
}
