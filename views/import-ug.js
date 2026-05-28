import { getAvailability } from '../enrich-ondevice.js';
import { enqueue, subscribe as subscribeEnrich, getLastSummary, getFailures, isRunning } from '../enrich-queue.js';

/**
 * #/import/ug — drop a Tampermonkey-exported Ultimate Guitar bookmarks JSON,
 * enrich each tab on-device via Chrome's Prompt API (Gemini Nano), and add
 * the result to the user's local library. The enriched tabs land in the
 * same artist/song/body indexes the catalog uses, so they show up in
 * normal search alongside the nortabs.net catalog.
 *
 * Chrome-only by design (PLAN.md Phase 2.5). If the API isn't available we
 * say so plainly; no fallback flow is built yet.
 */
export function render(state, root) {
  root.innerHTML = `
    <p><a href="#/songbooks">&larr; Sangbøker</a></p>
    <h1>Importer Ultimate Guitar-bokmerker</h1>
    <p class="muted">
      Slipp en <code>nortabs-ug-import-*.json</code> her — eksportert med
      <a href="https://github.com/aweussom/tabtabtab/blob/main/crawler/userscripts/nortabs-ug-exporter.user.js" target="_blank">Tampermonkey-skriptet</a>.
      Hver tab blir lest og tagget av <strong>Gemini Nano på din egen maskin</strong>
      (Chrome sin innebygde AI) — null server, null nøkkel, ingenting lastet opp.
      Tabsene legger seg i biblioteket ditt og dukker opp i søk sammen med katalogen.
    </p>

    <div id="ug-avail" class="card"></div>

    <div id="ug-drop" class="card">
      <div class="ug-drop-zone">
        Slipp UG-eksporten her, eller
        <input type="file" id="ug-file" accept="application/json,.json">
      </div>
      <p>
        Berik først <input type="number" id="ug-limit" value="10" min="1" max="999" style="width:5rem"> tabs
        <button id="ug-enrich" disabled>Berik on-device</button>
        <span id="ug-loaded" class="muted"></span>
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
    el.innerHTML = `<strong>✓ On-device AI klar</strong> — Chrome's Prompt API er tilgjengelig (Gemini Nano provisjonert).`;
    return;
  }
  if (avail === 'downloadable' || avail === 'downloading') {
    el.innerHTML = `<strong>⏳ Modell ${avail}</strong> — klikk "Berik on-device" så starter (eller fortsetter) nedlasting av Gemini Nano (~2-4 GB), med progress under. Alternativ manuelt: <code>chrome://components</code> &rarr; "Optimization Guide On Device Model" &rarr; "Check for update".`;
    // Keep the button enabled — LanguageModel.create() will trigger / resume
    // the download with the monitor wired below, so the user can do it all
    // inside the app.
    return;
  }
  if (avail === 'no-api') {
    el.innerHTML = `<strong>⚠ Ingen Prompt API</strong> — denne nettleseren har ikke Chrome's on-device AI. Bruk Google Chrome (eller en annen Chromium-basert nettleser når de støtter det) for å berike importerte tabs.`;
    root.querySelector('#ug-enrich').disabled = true;
    return;
  }
  el.innerHTML = `<strong>⚠ Modell ikke tilgjengelig</strong> — i Chrome: sjekk at flagget <code>#prompt-api-for-gemini-nano</code> er på, og at <code>#optimization-guide-on-device-model</code> er satt til "Enabled BypassPerfRequirement", restart, og last ned modellen via <code>chrome://components</code>.`;
  root.querySelector('#ug-enrich').disabled = true;
}

let _loadedTabs = [];
let _unsubscribe = null;

