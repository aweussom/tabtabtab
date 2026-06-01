# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read PLAN.md first

`PLAN.md` is the canonical spec for this project — architecture, stack decisions, data sizes, roadmap phases, and open questions. Read it before doing anything substantive. This file does not duplicate its contents; it only adds the operational context a fresh session would otherwise miss.

## Repository state

The project is renamed `tabtabtab` (formerly NorTabs). Default branch is `main`; the old `tommy-tester-ug` branch is merged. Phase 1-2 (catalog browse + search + songbooks + chord wrap + playback) is shipped. Phase 2.5 was superseded by an **on-device UG-enrichment** path (Chrome Prompt API / Gemini Nano) — see PLAN.md Phase 2.5 "SUPERSEDED" + the "On-device UG enrichment + local imports" section below. Active polish + features land on `main` directly.

Live at [nortabs.netlify.app](https://nortabs.netlify.app) — auto-deploys on every push to `main` via Netlify's GitHub integration. `tabtabtab.no` DNS is pending; the old GitHub Pages URL (`aweussom.github.io/nortabs-web`) is dead.

Stack is still **vanilla JS modules + HTML + CSS, no bundler** — no `package.json`, no build step, no test runner, no lint config. Do not invent build/test commands; opening `index.html` (or serving with `python -m http.server`) is the dev loop. Do not introduce node tooling without asking.

## Architecture

Flat module layout:

- `index.html` — single `<div id="app">`, loads `app.js` as a module.
- `state.js` — central state + `getState()` / `setState(patch)` / `subscribe(fn)`. Re-render the current view on change.
- `router.js` — parses `location.hash`, dispatches to a view, updates state.
- `catalog.js` — **in-memory catalog accessor**. Loads `catalog.json` once, indexes by id. Also owns `_localImports` (UG-imported tabs in localStorage) — see "On-device UG enrichment + local imports" below. (Deliberately *not* called `api.js` — the shipped web app makes no network calls; only the Python crawler does.)
- `search.js` — three inverted indexes + IDF + token aliases + UG-import boost. README has the full tour.
- `chord-wrap.js` — context-sensitive line wrapping for chord-over-lyric tabs on narrow viewports.
- `chord-data.js` + `chord-diagrams.js` — fingerings (with vise↔barré alts) and SVG renderer.
- `storage.js` — localStorage for songbooks, favorites, playback, chord-mode, text-scale. Synthesizes the always-present `ug-import-main` songbook on every read from `_localImports`.
- `playback.js` — auto-scroll engine with countdown / pause / resume / variable speed.
- `exporter.js` — songbook → standalone HTML export.
- `enrich-ondevice.js` — on-device UG enrichment via Chrome's Prompt API (Gemini Nano). Exports `getAvailability()` / `prepareModel(opts)` / `enrichOne(tab, opts)`. Includes the JSON-recovery stack (strip think/fences → balanced-block → JSON5.parse → salvage → one retry) and a `monitor` hook on `LanguageModel.create` that surfaces `downloadprogress` events. Requires global `JSON5` (vendored).
- `enrich-queue.js` — background-enrichment queue. Owns the on-device loop so the user can navigate away from `#/import/ug` while a batch keeps running. Exports `enqueue(tabs)` / `prefetchModel()` / `subscribe(fn)` / `getState()` / `isRunning()` / `getLastSummary()` / `getFailures()`. State shape `{running, prefetching, total, done, failed, current, modelDownload, error}`. Calls `drivePushIfChanged` after each successful tab so changes propagate to the user's Drive as the batch runs.
- `drive-sync.js` — cross-device sync via the user's own Google Drive `appDataFolder` (scope `drive.appdata`). Lazy-loaded Google Identity Services (GIS) for OAuth + Drive REST calls. Exports `isConfigured()` / `isReady()` / `isSignedIn()` / `signIn()` / `signOut()` / `push(payload)` / `pull()` / `pushIfChanged(getPayload)` / `getLastSyncedAt()`. `pushIfChanged` coalesces bursts into at-most-one-in-flight + at-most-one-pending. Client ID lives in `DRIVE_CONFIG.CLIENT_ID` (public info, hardcoded — see `DRIVE-SETUP.md` for Google Cloud Console setup).
- `vendor/json5.min.js` — JSON5 2.2.3 UMD (~31 KB). Vendored, not CDN — works offline. Sets `window.JSON5`.
- `sw.js` — service worker, see "Cache-busting + service worker" below.
- `views/` — one file per screen, each exports `render(state, root)`.
- `crawler/` — Python; the **only** code in the project that calls nortabs.net.

The hard architectural rule: **the shipped web app never makes network calls to nortabs.net's API.** All browsing is served from the embedded `catalog.json` (+ optional `enrichment.json`). The on-device LLM (Gemini Nano via Chrome's Prompt API) is allowed — it's not a network call, it's a local model. Only the nightly GitHub Action crawler talks to the upstream API. Preserve this boundary — it's the whole reason the project exists.

