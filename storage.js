import { getLocalImportTabIds } from './catalog.js';

const UG_SYNTHETIC_ID = 'ug-import-main';

const KEY = 'tabtabtab:songbooks:v1';
const PB_KEY = 'tabtabtab:playback:v1';
const PB_DEFAULT_DURATION_S = 180;
const TS_KEY = 'tabtabtab:textscale:v1';
const CHORD_MODE_KEY = 'tabtabtab:chord-mode:v1';

/**
 * Global chord-rendering preference: 'vise' (default — open / visegrep
 * voicings) or 'barre' (full-barre voicings where the chord has both).
 * Persists across sessions. Will eventually merge with the planned
 * "Advanced mode" toggle in PLAN.md, which also unlocks per-semitone
 * transposition.
 */
export function getChordMode() {
  try {
    return localStorage.getItem(CHORD_MODE_KEY) === 'barre' ? 'barre' : 'vise';
  } catch {
    return 'vise';
  }
}

export function setChordMode(mode) {
  try {
    if (mode === 'barre') localStorage.setItem(CHORD_MODE_KEY, 'barre');
    else localStorage.removeItem(CHORD_MODE_KEY);
  } catch {}
  return getChordMode();
}

export const TEXT_SCALE_MIN = 0.7;
export const TEXT_SCALE_MAX = 2.0;
export const TEXT_SCALE_STEP = 0.1;
const TS_DEFAULT = 1.0;

export function getTextScale() {
  try {
    const raw = localStorage.getItem(TS_KEY);
    if (!raw) return TS_DEFAULT;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return TS_DEFAULT;
    return Math.max(TEXT_SCALE_MIN, Math.min(TEXT_SCALE_MAX, n));
  } catch {
    return TS_DEFAULT;
  }
}

export function setTextScale(s) {
  const clamped = Math.max(TEXT_SCALE_MIN, Math.min(TEXT_SCALE_MAX, s));
  try { localStorage.setItem(TS_KEY, String(clamped)); } catch {}
  return clamped;
}

function readPB() {
  try {
    const raw = localStorage.getItem(PB_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePB(data) {
  localStorage.setItem(PB_KEY, JSON.stringify(data));
}

export function getPlaybackDuration(tabId) {
  return readPB()[String(tabId)]?.duration_s ?? PB_DEFAULT_DURATION_S;
}

export function setPlaybackDuration(tabId, durationS) {
  const data = readPB();
  const cur = data[String(tabId)] ?? {};
  data[String(tabId)] = { ...cur, duration_s: durationS };
  writePB(data);
}

export function getPlaybackStartY(tabId) {
  const y = readPB()[String(tabId)]?.start_y;
  return Number.isFinite(y) ? y : null;
}

export function setPlaybackStartY(tabId, y) {
  const data = readPB();
  const cur = data[String(tabId)] ?? {};
  data[String(tabId)] = { ...cur, start_y: y };
  writePB(data);
}

function now() {
  return new Date().toISOString();
}

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'a').replace(/å/g, 'a')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function defaultData() {
  return {
    version: 1,
    songbooks: [
      { id: 'fav', name: 'Favoritter', created_at: now(), tab_ids: [] },
    ],
  };
}

function read() {
  let parsed;
  try {
    const raw = localStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : defaultData();
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.songbooks)) {
      parsed = defaultData();
    }
    if (!parsed.songbooks.find(s => s.id === 'fav')) {
      parsed.songbooks.unshift({ id: 'fav', name: 'Favoritter', created_at: now(), tab_ids: [] });
    }
  } catch {
    parsed = defaultData();
  }
  // Always-present "Mine UG-importer" songbook — synthesized from current
  // local imports on every read. Never persisted: it can't fall out of sync,
  // can't be deleted, and re-appears the moment the user imports their first
  // UG tab. Any stale entry in localStorage (from the old shipped-bundle era)
  // is overwritten. Marked `_synthetic` so views know to disable editing
  // controls and to skip it from favorites/picker surfaces where appropriate.
  const ugTabIds = getLocalImportTabIds?.() ?? [];
  parsed.songbooks = parsed.songbooks.filter(s => s.id !== UG_SYNTHETIC_ID);
  if (ugTabIds.length) {
    parsed.songbooks.splice(1, 0, {
      id: UG_SYNTHETIC_ID,
      name: 'Mine UG-importer',
      created_at: now(),
      tab_ids: ugTabIds,
      _synthetic: true,
    });
  }
  return parsed;
}

function write(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function getSongbooks() {
  return read().songbooks;
}

export function getSongbook(id) {
  return read().songbooks.find(s => s.id === id) ?? null;
}

export function isInFavorites(tabId) {
  return getSongbook('fav')?.tab_ids.includes(tabId) ?? false;
}

export function toggleFavorite(tabId) {
  const data = read();
  const fav = data.songbooks.find(s => s.id === 'fav');
  const idx = fav.tab_ids.indexOf(tabId);
  if (idx >= 0) fav.tab_ids.splice(idx, 1);
  else fav.tab_ids.push(tabId);
  write(data);
  return idx < 0;
}

export function createSongbook(name) {
  const data = read();
  const base = slugify(name) || 'sangbok';
  const id = `${base}-${Date.now().toString(36)}`;
  data.songbooks.push({ id, name, created_at: now(), tab_ids: [] });
  write(data);
  return id;
}

export function renameSongbook(id, name) {
  const data = read();
  const sb = data.songbooks.find(s => s.id === id);
  if (!sb || id === 'fav') return false;
  sb.name = name;
  write(data);
  return true;
}

export function deleteSongbook(id) {
  if (id === 'fav') return false;
  const data = read();
  data.songbooks = data.songbooks.filter(s => s.id !== id);
  write(data);
  return true;
}

export function addToSongbook(songbookId, tabId) {
  const data = read();
  const sb = data.songbooks.find(s => s.id === songbookId);
  if (!sb) return false;
  if (!sb.tab_ids.includes(tabId)) sb.tab_ids.push(tabId);
  write(data);
  return true;
}

export function removeFromSongbook(songbookId, tabId) {
  const data = read();
  const sb = data.songbooks.find(s => s.id === songbookId);
  if (!sb) return false;
  sb.tab_ids = sb.tab_ids.filter(id => id !== tabId);
  write(data);
  return true;
}

/**
 * Move a tab one step within a songbook. direction: -1 for up, +1 for down.
 * No-op when already at the boundary. Returns true on success.
 */
export function moveTabInSongbook(songbookId, tabId, direction) {
  const data = read();
  const sb = data.songbooks.find(s => s.id === songbookId);
  if (!sb) return false;
  const i = sb.tab_ids.indexOf(tabId);
  if (i < 0) return false;
  const j = i + direction;
  if (j < 0 || j >= sb.tab_ids.length) return false;
  [sb.tab_ids[i], sb.tab_ids[j]] = [sb.tab_ids[j], sb.tab_ids[i]];
  write(data);
  return true;
}

export function getSongbooksContaining(tabId) {
  // Skip synthetic songbooks — the UG songbook auto-includes every UG tab,
  // so reporting "this tab is in Mine UG-importer" is noise (always true).
  // Tab picker + heart-state only care about user-curated memberships.
  return read().songbooks.filter(s => !s._synthetic && s.tab_ids.includes(tabId));
}

export function importSharedSongbook(name, tabIds) {
  const data = read();
  const base = slugify(name) || 'delt-sangbok';
  const id = `${base}-${Date.now().toString(36)}`;
  data.songbooks.push({
    id,
    name,
    created_at: now(),
    tab_ids: tabIds.slice(),
    imported: true,
  });
  write(data);
  return id;
}
