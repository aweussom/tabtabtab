export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Some nortabs.net tab bodies arrive with pre-rendered HTML markup the
 * site uses to highlight ChordPro-style notation: chord names wrapped in
 * `<span class="chopro_chord">…</span>`, editorial commentary in
 * `<span class="chopro_comment">…</span>`, optional `<strong>` labels,
 * and chorus blocks in `<div class="chopro_chorus">…</div>`. We display
 * tab bodies as escaped text in a <pre>, so the user would otherwise see
 * literal "<span class=…>Bb</span>" strings.
 *
 * Strategy: strip those specific wrappers, keeping their text content
 * and the existing whitespace that drives chord-over-lyric column
 * alignment. Other angle-bracketed snippets (`<Capo 2>`, `<half note>`,
 * etc.) are left untouched — they're directives or notation, not HTML.
 *
 * Survey 2026-05-26 across all 7658 catalog tabs:
 *   chopro_chord:   634 tabs (8.3%)  — chord names
 *   chopro_chorus:  182 tabs (2.4%)  — refrain blocks
 *   strong tags:    182 tabs (2.4%)  — Ref:/Vers: labels
 *   chopro_comment: 222 tabs (2.9%)  — editorial notes (Intro:, "Akkordene er…", etc.)
 */
export function cleanTabBody(body) {
  if (!body) return body;
  return body
    .replace(/<span class="chopro_chord">([^<]*)<\/span>/gi, '$1')
    .replace(/<span class="chopro_comment">([^<]*)<\/span>/gi, '$1')
    .replace(/<\/?strong>/gi, '')
    .replace(/<div class="chopro_chorus">/gi, '')
    .replace(/<\/div>/gi, '');
}
