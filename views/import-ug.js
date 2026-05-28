import { escapeHtml } from '../util.js';
import { getAvailability, enrichOne } from '../enrich-ondevice.js';
import { addLocalImport } from '../catalog.js';
import { rebuildIndex } from '../app.js';

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
    el.innerHTML = `<strong>⏳ Modell ${avail}</strong> — gå til <code>chrome://components</code>, finn "Optimization Guide On Device Model" og trykk "Check for update". Tilbake hit når den er ferdig nedlastet.`;
    root.querySelector('#ug-enrich').disabled = true;
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

function wireImport(root) {
  const fileInput = root.querySelector('#ug-file');
  const enrichBtn = root.querySelector('#ug-enrich');
  const loadedEl = root.querySelector('#ug-loaded');
  const limitEl = root.querySelector('#ug-limit');
  const progressCard = root.querySelector('#ug-progress');
  const statusEl = root.querySelector('#ug-status');
  const dropZone = root.querySelector('.ug-drop-zone');

  const setStatus = t => { statusEl.textContent = t; };
  const log = t => { statusEl.textContent += '\n' + t; };

  function onLoaded(data) {
    _loadedTabs = (data.tabs || []).filter(t => t.artist && t.song);
    loadedEl.textContent = `${_loadedTabs.length} tabs lastet`;
    enrichBtn.disabled = _loadedTabs.length === 0;
  }

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

  enrichBtn.addEventListener('click', async () => {
    const n = Math.min(parseInt(limitEl.value, 10) || 10, _loadedTabs.length);
    enrichBtn.disabled = true;
    progressCard.hidden = false;
    setStatus(`Beriker ${n} tabs on-device…`);
    const t0 = performance.now();
    let ok = 0, fail = 0;
    for (let i = 0; i < n; i++) {
      const tab = _loadedTabs[i];
      log(`[${i + 1}/${n}] ${tab.artist} — ${tab.song} …`);
      try {
        const enrichment = await enrichOne(tab);
        addLocalImport(tab, enrichment);
        ok++;
      } catch (err) {
        fail++;
        log(`    ✗ ${err.message}`);
      }
    }
    rebuildIndex();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log(`\nFerdig: ${ok} OK, ${fail} feilet på ${secs}s — lagret lokalt og indeksen er oppdatert.`);
    log(`Søk på tema/stemning/tekstlinjer i søkefeltet øverst — importerte tabs ligger nå i samme indeks som katalogen.`);
    enrichBtn.disabled = false;
  });
}
