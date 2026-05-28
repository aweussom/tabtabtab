import { getArtistsForLetter } from '../catalog.js';
import { escapeHtml } from '../util.js';

// Norwegian alphabetical order: a-z, then æ ø å, then digits.
const LETTERS = [...'abcdefghijklmnopqrstuvwxyzæøå', ...'0123456789'];

export function render(state, root) {
  const route = state.route;

  if (route.name === 'home') {
    root.innerHTML = `
      <div class="home-wordcloud" aria-hidden="true"></div>
      <div class="home-content">
        <h1>TabTabTab</h1>
        <nav class="letter-grid">
          ${LETTERS.map(l => {
            const has = getArtistsForLetter(l) !== null;
            const label = l.toUpperCase();
            return has
              ? `<a href="#/letter/${l}">${label}</a>`
              : `<span class="disabled">${label}</span>`;
          }).join('')}
        </nav>
        <p class="home-links"><a href="#/songbooks">Sangbøker &rarr;</a></p>
      </div>
    `;
    return;
  }

  const artists = getArtistsForLetter(route.letter);
  const label = escapeHtml(route.letter.toUpperCase());
  if (artists === null) {
    root.innerHTML = `
      <p><a href="#/">&larr; Letters</a></p>
      <h1>${label}</h1>
      <p>Not crawled yet.</p>
    `;
    return;
  }
  root.innerHTML = `
    <p><a href="#/">&larr; Letters</a></p>
    <h1>${label}</h1>
    <ul>
      ${artists.map(a => `<li><a href="#/artist/${a.id}">${escapeHtml(a.name)}</a></li>`).join('')}
    </ul>
  `;
}
