import { getTab } from '../catalog.js';
import {
  isInFavorites,
  toggleFavorite,
  getSongbook,
  getSongbooks,
  getSongbooksContaining,
  addToSongbook,
  removeFromSongbook,
  createSongbook,
  getPlaybackDuration,
  setPlaybackDuration,
  getPlaybackStartY,
  setPlaybackStartY,
  getTextScale,
  setTextScale,
  getChordMode,
  setChordMode,
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_STEP,
} from '../storage.js';
import { escapeHtml, cleanTabBody } from '../util.js';
import * as playback from '../playback.js';
import { wrapTabBody, measureMaxCols, isChordLine, CHORD_TOKEN_RE } from '../chord-wrap.js';
import { renderChordSvg } from '../chord-diagrams.js';
import { getChordFingering } from '../chord-data.js';
import { songbookDisplayName, t } from '../i18n.js';

let _keyHandler = null;
let _scrollListener = null;
let _resizeHandler = null;

/**
 * Filter out lines tagged by the LLM as noise (UG legal preambles, USENET
 * email headers, tabber commentary, etc.) before rendering the body.
 *
 * `suppress` is the enrichment's `display_suppress` array — 0-indexed line
 * numbers in body.split("\n"). Missing/empty → return body untouched.
 * Indices out of range are silently ignored (defensive: LLM hallucinations
 * shouldn't break rendering).
 */
function applyDisplaySuppress(body, suppress) {
  if (!Array.isArray(suppress) || suppress.length === 0) return body;
  const skip = new Set(suppress.filter(n => Number.isInteger(n) && n >= 0));
  if (skip.size === 0) return body;
  return body.split('\n').filter((_, i) => !skip.has(i)).join('\n');
}

function renderHeart(tabId) {
  return isInFavorites(tabId) ? '♥' : '♡';
}

function renderPicker(tabId) {
  // Skip synthetic songbooks (UG-import-main) — they auto-include their
  // tabs, so a checkbox would be misleading (can't be unchecked).
  const all = getSongbooks().filter(sb => !sb._synthetic);
  const containingList = getSongbooksContaining(tabId);
  const containing = new Set(containingList.map(s => s.id));
  const summary = containingList.length === 0
    ? t('add_to_songbook')
    : t('add_to_another_songbook');
  const rows = all.map(sb => `
    <label>
      <input type="checkbox" data-songbook="${escapeHtml(sb.id)}" ${containing.has(sb.id) ? 'checked' : ''}>
      ${escapeHtml(songbookDisplayName(sb))}
    </label>
  `).join('');
  return `
    <details class="songbook-picker">
      <summary>${escapeHtml(summary)}</summary>
      <div class="songbook-picker-body">
        ${rows}
        <button class="new-songbook-btn">${t('new_songbook_ellipsis')}</button>
      </div>
    </details>
  `;
}

function renderSongbookBack(sbId) {
  if (!sbId) return '';
  const sb = getSongbook(sbId);
  if (!sb) return '';
  return `<a href="#/songbook/${encodeURIComponent(sb.id)}" class="songbook-back-btn">&larr; ${t('back_to', { name: escapeHtml(songbookDisplayName(sb)) })}</a>`;
}

function formatRemaining(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('seconds_left', { seconds: s });
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (sec === 0) return t('minutes_left', { minutes: min });
  return t('minutes_seconds_left', { minutes: min, seconds: sec });
}

export function render(state, root) {
  const result = getTab(state.route.id);
  if (!result) {
    root.innerHTML = `<p><a href="#/">&larr; ${t('letters')}</a></p><p>${t('tab_not_found')}</p>`;
    return;
  }
  // When the user navigated from a songbook (?sb= in URL), the natural
  // "back" target is the songbook — especially for songs with only one
  // tab version (UG imports always, catalog sometimes), where the
  // intermediate song page would be a useless single-row list. The
  // separate "Tilbake til <songbook>"-button below is suppressed in that
  // case to avoid two identical navigation paths.
  const sbId = state.route.sb;
  const sb = sbId ? getSongbook(sbId) : null;
  const singleTab = (result.song.tabs?.length ?? 0) <= 1;
  const backToSongbook = sb && singleTab;
  const backLink = backToSongbook
    ? { href: `#/songbook/${encodeURIComponent(sb.id)}`, label: sb.name }
    : { href: `#/song/${result.song.id}`, label: result.song.name };
  renderTabUI(root, result, backLink, {
    songbookId: backToSongbook ? null : sbId,
  });
}

