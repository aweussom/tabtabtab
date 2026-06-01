// ==UserScript==
// @name           TabTabTab UG Exporter
// @namespace      https://github.com/aweussom/tabtabtab
// @version        0.3
// @description    Eksporter Ultimate Guitar bookmarks (med chord/lyric-body) til TabTabTab-JSON
// @match          https://www.ultimate-guitar.com/user/mytabs*
// @grant          GM.xmlHttpRequest
// @connect        tabs.ultimate-guitar.com
// @connect        ultimate-guitar.com
// ==/UserScript==

// Install in Tampermonkey / Violentmonkey / Greasemonkey, then visit
// https://www.ultimate-guitar.com/user/mytabs and set page-size filter to "All"
// before clicking the floating "Eksporter til TabTabTab" button.
//
// What it does:
//   1. Scrapes the bookmark list from the DOM (article[isdesktop=true] rows).
//   2. For each bookmark, fetches the tab page with credentials: same-origin so
//      paid Official Tabs unlock for Pro/Lifetime UG subscribers.
//   3. Extracts wiki_tab.content from the page's <div class="js-store"> JSON
//      state, decodes HTML entities, harvests chord names from inline [ch]X[/ch].
//   4. Downloads tabtabtab-ug-import-YYYY-MM-DD.json.
//
// Empirical: 253 OK / 6 failed on Tommy's 259-bookmark run. The 6 failures are
// all UG Official Tabs with publisher protection that returns an empty content
// field even for Pro subscribers. Workaround: bookmark the free -chords-
// community version of those songs and re-run.
//
// See PLAN.md → "Ultimate Guitar bookmark import" for the full design.

(function () {
  'use strict';
  console.log('[TabTabTab UG] script loaded — bookmarks page detected');

  const DELAY_MS = 800; // politeness mellom requests; bump til 1500-2000 hvis UG hangler

  // Plukk bookmark-listen fra DOM-en (BlackLights tilnærming — funker fortsatt i 2026)
  function getBookmarkList() {
    let artist = null;
    const list = [];
    const container = document.querySelector('article[isdesktop=true] div');
    if (!container) return list;

    const rows = [...container.childNodes].slice(1);
    for (const item of rows) {
      const cells = [...item.childNodes];
      if (cells.length < 2) continue;

      const artistCell = cells[0]?.innerText?.trim();
      if (artistCell?.length) artist = artistCell;

      const titleCell = cells[1]?.innerText?.trim();
      const link = cells[1]?.querySelector?.('a')?.getAttribute('href');
      if (!artist || !titleCell || !link) continue;
      list.push({ artist, title: titleCell, link });
    }
    return list;
  }

  // Dekode HTML entities (UG lagrer Ä/ø/å som &Auml;/&oslash;/&aring;).
  // UG-spesifikk markup ([ch], [tab], [Verse], #-preamble) bevares —
  // TabTabTab konverterer downstream.
  function decodeBody(raw) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = raw;
    return decoder.value;
  }

  // Cross-origin GET via the userscript manager's privileged XHR. The
  // bookmark page lives on www.ultimate-guitar.com; tab pages live on
  // tabs.ultimate-guitar.com — different subdomains, so a plain fetch()
  // hits CORS. GM.xmlHttpRequest bypasses CORS for the hosts declared
  // in @connect above, and sends cookies automatically (so Pro/Lifetime
  // users get their unlocked Official Tabs content).
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        method: 'GET',
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve({ ok: true, text: res.responseText });
          } else {
            resolve({ ok: false, status: res.status });
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // Hent én tab-side, parse js-store, returnér body + chord-navn
  async function fetchTabBody(url) {
    const fullUrl = url.startsWith('http') ? url : `https://www.ultimate-guitar.com${url}`;
    const resp = await gmGet(fullUrl);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const html = resp.text;

    const m = html.match(/<div[^>]*class="js-store"[^>]*data-content="([^"]+)"/);
    if (!m) return { error: 'no js-store element' };

    const jsonStr = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    let state;
    try { state = JSON.parse(jsonStr); }
    catch (e) { return { error: `JSON parse failed: ${e.message}` }; }

    const data = state?.store?.page?.data;
    const content = data?.tab_view?.wiki_tab?.content;
    if (!content) return { error: 'no content in tab_view.wiki_tab' };

    // Plukk chord-navn ut av rå [ch]X[/ch]-markup før vi sender body videre
    const chords = new Set();
    const re = /\[ch\](.+?)\[\/ch\]/g;
    let cm;
    while ((cm = re.exec(content)) !== null) chords.add(cm[1].trim());

    return {
      body: decodeBody(content),
      chordnames: [...chords],
      tabId: data?.tab?.id ?? null,
      tabType: data?.tab?.type ?? null,
    };
  }

  // Hovedløkken
  async function exportAll(btn) {
    btn.disabled = true;
    const list = getBookmarkList();
    if (list.length === 0) {
      alert('Fant ingen bookmarks. Sjekk at filter er satt til "All" øverst på siden.');
      btn.disabled = false;
      return;
    }
    btn.textContent = `Henter 0/${list.length}…`;

    const results = [], failed = [];
    const startedAt = new Date().toISOString();

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      btn.textContent = `Henter ${i + 1}/${list.length}…`;
      try {
        const body = await fetchTabBody(entry.link);
        if (body.error) {
          failed.push({ ...entry, error: body.error });
          console.warn(`[TabTabTab UG] FAIL ${entry.artist} — ${entry.title}: ${body.error}`);
        } else {
          const fullUrl = entry.link.startsWith('http') ? entry.link : `https://www.ultimate-guitar.com${entry.link}`;
          results.push({
            id: `ug-${body.tabId ?? Math.floor(Math.random() * 1e9)}`,
            source: 'ultimate-guitar',
            source_url: fullUrl,
            tab_type: body.tabType,
            artist: entry.artist,
            song: entry.title,
            body: body.body,
            chordnames: body.chordnames,
            imported_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        failed.push({ ...entry, error: e.message });
        console.warn(`[TabTabTab UG] EXC ${entry.artist} — ${entry.title}: ${e.message}`);
      }
      if (i < list.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
    }

    const out = {
      version: 1,
      exported_at: startedAt,
      finished_at: new Date().toISOString(),
      ok_count: results.length,
      failed_count: failed.length,
      tabs: results,
      failed,
    };

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabtabtab-ug-import-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    btn.textContent = `Ferdig: ${results.length} OK / ${failed.length} feilet`;
    btn.disabled = false;
    console.log('[TabTabTab UG] complete:', { ok: results.length, failed: failed.length });
  }

  // Flytende knapp øverst til høyre — uavhengig av UGs DOM-struktur
  function addButton() {
    if (document.getElementById('tabtabtab-ug-btn')) return;
    if (!document.body) return;

    const btn = document.createElement('button');
    btn.id = 'tabtabtab-ug-btn';
    btn.textContent = '⬇ Eksporter til TabTabTab';
    btn.style.cssText = `
      position: fixed;
      top: 80px;
      right: 16px;
      z-index: 99999;
      background: #ffc600;
      color: #000;
      padding: 10px 16px;
      border: 2px solid #000;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
      font-family: sans-serif;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    btn.onclick = () => exportAll(btn);
    document.body.appendChild(btn);
    console.log('[TabTabTab UG] button injected');
  }

  const interval = setInterval(() => {
    addButton();
    if (document.getElementById('tabtabtab-ug-btn')) clearInterval(interval);
  }, 1000);
})();
