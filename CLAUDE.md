# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read PLAN.md first

`PLAN.md` is the canonical spec for this project — architecture, stack decisions, data sizes, roadmap phases, and open questions. Read it before doing anything substantive. This file does not duplicate its contents; it only adds the operational context a fresh session would otherwise miss.

## Repository state

This is a **greenfield project**. As of this writing the repo contains only `PLAN.md` and a sample `catalog.json` (letter-A crawl, ~159 KB). There is no code yet, no `package.json`, no build step, no test runner, no lint config. Do not invent build/test commands — there are none until someone writes them.

When Phase 1 begins, the stack is **vanilla JS modules + HTML + CSS, no bundler**. Opening `index.html` in a browser is the dev loop. Local serving (when needed for ES module CORS) is `python -m http.server` from the repo root — do not introduce node tooling without asking.

## Architecture (when files start existing)

Per PLAN.md the intended module layout is flat:

- `index.html` — single `<div id="app">`, loads `app.js` as a module.
- `state.js` — central state + `getState()` / `setState(patch)` / `subscribe(fn)`. Re-render the current view on change.
- `router.js` — parses `location.hash`, dispatches to a view, updates state.
- `catalog.js` — **in-memory catalog accessor**. Loads `catalog.json` once, indexes by id. It does **not** hit nortabs.net. (Deliberately *not* called `api.js` — the shipped web app makes no network calls; only the Phase-3 Python crawler does.)
- `views/` — one file per screen, each exports `render(state, root)`.
- `crawler/` (Phase 3) — Python; the **only** code in the project that calls nortabs.net.

The hard architectural rule: **the shipped web app never makes network calls to nortabs.net's API.** All browsing is served from the embedded `catalog.json`. Only the nightly GitHub Action crawler talks to the upstream API. Preserve this boundary — it's the whole reason the project exists.

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

## Cache-busting

`version.js` exports `APP_VERSION` (Unix epoch). `catalog.js` appends `?v=${APP_VERSION}` to its `catalog.json` and `enrichment.json` fetches so every commit produces a unique cache-bust token.

**Auto-bumped on commit** by `.githooks/pre-commit` (Python one-liner). Activate the hook once per clone:

```sh
git config core.hooksPath .githooks
```

After that, every commit bumps `version.js` automatically. Don't edit manually — the hook will overwrite. Skip with `git commit --no-verify` for the rare commit that shouldn't change deployed cache state.

## Crawler

`crawler/crawl.py` — zero-dep stdlib Python (urllib). Args: `--letters`, `--delay-ms` (default 100), `--user-agent`, `--checkpoint-dir` (default `crawler/data/`), `--out` (default `catalog.json`), `--merge-only`, `--force`. Per-letter checkpoint files in `crawler/data/<letter>.json` survive interruptions; the merge step assembles `catalog.json` from whatever checkpoints exist. Default delay 100 ms is "obviously polite"; full A-Z + 0-9 crawl is ~3 hours at 200 ms, ~9 MB gzipped catalog.

## iOS chord-wrap: defensive shotgun in place (2026-05-17)

The chord-wrap pipeline carries five overlapping defenses against iOS Safari's stale-layout-after-rotation behavior. They were landed together as a shotgun fix on 2026-05-16/17 after a debugging session confirmed they make the wrap correct on a real iPhone. We did not bisect to find the minimum-necessary subset — the iOS user count for this app is effectively zero, so the overkill is acceptable. If anyone ever wants to minimize, the PLAN.md "Narrow down exactly what is needed for iOS" entry has the bisection plan.

Don't remove any of these without re-testing on a physical iPhone:

1. `chord-wrap.js` `measureMaxCols` reads `preEl.parentElement.clientWidth` instead of `preEl.clientWidth`. The pre shrinks to its post-wrap content (flex auto-basis in portrait, `width: max-content` in bleed mode), so reading its own clientWidth creates a feedback loop — a wider viewport never gets a bigger budget. **Fundamental: PC needs it too.**
2. `chord-wrap.js` `measureMaxCols` copies font *longhands* (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `letterSpacing`) to the temp measurement span instead of the `cs.font` shorthand, because WebKit returns `""` for the shorthand when any longhand isn't explicit, which would silently fall through to body's proportional font and skew `charW`.
3. `views/tab.js` `wireChordWrap` schedules `apply()` *four times* per viewport event: immediate, double-RAF, 250 ms, 600 ms. iOS fires `resize` mid-rotation-animation before viewport / media-query / font metrics have settled; spreading retries across this window means at least one measurement lands after Safari catches up. Each `apply()` re-reads fresh dimensions, so duplicates are idempotent and cheap.
4. `views/tab.js` `wireChordWrap` listens to `orientationchange` and `visualViewport.resize` in addition to `window.resize`. Both are more reliable than plain `resize` on iOS for rotation, and `visualViewport` additionally covers browser-chrome show/hide.
5. `views/tab.js` `wireTextSize` defers `applyWrap()` to the next `requestAnimationFrame` after writing `--tab-text-scale`, so `getComputedStyle`'s font metrics have reflowed before `charW` is measured. Without this, A−/zoom-out is asymmetric on iOS — wrap doesn't widen when the budget grows.

**Surfaced-but-parked:** `wrapPlain` hard-breaks lines that have no whitespace within `maxCols` (long URLs split mid-token: `Tumbleweed_C` / `onnection`). Better behavior: pass such lines through unchanged and let `overflow-x: auto` on `.tab-body` handle them with horizontal scroll. Low priority.

**SW-cache double-bind during iteration:** because `APP_VERSION` only bumps at commit, every speculative shell-file change during local debugging needs a manual `version.js` bump to reach iOS. PC dev tools usually bypass this via "Disable cache" while DevTools is open; iOS Safari has no such switch and will serve stale cached code until either (a) you commit so `APP_VERSION` bumps, (b) you clear Safari's website data for the host, or (c) you manually `caches.delete()` from the JS console. The 2026-05-16/17 session bumped manually four times before landing the final state. If a code change "works on desktop but not on iOS," suspect SW cache first.

## Working artifacts outside the repo

- `C:\Users\wossn\catalog_a.json` and `nortabs_crawl_test.py` — early unpaginated samples; superseded by `crawler/crawl.py`. Keep for historical reference only.
- `C:\Users\wossn\nortabs_a.json`, `nortabs_artist.json`, `nortabs_tab.json` — raw single-endpoint samples for verifying API shape.