/**
 * Renders the full tab UI (heart, picker, body, playback HUD) into `root`.
 * Used by /tab/:id route AND by /song/:id when the song has exactly one tab
 * — in the latter case `backLink` points to the artist, skipping the otherwise
 * useless "song with 1 tab" intermediate page without changing the URL.
 *
 * `opts.songbookId`: if set and resolves to a real songbook, render an
 * additional "← Tilbake til <songbook>" button next to the songbook picker.
 * The originating songbook id is propagated via the `?sb=` URL param when
 * navigating from #/songbook/:id.
 */
export function renderTabUI(root, refs, backLink, opts = {}) {
  const { tab, song, artist } = refs;
  const chordnames = Array.isArray(tab.chordnames) ? tab.chordnames : [];
  const chords = chordnames.length
    ? `<details class="chords-foldout">
         <summary><span class="chords">${t('chords')}: ${escapeHtml(chordnames.join(' '))}</span></summary>
         <div class="chord-mode-row" hidden>
           <button type="button" class="chord-mode-toggle"></button>
         </div>
         <div class="chord-diagrams" aria-label="${t('chord_diagrams')}"></div>
       </details>`
    : '';
  // LLM-tagged noise suppression (per PLAN.md Phase 2.5): if the enrichment
  // record has a `display_suppress` array of 0-indexed line numbers, hide
  // those lines from the rendered body. Covers UG legal preambles, USENET
  // email headers, tabber commentary, etc. — noise that lives in the body
  // but isn't part of the song. Missing field → show all lines (defensive
  // fallback, matches the architectural decision in PLAN.md "backwards
  // compat is not a hard constraint").
  // cleanTabBody is line-preserving (only strips inline HTML tags, never
  // adds/removes newlines), so line indices the LLM computed from
  // tab.body.split("\n") remain valid against cleanedBody.split("\n").
  const cleanedBody = applyDisplaySuppress(
    cleanTabBody(tab.body || ''),
    song?.enrichment?.display_suppress,
  );

  root.innerHTML = `
    <p><a href="${escapeHtml(backLink.href)}">&larr; ${escapeHtml(backLink.label)}</a></p>
    <div class="tab-header">
      <h1>${escapeHtml(artist.name)} &mdash; ${escapeHtml(song.name)}</h1>
      <button class="heart" id="heart-btn" title="${t('favorite_title')}">${renderHeart(tab.id)}</button>
      <button id="play-btn" title="${t('play_title')}">▶ Auto-scroll</button>
    </div>
    <div class="picker-row">
      ${renderPicker(tab.id)}
      ${renderSongbookBack(opts.songbookId)}
    </div>
    ${chords}
    <div class="tab-bleed"><pre class="tab-body">${escapeHtml(cleanedBody)}</pre></div>
    <div id="text-size-ctl" aria-label="${t('text_size')}">
      <button data-action="larger" title="${t('larger_text')}">A+</button>
      <button data-action="smaller" title="${t('smaller_text')}">a−</button>
    </div>
    <div id="playback-hud" data-phase="idle">
      <div class="hud-time" id="hud-time"></div>
      <div class="hud-controls" id="hud-controls"></div>
    </div>
  `;

  const heartBtn = root.querySelector('#heart-btn');
  heartBtn.addEventListener('click', () => {
    toggleFavorite(tab.id);
    heartBtn.textContent = renderHeart(tab.id);
    rerenderPicker(root, tab.id);
  });

  wirePicker(root, tab.id);
  wirePlayback(root, tab.id);
  wireChordDiagrams(root, chordnames);
  const applyWrap = wireChordWrap(root, cleanedBody);
  wireTextSize(root, applyWrap);
}

/**
 * Populate the chord-foldout body with SVG diagrams for every chord we have
 * fingering data for. Chords we don't know fall back to plain text. A
 * global "vise ↔ barré" toggle appears at the top of the foldout if at
 * least one of this tab's chords has both voicings available — clicking
 * it re-renders every diagram and persists the choice in localStorage.
 */
