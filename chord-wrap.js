/**
 * Context-sensitive line wrapping for chord-over-lyric tabs.
 *
 * Naive `<pre>` wrap loses the column alignment that makes a chord sheet
 * readable — "Am" no longer sits above the syllable it belongs to. This
 * module:
 *   1. Detects chord lines (mostly short tokens like Am, Bb, C#m7, F/G).
 *   2. Pairs each chord line with the lyric line below it.
 *   3. When a pair is wider than `maxCols`, splits BOTH at the same column,
 *      preferably at a whitespace boundary in the lyric, backing up if it
 *      would cut a chord token in half.
 *
 * Non-pair lines (intro labels, chord-only lines, blank lines, prose) pass
 * through unchanged so we don't accidentally re-flow them into nonsense.
 */

// Chord-token heuristic: starts with A-G (root), then up to 6 more chord-ish
// characters (sharp/flat, m/maj/min/dim/aug/sus/add, digits, slash, root).
// Permissive on purpose — false positives on chord-line detection are fine
// because we then check the overall token mix.
export const CHORD_TOKEN_RE = /^[A-G][A-Za-z0-9#b\/]{0,6}$/;

export function isChordLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return false;
  const chordish = tokens.filter(t => CHORD_TOKEN_RE.test(t)).length;
  // ≥70% chord-shaped tokens AND average length ≤ 5 (chord names are short).
  if (chordish < Math.ceil(tokens.length * 0.7)) return false;
  const avgLen = tokens.reduce((s, t) => s + t.length, 0) / tokens.length;
  return avgLen <= 5;
}

function wrapPlain(line, maxCols) {
  if (line.length <= maxCols) return [line];
  const out = [];
  let rest = line;
  while (rest.length > maxCols) {
    let breakAt = rest.lastIndexOf(' ', maxCols);
    if (breakAt <= 0) breakAt = maxCols;
    out.push(rest.slice(0, breakAt).replace(/\s+$/, ''));
    rest = rest.slice(breakAt).replace(/^\s+/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

function wrapChordPair(chord, lyric, maxCols) {
  const len = Math.max(chord.length, lyric.length);
  let c = chord.padEnd(len, ' ');
  let l = lyric.padEnd(len, ' ');

  if (len <= maxCols) return [chord, lyric];

  const out = [];
  // Safety bound — should be 1-3 iterations for typical tabs.
  for (let guard = 0; guard < 20 && c.length > maxCols; guard++) {
    // Prefer breaking at whitespace in the lyric.
    let breakAt = l.lastIndexOf(' ', maxCols);
    if (breakAt <= 0) breakAt = maxCols;

    // If the break would land inside a chord token, back up until it's at
    // (or just past) whitespace in the chord line.
    while (
      breakAt > 0 &&
      breakAt < c.length &&
      c[breakAt - 1] !== ' ' &&
      c[breakAt] !== ' '
    ) {
      breakAt--;
    }
    if (breakAt <= 0) breakAt = Math.min(maxCols, c.length);

    out.push(c.slice(0, breakAt).replace(/\s+$/, ''));
    out.push(l.slice(0, breakAt).replace(/\s+$/, ''));

    c = c.slice(breakAt).replace(/^ /, '');
    l = l.slice(breakAt).replace(/^ /, '');
  }
  if (c.trimEnd().length || l.trimEnd().length) {
    out.push(c.trimEnd());
    out.push(l.trimEnd());
  }
  return out;
}

export function wrapTabBody(body, maxCols) {
  if (!body || maxCols < 20) return body;
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    const nextIsLyric = next.trim().length > 0 && !isChordLine(next);
    if (isChordLine(cur) && nextIsLyric) {
      out.push(...wrapChordPair(cur, next, maxCols));
      i += 2;
    } else if (isChordLine(cur)) {
      // Chord-only line (no lyric pair) — wrapping would scatter chord
      // positions. Pass through; overflow scroll handles it.
      out.push(cur);
      i += 1;
    } else {
      out.push(...wrapPlain(cur, maxCols));
      i += 1;
    }
  }
  return out.join('\n');
}

/** Compute how many monospace chars fit in the available width of a <pre>. */
export function measureMaxCols(preEl) {
  if (!preEl) return 80;
  const cs = getComputedStyle(preEl);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const borderL = parseFloat(cs.borderLeftWidth) || 0;
  const borderR = parseFloat(cs.borderRightWidth) || 0;
  // Measure the parent's inner width, not the pre's own — after wrap, the
  // pre shrinks to fit (flex auto-basis in portrait, `width: max-content`
  // in bleed mode), so reading preEl.clientWidth creates a feedback loop:
  // a wider viewport (e.g. iPhone rotated to landscape) doesn't give a
  // bigger budget because clientWidth still mirrors the prior wrap.
  const container = preEl.parentElement;
  const outerWidth = container ? container.clientWidth : preEl.clientWidth;
  const availPx = outerWidth - padL - padR - borderL - borderR;
  if (availPx <= 0) return 80;
  const span = document.createElement('span');
  span.style.cssText = 'visibility:hidden;position:absolute;left:0;top:0;white-space:pre';
  // Copy individual font longhands — `cs.font` shorthand returns "" on
  // WebKit/Safari when any inherited longhand isn't set explicitly, and
  // we'd silently fall through to body's proportional default.
  span.style.fontFamily = cs.fontFamily;
  span.style.fontSize = cs.fontSize;
  span.style.fontWeight = cs.fontWeight;
  span.style.fontStyle = cs.fontStyle;
  span.style.letterSpacing = cs.letterSpacing;
  span.textContent = 'M'.repeat(40);
  document.body.appendChild(span);
  const totalW = span.getBoundingClientRect().width;
  document.body.removeChild(span);
  const charW = totalW / 40;
  if (!charW || charW < 1) return 80;
  return Math.max(20, Math.floor(availPx / charW));
}
