import { APP_VERSION } from './version.js';

let _data = null;
let _privateBundle = null;
const _byArtistId = new Map();
const _bySongId = new Map();
const _byTabId = new Map();

export async function loadCatalog() {
  if (_data) return _data;
  const res = await fetch(`catalog.json?v=${APP_VERSION}`);
  if (!res.ok) throw new Error(`Failed to load catalog.json: ${res.status}`);
  _data = await res.json();
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
  for (const artist of Object.values(_privateBundle.artists ?? {})) {
    const syntheticArtist = { id: artist.id, name: artist.name, songs: [], enrichment: artist.enrichment };
    for (const sid of artist.song_ids ?? []) {
      const song = _privateBundle.songs?.[sid];
      if (!song) continue;
      const syntheticSong = { id: song.id, name: song.name, tabs: [], enrichment: song.enrichment };
      for (const tid of song.tab_ids ?? []) {
        const tab = _privateBundle.tabs?.[tid];
        if (!tab) continue;
        syntheticSong.tabs.push(tab);
        _byTabId.set(tid, { tab, song: syntheticSong, artist: syntheticArtist, letter: null });
      }
      syntheticArtist.songs.push(syntheticSong);
      _bySongId.set(sid, { song: syntheticSong, artist: syntheticArtist, letter: null });
    }
    _byArtistId.set(artist.id, { artist: syntheticArtist, letter: null });
  }
  return _privateBundle;
}

export function getPrivateSongbook() {
  return _privateBundle?.songbook ?? null;
}

export function getCatalogData() {
  return _data;
}

export function getCrawledLetters() {
  return _data?.letters ? Object.keys(_data.letters) : [];
}

export function getArtistsForLetter(letter) {
  return _data?.letters?.[letter.toLowerCase()]?.artists ?? null;
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