function wireChordDiagrams(root, chordnames) {
  const container = root.querySelector('.chord-diagrams');
  if (!container || chordnames.length === 0) return;

  const fingerings = chordnames.map(name => ({ name, fingering: getChordFingering(name) }));
  const hasAnyAlt = fingerings.some(f => f.fingering?.alt);

  const renderAll = () => {
    container.innerHTML = '';
    const mode = getChordMode();
    for (const { name, fingering } of fingerings) {
      if (!fingering) {
        const span = document.createElement('span');
        span.className = 'chord-diagram-fallback';
        span.textContent = name;
        container.appendChild(span);
        continue;
      }
      const display = (mode === 'barre' && fingering.alt) ? fingering.alt : fingering;
      container.appendChild(renderChordSvg(name, display));
    }
  };
  renderAll();

  if (hasAnyAlt) {
    const row = root.querySelector('.chord-mode-row');
    const btn = root.querySelector('.chord-mode-toggle');
    row.hidden = false;
    const updateLabel = () => {
      btn.textContent = getChordMode() === 'barre' ? t('show_open_chords') : t('show_barre_chords');
    };
    updateLabel();
    btn.addEventListener('click', () => {
      setChordMode(getChordMode() === 'barre' ? 'vise' : 'barre');
      updateLabel();
      renderAll();
    });
  }
}

// Two-pass chord-token decoration so the same `.chord` styling applies to:
//
//   1. Chord-over-lyric lines: a chord-detected line gets each chord-shaped
//      token wrapped (e.g. "Am  C  G  F" → all four tokens become spans).
//      Heuristic via chord-wrap's `isChordLine` + `CHORD_TOKEN_RE`.
//   2. ChordPro inline-chord notation: `[G]Hello [Am]world` style, where the
//      chord sits between brackets inline with lyrics. Bracket+chord stays
//      as `[G]` in the rendered text (no layout shift) but gets the same
//      color/weight as the chord-over-lyric tokens. Section markers like
//      `[Intro]` and `[Verse 1]` are excluded — only `[A-G]…`-prefixed
//      contents that pass CHORD_TOKEN_RE match.
//
// Pass order matters: chord-line first (works on plain text), then ChordPro
// (works on the partially-wrapped text — span markup doesn't contain `[X]`
// patterns so no double-wrap).
//
// Re-runs after every `wrapTabBody` invocation so resize doesn't drop spans.
function decorateChordTokens(preEl) {
  const lines = preEl.textContent.split('\n');
  const html = lines.map(line => {
    let escaped = escapeHtml(line);
    if (isChordLine(line)) {
      escaped = escaped.replace(/\S+/g, (m) => {
        return CHORD_TOKEN_RE.test(m) ? `<span class="chord">${m}</span>` : m;
      });
    }
    escaped = escaped.replace(/\[([A-G][A-Za-z0-9#b\/]{0,6})\]/g, (m, chord) => {
      return CHORD_TOKEN_RE.test(chord) ? `<span class="chord">[${chord}]</span>` : m;
    });
    return escaped;
  }).join('\n');
  preEl.innerHTML = html;
}

function wireChordWrap(root, rawBody) {
  const preEl = root.querySelector('.tab-body');
  if (!preEl) return () => {};
  const apply = () => {
    if (!preEl.isConnected) return;
    const cols = measureMaxCols(preEl);
    preEl.textContent = wrapTabBody(rawBody, cols);
    decorateChordTokens(preEl);
  };
  apply();
  // iOS Safari fires `resize` mid-rotation-animation, *before* viewport
  // width / media-query state / computed font metrics have settled. A
  // single 120 ms debounce was racy: portrait→landscape would measure
  // pre-settle and lock in a too-narrow budget that no later event would
  // refresh (asymmetry: only the "budget should grow" direction is
  // affected). Fix is to re-apply across multiple frames so at least one
  // measurement lands after Safari has caught up. Each `apply()` re-reads
  // fresh dimensions, so duplicate runs are cheap and idempotent.
  // Also listen to `orientationchange` and `visualViewport.resize` —
  // both are more reliable than `window.resize` on iOS for the
  // rotation case, and visualViewport additionally covers
  // browser-chrome show/hide.
  const scheduleSettleApply = () => {
    apply();
    requestAnimationFrame(() => requestAnimationFrame(apply));
    setTimeout(apply, 250);
    setTimeout(apply, 600);
  };
  _resizeHandler = scheduleSettleApply;
  window.addEventListener('resize', _resizeHandler, { passive: true });
  window.addEventListener('orientationchange', _resizeHandler);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _resizeHandler, { passive: true });
  }
  return apply;
}

