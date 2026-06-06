import { getAvailability } from '../enrich-ondevice.js';
import { enqueue, subscribe as subscribeEnrich, getState as getQueueState, getLastSummary, getFailures, isRunning } from '../enrich-queue.js';
import { addLocalImport } from '../catalog.js';
import { rebuildIndex } from '../app.js';
import { t } from '../i18n.js';

/**
 * #/import/ug — drop a Tampermonkey-exported Ultimate Guitar bookmarks JSON
 * and let the app handle the rest. Two paths from the same drop:
 *
 *   - Chrome (Prompt API available): auto-enqueue into the on-device
 *     enrichment queue (Gemini Nano). Each tab gets tagged with theme /
 *     mood / occasion / key_phrases for vibe-search.
 *   - Anywhere else: literal-only import. Tabs land in localStorage with
 *     empty enrichment — artist/song/body still index, so plain text
 *     search works. The vibe layer is the Chrome-only piece.
 *
 * Either way the tabs end up in `_localImports` and surface in the same
 * letter-browse, search, and auto-synthesized "Mine UG-importer"
 * songbook as the catalog does.
 */
export function render(state, root) {
  root.innerHTML = `
    <p><a href="#/songbooks">&larr; ${t('songbooks')}</a></p>
    <h1>${t('import_ug_heading')}</h1>
    <p class="muted">
      ${t('import_ug_intro')}
      <strong>${t('first_time')} <a href="docs/import-ug-guide.html" target="_blank">${t('step_guide')}</a></strong>
    </p>

    <div id="ug-avail" class="card"></div>

    <div id="ug-drop" class="card">
      <div class="ug-drop-zone">
        ${t('drop_export')}
        <input type="file" id="ug-file" accept="application/json,.json">
      </div>
      <p>
        <span id="ug-loaded" class="muted"></span>
        <button id="ug-enrich" hidden>${t('reindex')}</button>
      </p>
    </div>

    <div id="ug-progress" class="card" hidden>
      <pre id="ug-status" style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px;margin:0"></pre>
    </div>
  `;

  wireAvailability(root);
  wireImport(root);
}

async function wireAvailability(root) {
  const el = root.querySelector('#ug-avail');
  const avail = await getAvailability();
  if (avail === 'available') {
    el.innerHTML = `<strong>${t('ai_ready')}</strong> — ${t('ai_ready_detail')}`;
    return;
  }
  if (avail === 'downloadable' || avail === 'downloading') {
    el.innerHTML = `<strong>${t('model_downloadable', { status: avail })}</strong> — ${t('model_download_detail')}`;
    return;
  }
  if (avail === 'no-api') {
    el.innerHTML = `<strong>${t('use_chrome').replace('Google Chrome', '<a href="https://www.google.com/chrome/" target="_blank" rel="noopener">Google Chrome</a>')}</strong> ${t('use_chrome_detail')}`;
    root.querySelector('#ug-enrich').disabled = true;
    return;
  }
  el.innerHTML = `<strong>${t('enable_chrome_ai')}</strong> — ${t('enable_chrome_ai_detail')}`;
  root.querySelector('#ug-enrich').disabled = true;
}

let _loadedTabs = [];
let _unsubscribe = null;

