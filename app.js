import { loadCatalog, loadEnrichment, loadPrivateBundle, loadLocalImports, getLocalImports, mergePrivateBundles, getCatalogData } from './catalog.js';
import { setState, subscribe } from './state.js';
import { startRouter } from './router.js';
import { buildIndex } from './search.js';
import { subscribe as subscribeEnrich } from './enrich-queue.js';
import { mount as mountSearchBar } from './views/search-bar.js';
import { render as renderLetterIndex } from './views/letter-index.js';
import { render as renderArtist } from './views/artist.js';
import { render as renderSong } from './views/song.js';
import { render as renderTab, teardownTabBindings } from './views/tab.js';
import { render as renderSongbooks } from './views/songbooks.js';
import { render as renderSongbook } from './views/songbook.js';
import { render as renderShare } from './views/share.js';
import { render as renderImportUG, teardownImportUg } from './views/import-ug.js';

const VIEWS = {
  home: renderLetterIndex,
  letter: renderLetterIndex,
  artist: renderArtist,
  song: renderSong,
  tab: renderTab,
  songbooks: renderSongbooks,
  songbook: renderSongbook,
  share: renderShare,
  'import-ug': renderImportUG,
};

function renderCurrent(state) {
  teardownTabBindings();
  teardownImportUg();
  const root = document.getElementById('app');
  const view = VIEWS[state.route.name] ?? renderLetterIndex;
  view(state, root);
  window.scrollTo(0, 0);
}

let _shippedPrivate = null;  // private-bundle.json (fetched once)
let _enrichment = null;      // enrichment.json (fetched once)

/**
 * Rebuild the search inverted indexes from current catalog + enrichment +
 * combined private bundle (shipped + local imports). Called once at app
 * boot, and again by the import view after a batch of on-device enrichments
 * appends new tabs to local imports. Cheap: <100 ms on the current corpus.
 */
export function rebuildIndex() {
  const combined = mergePrivateBundles(_shippedPrivate, getLocalImports());
  const stats = buildIndex(getCatalogData(), _enrichment, combined);
  console.info('[search] index rebuilt:', stats);
  return stats;
}

async function main() {
  const root = document.getElementById('app');
  root.innerHTML = `
    <div class="app-loading">
      <p>Laster TabTabTab…</p>
      <p id="loading-detail" class="muted"></p>
    </div>
  `;
  const detail = root.querySelector('#loading-detail');
  try {
    await loadCatalog({
      onProgress: ({ loaded }) => {
        detail.textContent = `${(loaded / (1024 * 1024)).toFixed(1)} MB lastet`;
      },
    });
  } catch (err) {
    root.textContent = `Failed to load catalog: ${err.message}`;
    return;
  }
  // Both private sources are optional — absence is fine, app continues with
  // just catalog. Shipped bundle is per-deploy; local imports are per-user.
  _shippedPrivate = await loadPrivateBundle();
  loadLocalImports();
  _enrichment = await loadEnrichment();
  rebuildIndex();
  mountSearchBar();
  wireEnrichPill();
  subscribe(renderCurrent);
  startRouter(route => setState({ route }));
}

// Background-enrichment status pill: shown bottom-right whenever the
// enrich-queue has a running batch, no matter which view the user is on.
// Click routes back to #/import/ug for the full progress card. Once the
// batch completes, rebuild the search index so the new imports are
// queryable, and hide the pill.
function wireEnrichPill() {
  const pill = document.getElementById('enrich-pill');
  if (!pill) return;
  let wasRunning = false;
  subscribeEnrich(state => {
    if (state.running) {
      wasRunning = true;
      pill.hidden = false;
      if (state.modelDownload) {
        const gb = (state.modelDownload.loaded / (1024 ** 3)).toFixed(2);
        pill.textContent = `↓ Gemini Nano ${gb} GB…`;
      } else {
        const finished = state.done + state.failed;
        pill.textContent = `⚙ Beriker ${finished}/${state.total}…`;
      }
    } else {
      pill.hidden = true;
      if (wasRunning) {
        wasRunning = false;
        rebuildIndex();
      }
    }
  });
}

main();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { type: 'module' })
      .catch((err) => console.warn('[sw] registration failed:', err));
  });
}