function wireTextSize(root, applyWrap) {
  const ctl = root.querySelector('#text-size-ctl');
  const preEl = root.querySelector('.tab-body');
  if (!ctl || !preEl) return;

  const minus = ctl.querySelector('[data-action="smaller"]');
  const plus = ctl.querySelector('[data-action="larger"]');

  const apply = () => {
    const scale = getTextScale();
    preEl.style.setProperty('--tab-text-scale', String(scale));
    if (minus) minus.disabled = scale <= TEXT_SCALE_MIN + 1e-6;
    if (plus) plus.disabled = scale >= TEXT_SCALE_MAX - 1e-6;
    // Defer wrap to next frame: writing `--tab-text-scale` doesn't update
    // getComputedStyle's font metrics until the browser reflows. Same-tick
    // applyWrap would read the *old* charW on iOS, producing the
    // zoom-out-doesn't-widen asymmetry observed during debugging.
    requestAnimationFrame(applyWrap);
  };

  ctl.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (!action) return;
    const cur = getTextScale();
    const next = action === 'larger' ? cur + TEXT_SCALE_STEP : cur - TEXT_SCALE_STEP;
    setTextScale(next);
    apply();
  });

  apply();
}

function rerenderPicker(root, tabId) {
  const old = root.querySelector('.songbook-picker');
  if (!old) return;
  const wasOpen = old.open;
  old.outerHTML = renderPicker(tabId);
  const fresh = root.querySelector('.songbook-picker');
  if (wasOpen) fresh.open = true;
  wirePicker(root, tabId);
}

function wirePicker(root, tabId) {
  for (const cb of root.querySelectorAll('.songbook-picker input[type="checkbox"]')) {
    cb.addEventListener('change', () => {
      const sbId = cb.dataset.songbook;
      if (cb.checked) addToSongbook(sbId, tabId);
      else removeFromSongbook(sbId, tabId);
      const heartBtn = root.querySelector('#heart-btn');
      if (heartBtn) heartBtn.textContent = renderHeart(tabId);
    });
  }
  const newBtn = root.querySelector('.songbook-picker .new-songbook-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const name = prompt(t('songbook_name_prompt'));
      if (!name || !name.trim()) return;
      const sbId = createSongbook(name.trim());
      addToSongbook(sbId, tabId);
      rerenderPicker(root, tabId);
    });
  }
}

