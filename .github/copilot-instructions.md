# NorTabs Web Copilot Instructions

## Project shape

- Static single-page app in vanilla JavaScript modules + HTML + CSS.
- `index.html` loads `app.js` as a module and mounts a single `#app` root.
- The shipped web app never calls nortabs.net. Browser data comes from `catalog.json`, optional `enrichment.json`, and optional `private-bundle.json`. Only `crawler/` talks to the upstream API.
- Read `PLAN.md` and `CLAUDE.md` before changing architecture, data flow, or crawler behavior.

## Build, test, and lint

- No build, test, or lint tooling exists in this repo.
- No single-test command exists either.
- Manual smoke test: `python -m http.server 8765` from the repo root, then open `http://localhost:8765/`.

## Architecture

- `app.js` loads catalog/enrichment/private data, builds the search index, mounts the search bar, starts routing, and registers the service worker.
- `state.js` is the only state store; use `setState()`/`subscribe()` instead of mutating shared objects.
- `router.js` parses hash routes and preserves `sb` when navigating from songbooks.
- `catalog.js` loads `catalog.json` once, appends `?v=${APP_VERSION}`, and indexes artist/song/tab lookups for both catalog and private-bundle entries.
- `search.js` builds three indexes (artist/song/body), applies Norwegian folding, token aliases, pseudo-artist tags, IDF weighting, and private-bundle search data.
- `views/*.js` are pure `render(state, root)` modules; `tab.js` also has teardown logic for bindings.
- `storage.js` owns localStorage for songbooks, favorites, playback, chord mode, and text scale.
- `playback.js` implements the countdown + requestAnimationFrame auto-scroll loop; user scroll position always wins.
- `version.js` and `sw.js` work together for cache busting via `APP_VERSION`.
- `crawler/` is stdlib Python tooling for crawl/enrichment/private-bundle generation; it is not shipped to the browser.

## Key conventions

- Keep the offline-first boundary intact: browser code must not reach out to nortabs.net.
- Catalog IDs are numeric; private/UG IDs can be strings like `ug-12345`. Preserve that in routing and lookup code.
- `fav` is the special favorites songbook and is treated differently from user-created songbooks.
- Shared songbooks use hash URLs like `#/share?name=Foo&ids=123,456`; importing creates local storage state.
- Search folding treats `ø/o/oe`, `æ/a/ae`, and `å/a/aa` as equivalent, and body matches are exact-token hits weighted by IDF.
- Preserve the flat module layout and kebab-case filenames.
- Do not edit `version.js` by hand; `.githooks/pre-commit` rewrites it on commit.
- If shell files seem stale locally, suspect service-worker cache state and `APP_VERSION` first.
