/**
 * Songbook → standalone HTML exporter. Produces a self-contained .html file
 * (no external assets, no network needed) that the user can email, USB-stick,
 * or print. Includes a minimal auto-scroll HUD for stage use.
 *
 * Pure function: takes resolved tab data, returns HTML string. Doesn't touch
 * storage or the catalog directly — songbook.js does the lookup and passes
 * the result in.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function slug(s) {
  return String(s).toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'a').replace(/å/g, 'a')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const EXPORT_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #1a1a1a;
  background: #fafafa;
  max-width: 760px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 6rem;
}
h1 { font-size: 1.6rem; margin: 0; }
.meta { color: #777; margin: 0.25rem 0 1.5rem; font-size: 0.9rem; }
.toc {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 0.75rem 1.25rem;
  margin: 1rem 0 2rem;
  background: #fff;
}
.toc h2 {
  font-size: 0.75rem;
  margin: 0 0 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #777;
  font-weight: 600;
}
.toc ol { padding-left: 1.5rem; margin: 0; }
.toc li { margin: 0.25rem 0; }
.toc a { color: #0a58ca; text-decoration: none; }
.toc a:hover { text-decoration: underline; }
article { margin: 2.5rem 0; }
article > header h2 {
  margin: 0;
  font-size: 1.25rem;
}
article .chords {
  color: #777;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  margin: 0.25rem 0 0.75rem;
  font-size: 0.95rem;
}
article .source {
  font-size: 0.8rem;
  color: #999;
  margin: 0.25rem 0 0.75rem;
}
pre {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  white-space: pre;
  overflow-x: auto;
  border: 1px solid #e0e0e0;
  background: #fff;
  padding: 1rem;
  border-radius: 6px;
  margin: 0;
  font-size: 0.95rem;
}
.back {
  margin: 0.5rem 0 0;
  text-align: right;
  font-size: 0.85rem;
}
.back a { color: #777; text-decoration: none; }
.back a:hover { text-decoration: underline; }
.missing {
  border: 1px dashed #e0a000;
  background: #fffbe6;
  padding: 0.75rem 1rem;
  border-radius: 6px;
  color: #886600;
  font-size: 0.9rem;
}
#start-btn {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 11;
  padding: 0.5rem 1rem;
  font: inherit;
  border: 1px solid #ccc;
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}
#hud {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem 1rem;
  background: rgba(26,26,26,0.92);
  color: #fff;
  border-radius: 999px;
  z-index: 10;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
}
#hud[hidden] { display: none; }
#hud .hud-time { min-width: 7rem; text-align: center; font-weight: 600; }
#hud button {
  background: transparent;
  color: #fff;
  border: 1px solid rgba(255,255,255,0.3);
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
}
#hud button:hover { background: rgba(255,255,255,0.15); }
@media print {
  body { background: #fff; max-width: none; }
  #start-btn, #hud { display: none !important; }
  .toc { page-break-after: always; }
  article { page-break-inside: avoid; }
  article + article { page-break-before: always; }
  .back { display: none; }
  pre { border: none; padding: 0; }
}
`;

const EXPORT_JS = `
(function(){
  var DEFAULT_DURATION = 180; // seconds
  var raf = null, lastT = null, targetY = 0, speed = null;
  var hud = document.getElementById('hud');
  var hudTime = hud.querySelector('.hud-time');
  var startBtn = document.getElementById('start-btn');
  function endY() { return Math.max(0, document.documentElement.scrollHeight - window.innerHeight); }
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' sek igjen';
    var m = Math.floor(s/60), r = s % 60;
    if (r === 0) return m + ' min igjen';
    return m + ' min ' + r + ' sek igjen';
  }
  function update() { if (speed) hudTime.textContent = fmt((endY() - window.scrollY) / speed); }
  function start() {
    var ey = endY();
    if (ey <= window.scrollY + 2) return;
    speed = (ey - window.scrollY) / DEFAULT_DURATION;
    targetY = window.scrollY;
    lastT = null;
    hud.hidden = false;
    startBtn.textContent = '⏸ Pause';
    update();
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; lastT = null;
    hud.hidden = true;
    startBtn.textContent = '▶ Auto-scroll';
  }
  function tick(now) {
    if (lastT !== null) {
      var dt = (now - lastT) / 1000;
      if (Math.abs(window.scrollY - targetY) > 30) targetY = window.scrollY;
      targetY += speed * dt;
      var ey = endY();
      if (targetY >= ey) { window.scrollTo(0, ey); stop(); return; }
      window.scrollTo(0, targetY);
      update();
    }
    lastT = now;
    raf = requestAnimationFrame(tick);
  }
  function adjust(f) { if (speed) { speed = Math.max(2, speed * f); update(); } }
  startBtn.addEventListener('click', function(){ if (raf) stop(); else start(); });
  hud.addEventListener('click', function(e){
    var a = e.target.dataset && e.target.dataset.act;
    if (a === 'slower') adjust(0.85);
    else if (a === 'faster') adjust(1.18);
    else if (a === 'stop') stop();
  });
  document.addEventListener('keydown', function(e){
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!raf) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); adjust(0.85); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); adjust(1.18); }
  });
})();
`;

const EXPORT_TEXT = {
  no: {
    seconds: ' sek igjen',
    minute: ' min igjen',
    minutesSeconds: (m, s) => m + ' min ' + s + ' sek igjen',
    pause: '⏸ Pause',
    autoScroll: '▶ Auto-scroll',
    chords: 'Akkorder',
    missingTab: id => `Tab #${id} kunne ikke finnes.`,
    source: 'Kilde',
    link: 'lenke',
    back: '↑ Til innhold',
    missing: 'mangler',
    titleSuffix: 'sangbok',
    exported: 'Eksportert fra TabTabTab',
    tab: 'tab',
    tabs: 'tabs',
    contents: 'Innhold',
    slower: 'Tregere (←)',
    faster: 'Raskere (→)',
  },
  en: {
    seconds: 's left',
    minute: ' min left',
    minutesSeconds: (m, s) => m + ' min ' + s + 's left',
    pause: '⏸ Pause',
    autoScroll: '▶ Auto-scroll',
    chords: 'Chords',
    missingTab: id => `Tab #${id} could not be found.`,
    source: 'Source',
    link: 'link',
    back: '↑ Back to contents',
    missing: 'missing',
    titleSuffix: 'songbook',
    exported: 'Exported from TabTabTab',
    tab: 'tab',
    tabs: 'tabs',
    contents: 'Contents',
    slower: 'Slower (←)',
    faster: 'Faster (→)',
  },
};

function exportJs(language) {
  const x = EXPORT_TEXT[language] ?? EXPORT_TEXT.no;
  return EXPORT_JS
    .replace("s + ' sek igjen'", `s + ${JSON.stringify(x.seconds)}`)
    .replace("m + ' min igjen'", `m + ${JSON.stringify(x.minute)}`)
    .replace(
      "return m + ' min ' + r + ' sek igjen';",
      language === 'en'
        ? "return m + ' min ' + r + 's left';"
        : "return m + ' min ' + r + ' sek igjen';",
    )
    .replace("'⏸ Pause'", JSON.stringify(x.pause))
    .replace("'▶ Auto-scroll'", JSON.stringify(x.autoScroll));
}

function formatChords(chordnames, language) {
  if (!Array.isArray(chordnames) || !chordnames.length) return '';
  const x = EXPORT_TEXT[language] ?? EXPORT_TEXT.no;
  return `<p class="chords">${x.chords}: ${escapeHtml(chordnames.join(' '))}</p>`;
}

function renderArticle(idx, tab, language) {
  const x = EXPORT_TEXT[language] ?? EXPORT_TEXT.no;
  if (!tab) {
    return `<article id="tab-${idx}" class="missing">
      <p>${x.missingTab(idx)}</p>
    </article>`;
  }
  const heading = `${escapeHtml(tab.artist)} &mdash; ${escapeHtml(tab.song)}`;
  const source = tab.source === 'ultimate-guitar'
    ? `<p class="source">${x.source}: Ultimate Guitar${tab.source_url ? ` &mdash; <a href="${escapeHtml(tab.source_url)}">${x.link}</a>` : ''}</p>`
    : '';
  return `<article id="tab-${idx}">
  <header>
    <h2>${idx}. ${heading}</h2>
    ${source}
    ${formatChords(tab.chordnames, language)}
  </header>
  <pre>${escapeHtml(tab.body || '')}</pre>
  <p class="back"><a href="#top">${x.back}</a></p>
</article>`;
}

export function buildExportHTML({ name, tabs, exportedAt, language = 'no' }) {
  const x = EXPORT_TEXT[language] ?? EXPORT_TEXT.no;
  const date = (exportedAt instanceof Date ? exportedAt : new Date()).toISOString().slice(0, 10);
  const tocItems = tabs.map((t, i) => {
    const label = t
      ? `${escapeHtml(t.artist)} &mdash; ${escapeHtml(t.song)}`
      : `Tab (${x.missing})`;
    return `<li><a href="#tab-${i + 1}">${label}</a></li>`;
  }).join('\n      ');
  const articles = tabs.map((t, i) => renderArticle(i + 1, t, language)).join('\n');
  return `<!doctype html>
<html lang="${language === 'en' ? 'en' : 'no'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — TabTabTab ${x.titleSuffix}</title>
<style>${EXPORT_CSS}</style>
</head>
<body id="top">
<header>
  <h1>${escapeHtml(name)}</h1>
  <p class="meta">${x.exported} · ${date} · ${tabs.length} ${tabs.length === 1 ? x.tab : x.tabs}</p>
</header>
<nav class="toc">
  <h2>${x.contents}</h2>
  <ol>
      ${tocItems}
  </ol>
</nav>
<main>
${articles}
</main>
<button id="start-btn">▶ Auto-scroll</button>
<div id="hud" hidden>
  <span class="hud-time"></span>
  <button data-act="slower" title="${x.slower}">−</button>
  <button data-act="faster" title="${x.faster}">+</button>
  <button data-act="stop">■</button>
</div>
<script>${exportJs(language)}</script>
</body>
</html>
`;
}

export function exportFilename(songbookName) {
  const s = slug(songbookName) || 'sangbok';
  const date = new Date().toISOString().slice(0, 10);
  return `${s}-${date}.html`;
}
