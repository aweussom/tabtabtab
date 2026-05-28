import { getAvailability } from '../enrich-ondevice.js';
import { enqueue, subscribe as subscribeEnrich, getState as getQueueState, getLastSummary, getFailures, isRunning } from '../enrich-queue.js';
import { addLocalImport } from '../catalog.js';
import { rebuildIndex } from '../app.js';

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
        <span id="ug-loaded" class="muted"></span>
        <button id="ug-enrich" hidden>Indekser på nytt</button>
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
    el.innerHTML = `<strong>⏳ Modell ${avail}</strong> — slipp UG-eksporten under så starter (eller fortsetter) nedlasting av Gemini Nano (~2-4 GB) med progress. Alternativ manuelt: <code>chrome://components</code> &rarr; "Optimization Guide On Device Model" &rarr; "Check for update".`;
    return;
  }
  if (avail === 'no-api') {
    el.innerHTML = `<strong>💡 Bruk <a href="https://www.google.com/chrome/" target="_blank" rel="noopener">Google Chrome</a>:</strong> da blir søket MYE smartere — Chrome's on-device AI (Gemini Nano) leser hver importert tab og gjør den søkbar på tema, stemning og tekstlinjer.`;
    root.querySelector('#ug-enrich').disabled = true;
    return;
  }
  el.innerHTML = `<strong>💡 Aktiver Chrome's on-device AI</strong> så blir søket MYE smartere. I Chrome: <code>chrome://flags/#prompt-api-for-gemini-nano</code> på, <code>#optimization-guide-on-device-model</code> = "Enabled BypassPerfRequirement", restart, og last ned modellen via <code>chrome://components</code>.`;
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
      statusEl.textContent = 'En annen batch kjører fortsatt. Vent til den er ferdig — eller naviger til pillen nederst-til-høyre for å se status.';
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
      statusEl.textContent = `Kunne ikke starte: ${err.message}`;
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
      `${ok} tabs lagt til biblioteket (${fail} feilet).\n\n` +
      `Søk på artist, sang, eller tekstlinjer fungerer.\n` +
      `For at søk på tema, stemning, og vibe også skal funke — bruk Google Chrome (Chrome's on-device AI Gemini Nano leser hver tab og legger på de tagene).`;
  }

  function refreshLoadedDisplay() {
    if (_loadedTabs.length) loadedEl.textContent = `${_loadedTabs.length} tabs lastet`;
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
    try { await onLoaded(JSON.parse(await f.text())); }
    catch (err) { loadedEl.textContent = '✗ feil JSON: ' + err.message; }
  });

  enrichBtn.addEventListener('click', async () => {
    if (isRunning()) {
      statusEl.textContent = 'En batch kjører allerede. Vent til den er ferdig.';
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
    let s = `Indekserer ${finished}/${state.total} — ${state.done} OK, ${state.failed} feilet`;
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