## Reference: the Python app at `C:\devel\python\nortabs-app`

The web app is a rewrite of an existing Flet desktop app. When a UX or data-shape question comes up, that app is authoritative:

- `README.md` — overall flow + component responsibilities. UX should mirror this.
- `api.py` (`NorTabsAPI`) — endpoints, params, observed response shapes in docstrings. The Python crawler in *this* repo must match.
- `views/views_*.py` — one file per screen, matches the intended `views/` layout here.
- `favorites.py`, `navigation.py`, `app.py` (`start_playback` etc.) — starting points for localStorage schema, history stack, and auto-scroll countdown.

The Python app is a **frozen reference**, not a sibling to keep in sync.

## API gotchas (see PLAN.md "Resolved API facts" for confirmed shapes)

- `/collections/browse?sw={letter}` paginates with `limit` (cap 50) and `page` (0-indexed). Without those params it silently returns 10 — easy to mistake for "this letter has only 10 artists." `crawler/crawl.py` iterates until empty.
- Tab content is in `body` (not `content`). `chordnames` is a JSON array, not a space-separated string.
- Some songs return 0 tabs. Open question whether to filter them out of the catalog.
- Songbook share URLs: PLAN.md leans toward raw IDs with title-match fallback if an ID 404s. Don't switch to base64-encoded title lists without revisiting that decision.

## Catalog format

`catalog.json` is `{ crawled_at, letters: { a: {artists: [...]}, b: {...}, ... } }`. Per-letter buckets — partial crawls remain valid. `catalog.js` is the only module that reads this shape; views call `getArtistsForLetter(l)` / `getArtist(id)` / `getSong(id)` / `getTab(id)`. The latter three return `{ artist|song|tab, ..., letter }` for back-link routing.

## Cache-busting + service worker

`version.js` exports `APP_VERSION` (Unix epoch). Two consumers:
- `catalog.js` appends `?v=${APP_VERSION}` to `catalog.json` / `enrichment.json` (+ `private-bundle.json` if/when re-shipped) fetches.
- `sw.js` uses `APP_VERSION` as the cache key (`nortabs-v${APP_VERSION}`) for the precached app shell. Old caches are deleted on activate.

**Auto-bumped on commit** by `.githooks/pre-commit` (Python one-liner). Activate the hook once per clone:

```sh
git config core.hooksPath .githooks
```

After that, every commit bumps `version.js` automatically. Don't edit manually — the hook will overwrite. Skip with `git commit --no-verify` for the rare commit that shouldn't change deployed cache state.

**Merge/rebase/cherry-pick conflicts on `version.js`**: trivially resolve by picking *either* side (`git checkout --ours version.js` or `--theirs version.js`). The pre-commit hook runs on the resulting commit (`rebase --continue` / `cherry-pick --continue` / merge commit) and overwrites whatever you chose with a fresh epoch anyway. Don't waste cycles deciding which side is "right" — both produce identical end state.

**SW debugging gotcha**: when iterating locally on shell files (`*.js`, `style.css`) without committing, the service worker keeps serving the cached old version — `APP_VERSION` only bumps at commit time. PC dev tools usually bypass via "Disable cache" while DevTools is open; **iOS Safari has no such switch** and will serve stale code until either (a) you commit so APP_VERSION bumps, (b) you clear Safari's website data for the host, or (c) you manually `caches.delete()` from the JS console. If a code change "works on desktop but not on iOS," suspect SW cache first.

## Crawler & enrichment

`crawler/crawl.py` — zero-dep stdlib Python (urllib). Args: `--letters`, `--delay-ms` (default 100), `--user-agent`, `--checkpoint-dir` (default `crawler/data/`), `--out` (default `catalog.json`), `--merge-only`, `--force`, `--incremental`. Per-letter checkpoint files in `crawler/data/<letter>.json` survive interruptions; the merge step assembles `catalog.json` from whatever checkpoints exist. Default delay 100 ms is "obviously polite"; full A-Z + 0-9 crawl is ~3 hours at 200 ms, ~9 MB gzipped catalog. Runs nightly via `.github/workflows/crawl.yml` (incremental Mon-Sat, full Sun).