function wireImport(root) {
  const fileInput = root.querySelector('#ug-file');
  const enrichBtn = root.querySelector('#ug-enrich');
  const loadedEl = root.querySelector('#ug-loaded');
  const limitEl = root.querySelector('#ug-limit');
  const progressCard = root.querySelector('#ug-progress');
  const statusEl = root.querySelector('#ug-status');
  const dropZone = root.querySelector('.ug-drop-zone');

  function onLoaded(data) {
    _loadedTabs = (data.tabs || []).filter(t => t.artist && t.song);
    refreshLoadedDisplay();
  }
  function refreshLoadedDisplay() {
    if (_loadedTabs.length) loadedEl.textContent = `${_loadedTabs.length} tabs lastet`;
    enrichBtn.disabled = _loadedTabs.length === 0 || isRunning();
  }
  // Restore visible state if the user navigated away + back during a load
  // (or after one). _loadedTabs persists module-level for exactly this case.
  refreshLoadedDisplay();

  fileInput.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { onLoaded(JSON.parse(await f.text())); }
    catch (err) { loadedEl.textContent = '✗ feil JSON: ' + err.message; }
  });
  ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.remove('over');
  }));
  dropZone.addEventListener('drop', async e => {
    const f = e.dataTransfer.files[0]; if (!f) return;
    try { onLoaded(JSON.parse(await f.text())); }
    catch (err) { loadedEl.textContent = '✗ feil JSON: ' + err.message; }
  });

  enrichBtn.addEventListener('click', () => {
    const n = Math.min(parseInt(limitEl.value, 10) || 10, _loadedTabs.length);
    if (n === 0) return;
    progressCard.hidden = false;
    // Fire-and-forget — the queue does the actual work, and our subscriber
    // below (renderQueueState) reflects progress into the status pre. The
    // batch keeps running if the user navigates away; the status pill in
    // the header takes over the surfacing job there.
    enqueue(_loadedTabs.slice(0, n)).catch(err => {
      statusEl.textContent = `Kunne ikke starte: ${err.message}`;
    });
  });

  // Single subscription per view-render; previous one (from a prior visit
  // to this view) is unhooked to avoid leaking subscribers across mounts.
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = subscribeEnrich(state => {
    if (!statusEl.isConnected) return;
    enrichBtn.disabled = state.running || _loadedTabs.length === 0;
    if (state.running || state.modelDownload || getLastSummary()) {
      progressCard.hidden = false;
    }
    statusEl.textContent = renderQueueText(state);
  });
}

function renderQueueText(state) {
  if (state.error) return `Feil: ${state.error}`;
  if (state.modelDownload) {
    const gb = (state.modelDownload.loaded / (1024 ** 3)).toFixed(2);
    if (state.modelDownload.total) {
      const totalGb = (state.modelDownload.total / (1024 ** 3)).toFixed(2);
      const pct = Math.round(100 * state.modelDownload.loaded / state.modelDownload.total);
      return `Laster ned Gemini Nano: ${gb} / ${totalGb} GB (${pct}%)`;
    }
    return `Laster ned Gemini Nano: ${gb} GB`;
  }
  if (state.running) {
    const finished = state.done + state.failed;
    let s = `Beriker ${finished}/${state.total} — ${state.done} OK, ${state.failed} feilet`;
    if (state.current) s += `\nNå: ${state.current.artist} — ${state.current.song}`;
    s += '\n\nDu kan navigere bort — det kjører i bakgrunnen. Indeksen oppdateres når batchen er ferdig.';
    return s;
  }
  // Idle. Show last-completed summary if we have one this session.
  const last = getLastSummary();
  if (!last) return '';
  const failures = getFailures();
  let s = `Ferdig: ${last.ok} OK, ${last.fail} feilet på ${last.secs}s — lagret lokalt, søkeindeksen er oppdatert.`;
  if (failures.length) {
    s += '\n\nFeil:\n' + failures.map(f => `  ✗ ${f.tab.artist} — ${f.tab.song}: ${f.error}`).join('\n');
  }
  s += `\n\nSøk på tema/stemning/tekstlinjer i søkefeltet øverst — importerte tabs ligger nå i samme indeks som katalogen.`;
  return s;
}

export function teardownImportUg() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
}
