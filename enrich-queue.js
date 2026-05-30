// Background enrichment queue: lifts the on-device enrichment loop out of
// views/import-ug.js so the user can navigate away from the import view
// while a 12-, 50-, 253-tab batch keeps running. Module-level state +
// subscribe(fn) pattern; views render from getState().
//
// Public surface:
//   enqueue(tabs)            → kick off enrichment of [tabs]. Throws if running.
//   subscribe(fn)            → call fn(state) on every change; returns unsubscribe.
//   getState()               → current state (immutable snapshot).
//   isRunning()              → boolean convenience.
//   getLastSummary()         → {ok, fail, secs, finishedAt} of last completed run
//                              (null if nothing has finished this session).
//
// State shape:
//   { running, total, done, failed,
//     current: {artist, song} | null,
//     modelDownload: {loaded, total} | null,
//     error: string | null }

import { prepareModel, enrichOne } from './enrich-ondevice.js';
import { addLocalImport, getLocalImports } from './catalog.js';
import { isSignedIn as isDriveSignedIn, pushIfChanged as drivePushIfChanged } from './drive-sync.js';

let _state = {
  running: false,
  prefetching: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
  modelDownload: null,
  error: null,
};
let _lastSummary = null;
let _failures = []; // [{tab, error}] for the current/most-recent run
const _subs = new Set();

function emit(patch) {
  _state = { ..._state, ...patch };
  for (const fn of _subs) {
    try { fn(_state); } catch (err) { console.error('[enrich-queue] subscriber threw:', err); }
  }
}

export function subscribe(fn) {
  _subs.add(fn);
  fn(_state);
  return () => _subs.delete(fn);
}

export function getState() {
  return _state;
}

export function isRunning() {
  return _state.running;
}

export function getLastSummary() {
  return _lastSummary;
}

export function getFailures() {
  return _failures.slice();
}

/**
 * Enrich each tab in `tabs` sequentially via on-device Gemini Nano, persisting
 * results to localStorage on success. Resolves when the batch finishes.
 *
 * `opts.onComplete()` fires after the loop (success or all-failed). Use it for
 * downstream effects like rebuildIndex(); the queue itself stays decoupled
 * from search.
 */
export async function enqueue(tabs, opts = {}) {
  if (_state.running) throw new Error('Enrichment already running');
  _failures = [];
  emit({
    running: true,
    total: tabs.length,
    done: 0,
    failed: 0,
    current: null,
    modelDownload: null,
    error: null,
  });

  // Prime the on-device model (triggers Nano download if needed; no-op
  // when already provisioned).
  try {
    await prepareModel({
      onDownloadProgress: ({ loaded, total }) => {
        emit({ modelDownload: { loaded, total } });
      },
    });
  } catch (err) {
    emit({ running: false, error: err.message });
    opts.onComplete?.();
    return;
  }
  emit({ modelDownload: null });

  const t0 = performance.now();
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    emit({ current: { artist: tab.artist, song: tab.song } });
    try {
      const enrichment = await enrichOne(tab);
      addLocalImport(tab, enrichment);
      emit({ done: _state.done + 1 });
      // Auto-push to Drive after each successful tab. The push is debounced
      // by `pushIfChanged` so a burst of fast tabs coalesces into at most
      // one in-flight + one pending request — effectively per-tab when
      // network is faster than enrichment, automatically batched when not.
      if (isDriveSignedIn()) {
        drivePushIfChanged(getLocalImports).catch(err => {
          console.warn('[drive-sync] background push failed:', err.message);
        });
      }
    } catch (err) {
      _failures.push({ tab, error: err.message });
      emit({ failed: _state.failed + 1 });
    }
  }

  _lastSummary = {
    ok: _state.done,
    fail: _state.failed,
    secs: ((performance.now() - t0) / 1000).toFixed(1),
    finishedAt: new Date().toISOString(),
  };
  emit({ running: false, current: null });
  opts.onComplete?.();
}

/**
 * Best-effort background warm-up of the on-device model. Skips work when
 * the model is already provisioned, when we look offline, or when the
 * Prompt API isn't available. The actual fetch is delegated to
 * prepareModel; any download-progress events flow into _state so the
 * shared status pill surfaces them — no extra UI needed.
 *
 * Fire-and-forget from app boot. Failures are silent: the user will see
 * a clearer error if and when they actually try to enrich.
 */
export async function prefetchModel() {
  if (_state.running || _state.prefetching) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  emit({ prefetching: true });
  try {
    await prepareModel({
      onDownloadProgress: ({ loaded, total }) => {
        emit({ modelDownload: { loaded, total } });
      },
    });
  } catch {
    // Silent — diagnostic surfaces in #/import/ug if the user tries.
  } finally {
    emit({ prefetching: false, modelDownload: null });
  }
}