Enrichment scripts (all in `crawler/`):
- `enrich.py` — local LLM enrichment via the `claude` CLI; needs `pip install json5`.
- `enrich-gpt.py` — OpenAI API variant (concurrent); needs `pip install openai` + `OPENAI_API_KEY`.
- `merge-enrichment.py` — combines per-letter `enrichment/<letter>.json` files into the shipped `enrichment.json`.
- `generate-wordcloud.py` — regenerates `images/home-wordcloud.svg`; needs `pip install wordcloud pillow numpy`.
- `run-enrich.ps1` / `run-enrich-parallel.ps1` / `scheduled-enrich.ps1` — quota-aware drivers (Windows Task Scheduler runs the scheduled one at 06:00 Oslo).
- `enrich-private.py` + `build-private-bundle.py` — private-tabs pipeline (see below).

## On-device UG enrichment + local imports

UG enrichment runs **on the user's machine** via Chrome's Prompt API (Gemini Nano). No backend, no API key, no upload of copyrighted content. User flow:

1. User runs `userscripts/tabtabtab-ug-exporter.user.js` (Tampermonkey on Chrome, Violentmonkey/Tampermonkey on Firefox) on UG bookmarks → downloads `tabtabtab-ug-import-*.json`. Cross-origin via `GM.xmlHttpRequest` so cookies flow and `tabs.ultimate-guitar.com` subdomain isn't CORS-blocked (`@connect` allow-list).
2. User opens `#/import/ug` and **drops the JSON** (no separate button click — the drop is the action).
   - **Chrome (Prompt API available)**: auto-enqueue into the background-enrichment queue (`enrich-queue.js`). `enrichOne(tab)` runs per tab (~9-10 s/tab on RTX 5090, ~10-20 s on regular hardware).
   - **Anywhere else**: literal-only import. `addLocalImport(tab, {})` per tab + `rebuildIndex()`. Tabs surface via plain text search (artist/song/body) but skip the LLM vibe layer (theme/mood/occasion). The availability card frames this positively: "💡 Bruk Google Chrome — da blir søket MYE smartere".
3. Each tab (enriched or literal) lands in `localStorage['tabtabtab:local-imports:v1']` via `addLocalImport(tab, enrichment)` in `catalog.js`. Synthetic artist/song/tab IDs (`ug-artist-…`, `ug-song-…`, `ug-tab-…`) derived from slugified names. UG `[ch]`/`[tab]` wrappers stripped at write-time via `cleanUgBody`.
4. `rebuildIndex()` re-runs `search.js`'s indexer over catalog + local imports so new tabs are searchable immediately.

**Background queue + status pill.** `enrich-queue.js` owns the loop; the click handler in `views/import-ug.js` calls `enqueue(tabs)` fire-and-forget. The `#enrich-pill` element (fixed bottom-right in `index.html`) shows `"⚙ Indekserer 7/12…"` or `"↓ Gemini Nano 1.3 GB…"` from whatever view the user is on, and routes back to `#/import/ug` on click. Once `running` flips false, `wireEnrichPill` calls `rebuildIndex` so new entries become searchable. The contract is one batch at a time — a second drop while running shows a clear "vent til denne er ferdig" message instead of silent-no-op.

**Background prefetch on app start.** `app.js`'s `main()` fires `prefetchModel()` after the catalog is loaded. If the model is downloadable AND we look online (`navigator.onLine`), Chrome starts pulling the 2-4 GB Gemini Nano model in the background — pill shows progress. First user-triggered enrichment is then instant. No-op when already provisioned, offline, or no Prompt API.

For fast iteration during dev, `crawler/sample-ug-export.py` produces a small random sample (default 15 of 253 tabs, `--seed` for reproducibility) so a full import-flow test takes ~2-3 min instead of ~40.

**UG entries are first-class everywhere** the user encounters mixed content:

