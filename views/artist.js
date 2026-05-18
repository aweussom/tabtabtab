import { getArtist } from '../catalog.js';
import { escapeHtml } from '../util.js';

export function render(state, root) {
  const result = getArtist(state.route.id);
  if (!result) {
    root.innerHTML = `<p><a href="#/">&larr; Letters</a></p><p>Artist not found.</p>`;
    return;
  }
  const { artist, letter } = result;
  // letter === null marks a private (UG-imported) artist that lives outside
  // the letter-index browse — point its back-link at Sangbøker, which is the
  // canonical surface for private entries.
  const backLink = letter
    ? `<a href="#/letter/${escapeHtml(letter)}">&larr; ${escapeHtml(letter.toUpperCase())}</a>`
    : `<a href="#/songbooks">&larr; Sangbøker</a>`;
  root.innerHTML = `
    <p>${backLink}</p>
    <h1>${escapeHtml(artist.name)}</h1>
    ${artist.songs.length === 0
      ? '<p>No songs.</p>'
      : `<ul>${artist.songs.map(s => `<li><a href="#/song/${s.id}">${escapeHtml(s.name)} <span class="muted">(${s.tabs.length})</span></a></li>`).join('')}</ul>`}
  `;
}