function wirePlayback(root, tabId) {
  const playBtn = root.querySelector('#play-btn');
  const hud = root.querySelector('#playback-hud');
  const hudTime = root.querySelector('#hud-time');
  const hudControls = root.querySelector('#hud-controls');

  function estimateIdleRemaining() {
    const endY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (endY <= 0) return 0;
    const remainingPx = Math.max(0, endY - window.scrollY);
    const total = getPlaybackDuration(tabId);
    return (remainingPx / endY) * total;
  }

  function renderHud(phase) {
    hud.dataset.phase = phase;
    if (phase === 'idle') {
      hudTime.textContent = formatRemaining(estimateIdleRemaining());
      hudControls.innerHTML = `<button data-action="start">▶ ${t('start')}</button>`;
    } else if (phase === 'countdown') {
      hudControls.innerHTML = `<button data-action="cancel">${t('cancel')}</button>`;
    } else if (phase === 'playing') {
      hudControls.innerHTML = `
        <button data-action="slower" title="${t('slower')}">−</button>
        <button data-action="faster" title="${t('faster')}">+</button>
        <button data-action="pause">⏸ ${t('pause')}</button>
      `;
    } else if (phase === 'paused') {
      hudControls.innerHTML = `
        <button data-action="slower" title="${t('slower')}">−</button>
        <button data-action="faster" title="${t('faster')}">+</button>
        <button data-action="resume">▶ ${t('resume')}</button>
      `;
    }
  }

  function renderTopButton(phase) {
    if (phase === 'idle') {
      playBtn.textContent = '▶ Auto-scroll';
      playBtn.disabled = false;
    } else if (phase === 'countdown') {
      playBtn.disabled = true;
    } else if (phase === 'playing') {
      playBtn.textContent = `⏸ ${t('pause')}`;
      playBtn.disabled = false;
    } else if (phase === 'paused') {
      playBtn.textContent = `▶ ${t('resume')}`;
      playBtn.disabled = false;
    }
  }

  const onCountdown = (n) => {
    if (n > 0) {
      hudTime.textContent = t('preparing', { count: n });
      playBtn.textContent = t('preparing', { count: n });
      playBtn.disabled = true;
    } else {
      hudTime.textContent = formatRemaining(playback.getRemainingSeconds() ?? 0);
    }
  };

  let lastPersistedSpeed = null;
  const onTick = (remaining, speed) => {
    hudTime.textContent = formatRemaining(remaining);
    // Persist only when speed has actually changed (i.e. user adjusted it).
    // During constant-speed glide, tick fires at 60Hz but speed is unchanged
    // — no need to spam localStorage.
    if (speed !== lastPersistedSpeed) {
      lastPersistedSpeed = speed;
      const total = Math.round(
        (document.documentElement.scrollHeight - window.innerHeight) / speed
      );
      if (Number.isFinite(total) && total > 5) setPlaybackDuration(tabId, total);
    }
  };

  const onPhaseChange = (phase) => {
    renderHud(phase);
    renderTopButton(phase);
  };

  const onStop = () => {
    renderHud('idle');
    renderTopButton('idle');
  };

  function startPlayback() {
    const endY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // If we're at the bottom (e.g. just finished a playback), restore the last
    // user-chosen start position before starting again. Fallback to top.
    if (window.scrollY >= endY - 2) {
      const savedY = getPlaybackStartY(tabId);
      const restoreY = (savedY != null && savedY < endY) ? savedY : 0;
      window.scrollTo(0, restoreY);
    }
    // Remember the position the user is starting from — this becomes the
    // restore point next time playback reaches the bottom.
    setPlaybackStartY(tabId, Math.round(window.scrollY));
    const duration = getPlaybackDuration(tabId);
    const started = playback.start(duration, { onCountdown, onTick, onStop, onPhaseChange });
    if (!started) alert(t('nothing_to_scroll'));
  }

  // Click on the top button OR HUD: figure out action from current phase.
  playBtn.addEventListener('click', () => {
    const phase = playback.getPhase();
    if (phase === 'idle') startPlayback();
    else if (phase === 'playing') playback.pause();
    else if (phase === 'paused') playback.resume();
    else if (phase === 'countdown') playback.stop();
  });

  hud.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'start') startPlayback();
    else if (action === 'pause') playback.pause();
    else if (action === 'resume') playback.resume();
    else if (action === 'cancel') playback.stop();
    else if (action === 'slower') playback.scaleSpeed(0.85);
    else if (action === 'faster') playback.scaleSpeed(1.18);
  });

  _keyHandler = (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const phase = playback.getPhase();
    if (phase !== 'playing' && phase !== 'paused') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      playback.scaleSpeed(0.85);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      playback.scaleSpeed(1.18);
    }
  };
  window.addEventListener('keydown', _keyHandler);

  // Update idle-time estimate as the user scrolls manually.
  let scrollRaf = null;
  _scrollListener = () => {
    if (playback.getPhase() !== 'idle') return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      if (playback.getPhase() === 'idle') {
        hudTime.textContent = formatRemaining(estimateIdleRemaining());
      }
    });
  };
  window.addEventListener('scroll', _scrollListener, { passive: true });

  renderHud('idle');
}

export function teardownTabBindings() {
  if (_keyHandler) {
    window.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
  }
  if (_scrollListener) {
    window.removeEventListener('scroll', _scrollListener);
    _scrollListener = null;
  }
  if (_resizeHandler) {
    window.removeEventListener('resize', _resizeHandler);
    window.removeEventListener('orientationchange', _resizeHandler);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', _resizeHandler);
    }
    _resizeHandler = null;
  }
  if (playback.isActive()) playback.stop();
}