- **Letter browse**: `getArtistsForLetter()` in `catalog.js` merges UG artists with catalog artists by first letter (Norwegian locale sort).
- **Search**: UG-matching entries get a ×2.5 boost (`UG_IMPORT_BOOST` in `search.js`). Marker is `letter === null` in lookup map refs. Prefix-variant matches are deduped per query token so a single morphological match in the enrichment doesn't compound.
- **Always-present songbook**: `storage.js`'s `read()` synthesizes `{id:'ug-import-main', name:'Mine UG-importer', tab_ids:[…all UG tab IDs…], _synthetic:true}` on every read, slotted after Favoritter. Never persisted — can't be deleted, can't fall out of sync. Views check `_synthetic` to disable rename/delete/remove/reorder controls. `getSongbooksContaining` + `favoriteTabIds` skip synthetic so UG tabs aren't double-boosted in search.
- **Visual marker**: small superscript red "U" via `li.ug-import::after` in `style.css`. Views set the class when `_source === 'ug'` (a flag `_registerBundle` stamps on synthetic artist/song objects). Used in letter-browse, all three search-result frames, and songbook-detail rows.
- **Back-link**: `views/artist.js` derives the effective letter from the artist name's first char when `letter === null`, so "T → Townes → tilbake" returns to T, not to Sangbøker.

**Shipped `private-bundle.json` is intentionally absent** (gitignored, see `da00fbb`). The plumbing is intact (`loadPrivateBundle` handles 404 → null) so we can ship a curated demo bundle in the future. The old "Tommy's personal 253-tab library auto-injected into every visitor's localStorage" UX is gone.

**Other UG markup**: `[ch]X[/ch]` and `[tab]…[/tab]` are stripped in both pipelines (`crawler/build-private-bundle.py` → `clean_body`; `catalog.js` → `cleanUgBody` at write-time + one-pass migration on `loadLocalImports`). PLAN.md backlog: revisit later as styling hints.

**Legacy Python pipeline** (cross-check / build-bundle, kept though no longer the primary path):

- `crawler/private/` (gitignored) — local-only place to keep raw UG exports + their LLM-enriched counterparts. Used to be committed "for transparency" while the repo was private, but went out when the repo went public — personal UG libraries are copyright grey-area and shouldn't ship.
- `crawler/enrich-private.py` — LLM-enriches private tabs into `crawler/private/ug-enrichment.json` (STRICT_SUFFIX prompt + JSON salvage + `--retry-thin`). Useful as a QA cross-check against the on-device model.
- `crawler/build-private-bundle.py` — emits `private-bundle.json` if/when we ship a demo bundle. Gitignored output; `git add -f` to commit deliberately.

## Cross-device sync via Google Drive

Optional, opt-in sync of UG imports across devices via the user's own Google Drive `appDataFolder` (scope `drive.appdata` — hidden per-app folder, invisible in normal Drive UI, no verification required since it's a non-sensitive scope). We host nothing; Google handles auth + storage + propagation.

**Setup (one-time per deployment)**: see `DRIVE-SETUP.md` for the Google Cloud Console steps. Client ID is hardcoded in `drive-sync.js`'s `DRIVE_CONFIG` (public info, no secret). Each app origin (localhost dev, tabtabtab.no, etc.) must be added as an "Authorized JavaScript origin" in the same OAuth client config.

**Flow**:
- **Sign-in**: `views/songbooks.js` Sangbøker view has the only sign-in surface. First click lazy-loads GIS, opens a popup, stores the access token in `localStorage['tabtabtab:drive:token:v1']` (with `expires_at`).
- **Auto-push during enrichment**: `enrich-queue.js`'s loop calls `drivePushIfChanged(getLocalImports)` after each successful `addLocalImport`. The `pushIfChanged` helper in `drive-sync.js` coalesces bursts into at-most-one-in-flight + at-most-one-pending — when network is faster than enrichment it's effectively per-tab, when slower it auto-batches. Failures log and move on; the next tab triggers another push that catches up.
- **Auto-pull on app boot**: `app.js`'s `main()` fires `syncRoundTrip()` in the background after the initial render if `driveIsSignedIn()`. Completes silently or `console.warn`'s on failure. Triggers a state nudge (`setState({ ...getState() })`) so the visible view re-renders with any pulled-in entries.
- **Manual "Sync nå"** (Sangbøker UI): calls the same exported `syncRoundTrip()` in `app.js`. Surfaces errors visibly for diagnosis (unlike the silent auto-pull).
- **Round-trip semantics** (`syncRoundTrip`): pull → `mergeLocalImports(local, remote)` → `replaceLocalImports(merged)` → `rebuildIndex()` → push merged back. Merge is per-tab union with newer `imported_at` winning on collision; songs/artists spread-union with remote winning ties. Monotonic — can only add data, never lose any.

