import { loadCatalog, loadEnrichment, loadPrivateBundle, loadLocalImports, getLocalImports, mergePrivateBundles, getCatalogData, mergeLocalImports, replaceLocalImports } from './catalog.js';
import { getState, setState, subscribe } from './state.js';
import { startRouter } from './router.js';
import { buildIndex } from './search.js';
import { subscribe as subscribeEnrich, prefetchModel } from './enrich-queue.js';
import { isSignedIn as driveIsSignedIn, push as drivePush, pull as drivePull } from './drive-sync.js';
import { mount as mountSearchBar } from './views/search-bar.js';
import { render as renderLetterIndex } from './views/letter-index.js';
import { render as renderArtist } from './views/artist.js';
import { render as renderSong } from './views/song.js';
import { render as renderTab, teardownTabBindings } from './views/tab.js';
import { render as renderSongbooks } from './views/songbooks.js';
import { render as renderSongbook } from './views/songbook.js';
import { render as renderShare } from './views/share.js';
import { render as renderImportUG, teardownImportUg } from './views/import-ug.js';
import { getLanguage, t, toggleLanguage } from './i18n.js';

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

function updateLanguageChrome() {
  document.documentElement.lang = getLanguage();
  const homeLink = document.getElementById('home-link');
  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const languageBtn = document.getElementById('language-btn');
  if (homeLink) {
    homeLink.textContent = `⌂ ${t('home')}`;
    homeLink.title = t('home_title');
  }
  if (input) input.placeholder = t('search_placeholder');
  if (searchBtn) {
    searchBtn.textContent = t('search');
    searchBtn.title = t('search_title');
  }
  if (languageBtn) {
    languageBtn.textContent = t('language_switch');
    languageBtn.title = t('language_switch_title');
  }
  if (input?.value.trim()) input.dispatchEvent(new Event('input'));
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

// One-pass rebrand: rename any localStorage keys still on the old
// `nortabs:` prefix to the current `tabtabtab:` prefix. Must run before
// the first localStorage read (loadLocalImports, storage.js getSongbooks,
// etc.) so callers see the new keys. Safe to run on every boot — after
// the first migration the loop finds nothing. Existing tabtabtab: targets
// are not overwritten (in case of a partial prior run).
function migrateLocalStorageKeys() {
  const toMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('nortabs:')) toMigrate.push(k);
  }
  for (const oldKey of toMigrate) {
    const newKey = 'tabtabtab:' + oldKey.slice('nortabs:'.length);
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
    }
    localStorage.removeItem(oldKey);
  }
}

async function main() {
  migrateLocalStorageKeys();
  const root = document.getElementById('app');
  root.innerHTML = `
    <div class="app-loading">
      <p>${t('loading')}</p>
      <p id="loading-detail" class="muted"></p>
    </div>
  `;
  const detail = root.querySelector('#loading-detail');
  try {
    await loadCatalog({
      onProgress: ({ loaded }) => {
        detail.textContent = t('loaded_mb', { mb: (loaded / (1024 * 1024)).toFixed(1) });
      },
    });
  } catch (err) {
    root.textContent = t('catalog_load_failed', { error: err.message });
    return;
  }
  // Both private sources are optional — absence is fine, app continues with
  // just catalog. Shipped bundle is per-deploy; local imports are per-user.
  _shippedPrivate = await loadPrivateBundle();
  loadLocalImports();
  _enrichment = await loadEnrichment();
  rebuildIndex();
  mountSearchBar();
  updateLanguageChrome();
  document.getElementById('language-btn')?.addEventListener('click', toggleLanguage);
  window.addEventListener('tabtabtab:languagechange', () => {
    updateLanguageChrome();
    setState({ ...getState() });
  });
  wireEnrichPill();
  subscribe(renderCurrent);
  startRouter(route => setState({ route }));

  // Best-effort background warm-up of Gemini Nano. No-op when already
  // provisioned, when offline, or when the Prompt API isn't available.
  // Failures are silent — the user gets a clearer error in #/import/ug
  // if and when they actually try to enrich. Doing this here means the
  // first "Indekser on-device" click is instant for users who'd otherwise
  // sit through a multi-minute download.
  prefetchModel();

  // Auto-pull on app boot: if the user is signed into Drive, do a full
  // round-trip in the background so changes from another device land
  // without needing a manual "Sync nå" click. Merge is conservative
  // (per-tab union via imported_at) — can only add data, never lose any.
  // Fire after the initial render so the user isn't waiting on Drive
  // before seeing local state; re-trigger renderCurrent when pull
  // completes so the visible view reflects any pulled-in entries.
  if (driveIsSignedIn()) {
    syncRoundTrip()
      .then(() => setState({ ...getState() }))
      .catch(err => console.warn('[drive-sync] auto-pull failed:', err.message));
  }
}

// Pull Drive blob → merge with local → replace local → rebuild index → push
// the merged result back. Used by both the auto-boot pull and the manual
// "Sync nå" button in the songbooks view. Exported so it has one canonical
// implementation.
export async function syncRoundTrip() {
  const remote = await drivePull();
  const local = getLocalImports();
  const merged = mergeLocalImports(local, remote);
  replaceLocalImports(merged);
  rebuildIndex();
  await drivePush(merged);
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
    // Show the pill for either an active enrichment OR a background model
    // download (prefetch). wasRunning is only flipped by `running` so the
    // post-batch rebuildIndex doesn't fire after a pure prefetch (nothing
    // changed in the local-imports store).
    if (state.running) wasRunning = true;
    if (state.running || state.modelDownload) {
      pill.hidden = false;
      if (state.modelDownload) {
        const gb = (state.modelDownload.loaded / (1024 ** 3)).toFixed(2);
        pill.textContent = `↓ Gemini Nano ${gb} GB…`;
      } else {
        const finished = state.done + state.failed;
        pill.textContent = t('indexing_pill', { finished, total: state.total });
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
