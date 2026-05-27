// JSON-backed enrichment cache.
//
// Single file on disk, full in-memory mirror, write-through on every put/del
// via atomic tmp+rename. The "shared metadata library" idea works because
// the cache key derives from the SONG identity (artist + normalized title),
// not from the prompt or model. Wonderwall enriched today via Mimo and
// Wonderwall enriched next week via Ollama land in the same row.
//
// Why JSON, not SQLite (decided 2026-05-17): JSON is eminently portable.
// One human-readable file, no binary blob, no WAL/SHM siblings, no native
// deps. Trivial to inspect, diff, scp between hosts, or bundle into the
// static web app if we ever want to ship pre-warmed enrichment. Survives
// LLM swaps unchanged — the key is `hash(artist, normalized(song))`, not
// the prompt or model, so an entry written by Qwen3.6 is reused as-is
// when we later swap in Mimo or DeepSeek. Dataset is small enough (target
// single-digit thousands of entries) that synchronous write-through is
// irrelevant.

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

function emptyState() {
  return { version: SCHEMA_VERSION, entries: {} };
}

function loadFromDisk(filePath) {
  if (!fs.existsSync(filePath)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed.entries !== 'object') return emptyState();
    return { version: parsed.version || SCHEMA_VERSION, entries: parsed.entries };
  } catch (err) {
    // Corrupt cache shouldn't kill the proxy — log and start empty. The
    // bad file stays on disk so it can be inspected manually.
    console.warn(`[cache] failed to parse ${filePath}: ${err.message} — starting empty`);
    return emptyState();
  }
}

export function openCache(filePath) {
  const state = loadFromDisk(filePath);

  // Ensure the parent dir exists once at open time — `fs.writeFileSync`
  // does not create missing directories.
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function persist() {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  return {
    get(key) {
      const row = state.entries[key];
      if (!row) return null;
      return {
        enrichment: row.enrichment,
        modelUsed: row.modelUsed,
        createdAt: row.createdAt,
      };
    },
    put(key, artist, song, enrichment, modelUsed) {
      state.entries[key] = {
        artist,
        song,
        enrichment,
        modelUsed,
        createdAt: new Date().toISOString(),
      };
      persist();
    },
    del(key) {
      if (!(key in state.entries)) return false;
      delete state.entries[key];
      persist();
      return true;
    },
    count() {
      return Object.keys(state.entries).length;
    },
    close() {
      // No-op — every put/del is already on disk via persist().
    },
  };
}
