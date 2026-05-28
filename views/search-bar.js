import { search } from '../search.js';
import { getSongbooks } from '../storage.js';
import { escapeHtml } from '../util.js';

let _debounce = null;

export function mount() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const searchBtn = document.getElementById('search-btn');
  const homeLink = document.getElementById('home-link');
  if (!input || !results) return;

  // Hjem should also clear the active search so the home view is actually
  // visible. Without this, typing a long query then clicking Hjem leaves
  // the results panel covering everything — feels like the button did nothing.
  if (homeLink) {
    homeLink.addEventListener('click', () => {
      input.value = '';
      results.hidden = true;
      for (const f of results.querySelectorAll('section[data-frame]')) f.hidden = true;
    });
  }

  const run = () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => runSearch(input.value, results), 100);
  };

  input.addEventListener('input', run);
  input.addEventListener('focus', () => {
    if (input.value.trim()) runSearch(input.value, results);
  });

  // The Søk-button is mostly a familiarity affordance — search runs as you
  // type. Clicking it focuses the input and re-runs any existing query.
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      input.focus();
      if (input.value.trim()) runSearch(input.value, results);
    });
  }

  // Wire suggest links and clear on hash navigation to result.
  results.addEventListener('click', (e) => {
    const sug = e.target.closest('[data-suggest]');
    if (sug) {
      e.preventDefault();
      input.value = sug.dataset.suggest;
      runSearch(input.value, results);
      input.focus();
      return;
    }
    // If user clicked a result link, collapse the results panel.
    if (e.target.closest('a[href^="#/"]')) {
      results.hidden = true;
    }
  });
}

function favoriteTabIds() {
  // Synthetic songbooks (UG-import-main) aren't user-curated favorites — UG
  // tabs already have a dedicated relevance boost in search.js. Including
  // them here would double-boost every UG tab as if the user had explicitly
  // bookmarked it. Skip.
  const ids = new Set();
  for (const sb of getSongbooks()) {
    if (sb._synthetic) continue;
    for (const tid of sb.tab_ids) ids.add(tid);
  }
  return ids;
}

function frame(name) {
  return document.querySelector(`#search-results [data-frame="${name}"]`);
}

function setFrame(name, html) {
  const el = frame(name);
  if (!el) return;
  if (!html) {
    el.hidden = true;
    el.innerHTML = '';
  } else {
    el.hidden = false;
    el.innerHTML = html;
  }
}

function runSearch(query, results) {
  const q = query.trim();
  if (!q) {
    results.hidden = true;
    for (const f of results.querySelectorAll('section[data-frame]')) f.hidden = true;
    return;
  }

  const r = search(q, { favoriteTabIds: favoriteTabIds() });
  results.hidden = false;
  const liveSearchHref = `https://nortabs.net/search/?q=${encodeURIComponent(q)}`;

  if (r.total === 0 && !r.suggest) {
    setFrame('suggest', null);
    setFrame('artists', null);
    setFrame('songs', null);
    setFrame('lyrics', null);
    setFrame(
      'empty',
      `<p>Ingen treff for &laquo;${escapeHtml(q)}&raquo;. ` +
      `<a href="${liveSearchHref}" target="_blank" rel="noopener">Søk live på nortabs.net &rarr;</a></p>`
    );
    return;
  }

  // Always-visible fallthrough at the bottom: subtle nudge that the user can
  // search nortabs.net live, in case they want broader coverage or fresher
  // entries than our catalog snapshot.
  setFrame(
    'empty',
    `<p class="fallthrough-link"><a href="${liveSearchHref}" target="_blank" rel="noopener">Søk også live på nortabs.net &rarr;</a></p>`
  );

  setFrame(
    'suggest',
    r.suggest ? `<p>Mente du <a href="#" data-suggest="${escapeHtml(r.suggest)}">${escapeHtml(r.suggest)}</a>?</p>` : null
  );

  const ugCls = (obj) => (obj?._source === 'ug' ? ' class="ug-import"' : '');

  setFrame(
    'artists',
    r.artists.length
      ? `<h3>Artister (${r.artists.length})</h3><ul>${r.artists.map(a =>
          `<li${ugCls(a.artist)}><a href="#/artist/${a.artist.id}">${escapeHtml(a.artist.name)}</a></li>`
        ).join('')}</ul>`
      : null
  );

  setFrame(
    'songs',
    r.songs.length
      ? `<h3>Sanger (${r.songs.length})</h3><ul>${r.songs.map(s =>
          `<li${ugCls(s.song) || ugCls(s.artist)}><a href="#/song/${s.song.id}">${escapeHtml(s.artist.name)} &mdash; ${escapeHtml(s.song.name)} <span class="muted">(${s.song.tabs.length})</span></a></li>`
        ).join('')}</ul>`
      : null
  );

  setFrame(
    'lyrics',
    r.bodyHits.length
      ? `<h3>Tekstlinjer (${r.bodyHits.length})</h3><ul>${r.bodyHits.map(h =>
          `<li${ugCls(h.song) || ugCls(h.artist)}><a href="#/song/${h.song.id}">${escapeHtml(h.artist.name)} &mdash; ${escapeHtml(h.song.name)} <span class="muted">(${h.song.tabs.length})</span></a></li>`
        ).join('')}</ul>`
      : null
  );
}
