import { APP_VERSION } from './version.js';

const LOCAL_IMPORTS_KEY = 'tabtabtab:local-imports:v1';

// Ultimate Guitar wraps chord tokens with [ch]X[/ch] and chord-over-lyric
// blocks with [tab]...[/tab]. We strip both — lossless, the chord letter
// stays in its original column position because only the wrapping tags go
// away. Mirrors crawler/build-private-bundle.py's clean_body() so on-device
// imports match the shipped pipeline's body shape exactly.
const UG_WRAP_RE = /\[\/?(?:ch|tab)\]/g;
function cleanUgBody(body) {
  return typeof body === 'string' ? body.replace(UG_WRAP_RE, '') : body;
}

let _data = null;
let _privateBundle = null;
let _localImports = null;
const _byArtistId = new Map();
const _bySongId = new Map();
const _byTabId = new Map();

// Register a private-bundle-shaped object's artists/songs/tabs in the lookup
// maps with letter=null (the marker that flags a private/user entry). Shared
// by the shipped private-bundle and the user's local imports — idempotent,
// safe to re-call after updates.
function _registerBundle(bundle) {
  if (!bundle) return;
  for (const artist of Object.values(bundle.artists ?? {})) {
    const syntheticArtist = { id: artist.id, name: artist.name, songs: [], enrichment: artist.enrichment, _source: 'ug' };
    for (const sid of artist.song_ids ?? []) {
      const song = bundle.songs?.[sid];
      if (!song) continue;
      const syntheticSong = { id: song.id, name: song.name, tabs: [], enrichment: song.enrichment, _source: 'ug' };
      for (const tid of song.tab_ids ?? []) {
        const tab = bundle.tabs?.[tid];
        if (!tab) continue;
        syntheticSong.tabs.push(tab);
        _byTabId.set(tid, { tab, song: syntheticSong, artist: syntheticArtist, letter: null });
      }
      syntheticArtist.songs.push(syntheticSong);
      _bySongId.set(sid, { song: syntheticSong, artist: syntheticArtist, letter: null });
    }
    _byArtistId.set(artist.id, { artist: syntheticArtist, letter: null });
  }
}

function _slug(s) {
  return String(s).toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'a').replace(/å/g, 'a')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function loadCatalog(opts = {}) {
  if (_data) return _data;
  const res = await fetch(`catalog.json?v=${APP_VERSION}`);
  if (!res.ok) throw new Error(`Failed to load catalog.json: ${res.status}`);
  // Stream the body and report decompressed-bytes progress. Pages serves the
  // catalog gzipped, so Content-Length is compressed (~5 MB) while the
  // reader emits decompressed bytes (~24 MB). We report only `loaded` —
  // a ratio would be misleading. Falls back to res.json() when streaming
  // isn't supported or no callback is given.
  if (opts.onProgress && res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      opts.onProgress({ loaded });
    }
    _data = JSON.parse(await new Blob(chunks).text());
  } else {
    _data = await res.json();
  }
  for (const [letter, bucket] of Object.entries(_data.letters ?? {})) {
    for (const artist of bucket.artists) {
      _byArtistId.set(artist.id, { artist, letter });
      for (const song of artist.songs) {
        _bySongId.set(song.id, { song, artist, letter });
        for (const tab of song.tabs) {
          _byTabId.set(tab.id, { tab, song, artist, letter });
        }
      }
    }
  }
  return _data;
}