**Trade-offs (deliberate, v1)**:
- Auto-push does NOT pre-pull. Two devices importing different tabs concurrently → last pusher's data ends up on Drive after that moment. The next manual Sync nå (or app reload) on the other device merges everything back via the round-trip. Race window is rare; merge is idempotent.
- Each push carries the full `localImports` payload (no diffs, no compression). ~14 kB / 15 tabs in practice. Revisit if libraries grow past ~1 MB.
- File-id is cached in `localStorage['tabtabtab:drive:file-id:v1']` to skip a list-files lookup on every push. If the Drive file is deleted out-of-band, the next PATCH 404s — manual fix: clear that key in DevTools.

- `README.md` — outward-facing project intro (motivations + search journey).
- `PLAN.md` — design log and backlog (canonical spec).
- `BENCHMARKING.md` — cloud-LLM evaluation notes (currently parked for future private-tabs enrichment work).
- `docs/screenshots/` — canonical location for README-referenced screenshots; `0X-*.png` are the production set.

## iOS chord-wrap: defensive shotgun in place (2026-05-17)

The chord-wrap pipeline carries five overlapping defenses against iOS Safari's stale-layout-after-rotation behavior. They were landed together as a shotgun fix on 2026-05-16/17 after a debugging session confirmed they make the wrap correct on a real iPhone. We did not bisect to find the minimum-necessary subset — the iOS user count for this app is effectively zero, so the overkill is acceptable. If anyone ever wants to minimize, the PLAN.md "Narrow down exactly what is needed for iOS" entry has the bisection plan.

Don't remove any of these without re-testing on a physical iPhone:

1. `chord-wrap.js` `measureMaxCols` reads `preEl.parentElement.clientWidth` instead of `preEl.clientWidth`. The pre shrinks to its post-wrap content (flex auto-basis in portrait, `width: max-content` in bleed mode), so reading its own clientWidth creates a feedback loop — a wider viewport never gets a bigger budget. **Fundamental: PC needs it too.**
2. `chord-wrap.js` `measureMaxCols` copies font *longhands* (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `letterSpacing`) to the temp measurement span instead of the `cs.font` shorthand, because WebKit returns `""` for the shorthand when any longhand isn't explicit, which would silently fall through to body's proportional font and skew `charW`.
3. `views/tab.js` `wireChordWrap` schedules `apply()` *four times* per viewport event: immediate, double-RAF, 250 ms, 600 ms. iOS fires `resize` mid-rotation-animation before viewport / media-query / font metrics have settled; spreading retries across this window means at least one measurement lands after Safari catches up. Each `apply()` re-reads fresh dimensions, so duplicates are idempotent and cheap.
4. `views/tab.js` `wireChordWrap` listens to `orientationchange` and `visualViewport.resize` in addition to `window.resize`. Both are more reliable than plain `resize` on iOS for rotation, and `visualViewport` additionally covers browser-chrome show/hide.
5. `views/tab.js` `wireTextSize` defers `applyWrap()` to the next `requestAnimationFrame` after writing `--tab-text-scale`, so `getComputedStyle`'s font metrics have reflowed before `charW` is measured. Without this, A−/zoom-out is asymmetric on iOS — wrap doesn't widen when the budget grows.

**Surfaced-but-parked:** `wrapPlain` hard-breaks lines that have no whitespace within `maxCols` (long URLs split mid-token: `Tumbleweed_C` / `onnection`). Better behavior: pass such lines through unchanged and let `overflow-x: auto` on `.tab-body` handle them with horizontal scroll. Low priority.

**SW-cache double-bind during iteration:** because `APP_VERSION` only bumps at commit, every speculative shell-file change during local debugging needs a manual `version.js` bump to reach iOS (see "Cache-busting + service worker" above). The 2026-05-16/17 session bumped manually four times before landing the final state.

## Working artifacts outside the repo

- `C:\Users\<user>\catalog_a.json` and `nortabs_crawl_test.py` — early unpaginated samples; superseded by `crawler/crawl.py`. Keep for historical reference only.
- `C:\Users\<user>\nortabs_a.json`, `nortabs_artist.json`, `nortabs_tab.json` — raw single-endpoint samples for verifying API shape.