function wireImport(root) {
  const fileInput = root.querySelector('#ug-file');
  const enrichBtn = root.querySelector('#ug-enrich');
  const loadedEl = root.querySelector('#ug-loaded');
  const progressCard = root.querySelector('#ug-progress');
  const statusEl = root.querySelector('#ug-status');
  const dropZone = root.querySelector('.ug-drop-zone');

  async function onLoaded(data) {
    _loadedTabs = (data.tabs || []).filter(t => t.artist && t.song);
    refreshLoadedDisplay();
    // Drop → go. Chrome runs the LLM loop, anything else literal-imports
    // (artist + song + body land in the index for plain text search; the
    // semantic vibe layer only Chrome unlocks).
    if (_loadedTabs.length === 0) return;
    if (isRunning()) {
      statusEl.textContent = t('another_batch');
      progressCard.hidden = false;
      return;
    }
    const avail = await getAvailability();
    if (avail === 'no-api') {
      literalImportAll();
    } else {
      autoEnqueue();
    }
  }

  function autoEnqueue() {
    progressCard.hidden = false;
    enrichBtn.hidden = true;
    enqueue(_loadedTabs.slice()).catch(err => {
      statusEl.textContent = t('could_not_start', { error: err.message });
    });
  }

  function literalImportAll() {
    progressCard.hidden = false;
    enrichBtn.hidden = true;
    let ok = 0, fail = 0;
    for (const tab of _loadedTabs) {
      try { addLocalImport(tab, {}); ok++; } catch { fail++; }
    }
    rebuildIndex();
    statusEl.textContent =
      t('literal_import_done', { ok, fail });
  }

  function refreshLoadedDisplay() {
    if (_loadedTabs.length) loadedEl.textContent = t('tabs_loaded', { count: _loadedTabs.length });
    // The button is a "re-trigger" affordance — only useful AFTER an initial
    // run completed (idle state with a last summary) so the user can re-run
    // (e.g. after migrating from a non-Chrome browser to Chrome).
    const showRerun = !!getLastSummary() && _loadedTabs.length > 0 && !isRunning();
    enrichBtn.hidden = !showRerun;
    enrichBtn.disabled = !showRerun;
  }
  // Restore visible state if the user navigated away + back during a load
  // (or after one). _loadedTabs persists module-level for exactly this case.
  refreshLoadedDisplay();

  fileInput.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await onLoaded(JSON.parse(await f.text())); }
    catch (err) { loadedEl.textContent = t('invalid_json', { error: err.message }); }
  });
  ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.remove('over');
  }));
  dropZone.addEventListener('drop', async e => {
    const f = e.dataTransfer.files[0]; if (!f) return;
    try { await onLoaded(JSON.parse(await f.text())); }
    catch (err) { loadedEl.textContent = t('invalid_json', { error: err.message }); }
  });

  enrichBtn.addEventListener('click', async () => {
    if (isRunning()) {
      statusEl.textContent = t('batch_running');
      return;
    }
    const avail = await getAvailability();
    if (avail === 'no-api') literalImportAll();
    else autoEnqueue();
  });

  // Single subscription per view-render; previous one (from a prior visit
  // to this view) is unhooked to avoid leaking subscribers across mounts.
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = subscribeEnrich(state => {
    if (!statusEl.isConnected) return;
    refreshLoadedDisplay();
    if (state.running || state.modelDownload || getLastSummary()) {
      progressCard.hidden = false;
    }
    statusEl.textContent = renderQueueText(state);
  });
}

function renderQueueText(state) {
  if (state.error) return t('error', { error: state.error });
  if (state.modelDownload) {
    const gb = (state.modelDownload.loaded / (1024 ** 3)).toFixed(2);
    if (state.modelDownload.total) {
      const totalGb = (state.modelDownload.total / (1024 ** 3)).toFixed(2);
      const pct = Math.round(100 * state.modelDownload.loaded / state.modelDownload.total);
      return t('downloading_model', { progress: `${gb} / ${totalGb} GB (${pct}%)` });
    }
    return t('downloading_model', { progress: `${gb} GB` });
  }
  if (state.running) {
    const finished = state.done + state.failed;
    let s = t('indexing_status', {
      finished,
      total: state.total,
      done: state.done,
      failed: state.failed,
    });
    if (state.current) s += `\n${t('current_item', state.current)}`;
    s += `\n\n${t('background_notice')}`;
    return s;
  }
  // Idle. Show last-completed summary if we have one this session.
  const last = getLastSummary();
  if (!last) return '';
  const failures = getFailures();
  let s = t('finished_status', last);
  if (failures.length) {
    s += `\n\n${t('failures')}\n` + failures.map(f => `  ✗ ${f.tab.artist} — ${f.tab.song}: ${f.error}`).join('\n');
  }
  s += `\n\n${t('search_tip')}`;
  return s;
}

export function teardownImportUg() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
}
