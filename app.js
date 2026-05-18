import { loadCatalog, loadEnrichment, loadPrivateBundle, getCatalogData } from './catalog.js';
import { setState, subscribe } from './state.js';
import { startRouter } from './router.js';
import { buildIndex } from './search.js';
import { mount as mountSearchBar } from './views/search-bar.js';
import { render as renderLetterIndex } from './views/letter-index.js';
import { render as renderArtist } from './views/artist.js';
import { render as renderSong } from './views/song.js';
import { render as renderTab, teardownTabBindings } from './views/tab.js';
import { render as renderSongbooks } from './views/songbooks.js';
import { render as renderSongbook } from './views/songbook.js';
import { render as renderShare } from './views/share.js';

const VIEWS = {
  home: renderLetterIndex,
  letter: renderLetterIndex,
  artist: renderArtist,
  song: renderSong,
  tab: renderTab,
  songbooks: renderSongbooks,
  songbook: renderSongbook,
  share: renderShare,
};

function renderCurrent(state) {
  teardownTabBindings();
  const root = document.getElementById('app');
  const view = VIEWS[state.route.name] ?? renderLetterIndex;
  view(state, root);
  window.scrollTo(0, 0);
}

async function main() {
  const root = document.getElementById('app');
  root.textContent = 'Loading…';
  try {
    await loadCatalog();
  } catch (err) {
    root.textContent = `Failed to load catalog: ${err.message}`;
    return;
  }
  // Private bundle is optional — absence is fine, app continues with just catalog.
  const privateBundle = await loadPrivateBundle();
  const enrichment = await loadEnrichment();
  const stats = buildIndex(getCatalogData(), enrichment, privateBundle);
  console.info('[search] index built:', stats);
  mountSearchBar();
  subscribe(renderCurrent);
  startRouter(route => setState({ route }));
}

main();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { type: 'module' })
      .catch((err) => console.warn('[sw] registration failed:', err));
  });
}
