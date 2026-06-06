import { getArtist } from '../catalog.js';
import { escapeHtml } from '../util.js';
import { t } from '../i18n.js';

export function render(state, root) {
  const result = getArtist(state.route.id);
  if (!result) {
    root.innerHTML = `<p><a href="#/">&larr; ${t('letters')}</a></p><p>${t('artist_not_found')}</p>`;
    return;
  }
  const { artist, letter } = result;
  // UG-imported artists carry letter=null in the lookup map (they live
  // outside catalog letter-buckets in the underlying data), but they now
  // appear in the letter-index browse via getArtistsForLetter's UG injection.
  // Derive the effective letter from the artist name's first char so the
  // back-link routes to the letter the user clicked, matching how catalog
  // artists already behave (always letter-back, regardless of entry path —
  // browser back covers song-book / search origins).
  const effectiveLetter = letter ?? (artist.name || '').trim().charAt(0).toLowerCase();
  const backLink = effectiveLetter
    ? `<a href="#/letter/${escapeHtml(effectiveLetter)}">&larr; ${escapeHtml(effectiveLetter.toUpperCase())}</a>`
    : `<a href="#/songbooks">&larr; ${t('songbooks')}</a>`;
  root.innerHTML = `
    <p>${backLink}</p>
    <h1>${escapeHtml(artist.name)}</h1>
    ${artist.songs.length === 0
      ? `<p>${t('no_songs')}</p>`
      : `<ul>${artist.songs.map(s => `<li><a href="#/song/${s.id}">${escapeHtml(s.name)} <span class="muted">(${s.tabs.length})</span></a></li>`).join('')}</ul>`}
  `;
}