export async function loadEnrichment() {
  try {
    const res = await fetch(`enrichment.json?v=${APP_VERSION}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Load private-bundle.json (built from a user's UG-import + LLM-enrichment by
// crawler/build-private-bundle.py). Synthetic artist/song entries are
// registered in the same maps the catalog uses, so getArtist/getSong/getTab
// work transparently for string-ID-prefixed private tabs (e.g. "ug-12345").
// letter = null on private entries — they surface via songbook, not via the
// letter-index browse.
export async function loadPrivateBundle() {
  if (_privateBundle) return _privateBundle;
  try {
    const res = await fetch(`private-bundle.json?v=${APP_VERSION}`);
    if (!res.ok) return null;
    _privateBundle = await res.json();
  } catch {
    return null;
  }
  _registerBundle(_privateBundle);
  return _privateBundle;
}

export function getPrivateSongbook() {
  return _privateBundle?.songbook ?? null;
}

// Load the user's local UG-imports + on-device enrichment from localStorage.
// Same bundle shape as private-bundle.json so registration / search-indexing
// is identical. Synchronous (localStorage is sync).
export function loadLocalImports() {
  if (_localImports) return _localImports;
  try {
    const raw = localStorage.getItem(LOCAL_IMPORTS_KEY);
    _localImports = raw ? JSON.parse(raw) : null;
  } catch {
    _localImports = null;
  }
  // One-pass migration: previously-imported tabs predate UG-markup stripping.
  // Clean their bodies in-place and persist so the cache is clean forever.
  // Idempotent — re-cleaning an already-clean body changes nothing.
  if (_localImports?.tabs) {
    let changed = false;
    for (const tab of Object.values(_localImports.tabs)) {
      const cleaned = cleanUgBody(tab.body);
      if (cleaned !== tab.body) { tab.body = cleaned; changed = true; }
    }
    if (changed) {
      try { localStorage.setItem(LOCAL_IMPORTS_KEY, JSON.stringify(_localImports)); } catch {}
    }
  }
  if (_localImports) _registerBundle(_localImports);
  return _localImports;
}

export function getLocalImports() {
  return _localImports;
}

/**
 * Return all UG-imported tab IDs in insertion order. Used by storage.js to
 * synthesize the always-present "Mine UG-importer" songbook — no matter how
 * many import rounds, every UG tab is reachable via that songbook surface.
 */
export function getLocalImportTabIds() {
  if (!_localImports?.tabs) return [];
  return Object.keys(_localImports.tabs);
}

/**
 * Append a single enriched UG-imported tab to local imports. Updates the
 * in-memory bundle, persists to localStorage, and re-registers entries in
 * the catalog lookup maps (idempotent — safe). The caller is responsible
 * for triggering a search re-index when a batch is done.
 */
export function addLocalImport(tab, enrichment) {
  if (!_localImports) _localImports = { artists: {}, songs: {}, tabs: {} };
  const artist = tab.artist || '';
  const song = tab.song || '';
  const artistId = `ug-artist-${_slug(artist)}`;
  const songId = `ug-song-${_slug(artist)}__${_slug(song)}`;
  const tabId = `ug-tab-${_slug(artist)}__${_slug(song)}`;

  _localImports.tabs[tabId] = {
    id: tabId,
    source: 'ug',
    artist, song,
    body: cleanUgBody(tab.body || ''),
    chordnames: Array.isArray(tab.chordnames) ? tab.chordnames : [],
    imported_at: new Date().toISOString(),
  };
  if (!_localImports.songs[songId]) {
    _localImports.songs[songId] = { id: songId, name: song, tab_ids: [], enrichment: null };
  }
  _localImports.songs[songId].enrichment = enrichment;
  if (!_localImports.songs[songId].tab_ids.includes(tabId)) {
    _localImports.songs[songId].tab_ids.push(tabId);
  }
  if (!_localImports.artists[artistId]) {
    _localImports.artists[artistId] = { id: artistId, name: artist, song_ids: [], enrichment: {} };
  }
  if (!_localImports.artists[artistId].song_ids.includes(songId)) {
    _localImports.artists[artistId].song_ids.push(songId);
  }
  try { localStorage.setItem(LOCAL_IMPORTS_KEY, JSON.stringify(_localImports)); } catch {}
  _registerBundle(_localImports);
  return { tabId, songId, artistId };
}

/**
 * Merge two private-bundle-shaped objects (shipped + local). Used to hand
 * search.js a single combined privateBundle. The two MAY overlap on artist
 * IDs (slug collision); on overlap, the second arg wins.
 */
export function mergePrivateBundles(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    artists: { ...(a.artists || {}), ...(b.artists || {}) },
    songs:   { ...(a.songs   || {}), ...(b.songs   || {}) },
    tabs:    { ...(a.tabs    || {}), ...(b.tabs    || {}) },
    songbook: a.songbook ?? b.songbook ?? null,
  };
}

export function getCatalogData() {
  return _data;
}

export function getCrawledLetters() {
  return _data?.letters ? Object.keys(_data.letters) : [];
}

// UG-imported artists are registered with letter=null (the marker for
// private entries), so the raw catalog letter-buckets don't include them.
// Surface them here too — same first-letter-of-name bucketing the catalog
// uses, no visual distinction. Keeps UG entries first-class everywhere:
// they're already in search and have a relevance boost; letter-browse
// shouldn't be the one place they hide.
function _ugArtistsForLetter(letter) {
  if (!letter) return [];
  const target = letter.toLowerCase();
  const out = [];
  for (const { artist, letter: l } of _byArtistId.values()) {
    if (l !== null) continue;
    const first = (artist.name || '').trim().charAt(0).toLowerCase();
    if (first === target) out.push(artist);
  }
  return out;
}

export function getArtistsForLetter(letter) {
  const cat = _data?.letters?.[letter.toLowerCase()]?.artists ?? [];
  const ug = _ugArtistsForLetter(letter);
  if (!cat.length && !ug.length) return null;
  if (!ug.length) return cat;
  return [...cat, ...ug].sort((a, b) => a.name.localeCompare(b.name, 'no'));
}

export function getArtist(id) {
  return _byArtistId.get(id) ?? null;
}

export function getSong(id) {
  return _bySongId.get(id) ?? null;
}

export function getTab(id) {
  return _byTabId.get(id) ?? null;
}
