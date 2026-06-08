# TabTabTab - Plan

Canonical product and architecture plan for the current application.

Historical experiments and superseded deployment designs live under
`archive/`. Operational details for a coding session live in `CLAUDE.md`.
The focused open backlog is `TODO.md`; settled non-features are in
`TODONT.md`.

## Current status

TabTabTab is a shipped static, offline-first guitar-tab web app.

- **Live:** <https://nortabs.netlify.app>
- **Hosting:** Netlify, automatically deployed from `main`
- **Custom domain:** `tabtabtab.no` DNS is pending
- **Stack:** vanilla JavaScript modules, HTML, and CSS
- **Build:** none
- **Production backend:** none
- **Primary data:** committed `catalog.json` plus `enrichment.json`
- **Private data:** browser storage, optionally synced to the user's own
  Google Drive `appDataFolder`

The app currently supports:

- Browse by letter -> artist -> song -> tab
- Semantic and lyric search over the nortabs.net catalog
- Favorites and named songbooks
- URL-based songbook sharing for catalog tabs
- Standalone HTML songbook export
- Auto-scroll playback with persistent per-tab speed/start settings
- Mobile chord-over-lyric wrapping and chord diagrams
- Installable PWA/offline use
- Ultimate Guitar bookmark export and local import
- On-device UG enrichment through Chrome's Prompt API / Gemini Nano
- Literal UG import in browsers without the Prompt API
- Optional cross-device UG-library sync through the user's Google Drive

## Why this exists

Two motivations drive the project.

### The browser as the platform

> If it can be done in JavaScript, it shall be done in JavaScript.

This is a creative constraint, not a general rule for software development.
The shipped app deliberately has no framework, bundler, transpiler, or
application backend. The browser loads the catalog, builds the search index,
stores user state, renders tabs, performs on-device LLM enrichment, exports
standalone songbooks, and optionally talks directly to Google Drive.

### Search beyond titles

The central product is search, not catalog browsing. The goal is to find a
song from partial lyrics, spelling variants, place associations, genre,
occasion, mood, or an imprecise remembered "vibe".

The catalog is enriched offline by LLMs, then searched entirely in the
browser through hand-tuned inverted indexes. User-imported UG tabs can receive
the same kind of semantic metadata locally through Gemini Nano.

## Binding decisions

| Area | Decision |
|---|---|
| App architecture | Static SPA using browser-native ES modules |
| Hosting | Netlify from `main`; no production app server |
| State | Small central `state.js` store plus focused module-local state |
| Routing | Hash routes, preserving shareable static-host URLs |
| Catalog delivery | Full committed catalog loaded once and indexed in memory |
| Upstream API | Only the scheduled crawler calls nortabs.net |
| User storage | Songbooks/preferences in localStorage |
| Private imports | Local browser storage; Drive sync is optional and opt-in |
| User-content hosting | TabTabTab does not host imported tab bodies |
| UG enrichment | On-device Prompt API where available; literal import elsewhere |
| Dependencies | No npm dependency or build pipeline for the shipped app |
| Privacy | No analytics, tracking, first-party cookies, or account system |

Do not reintroduce the archived cloud LLM proxy as the default UG path. Chrome
on-device enrichment replaced it on May 27, 2026. The proxy experiments remain
useful research for a possible non-Chrome fallback, but are not active product
architecture.

## Architecture

### Browser application

- `index.html` - app shell and search surface
- `app.js` - startup, view dispatch, search rebuild, enrichment status, sync
- `state.js` - small pub/sub state store
- `router.js` - hash parser and route dispatch
- `catalog.js` - catalog loading, ID lookup maps, local imports, merge helpers
- `search.js` - indexes, ranking, aliases, fuzzy suggestion
- `storage.js` - songbooks, favorites, playback, chord mode, text scale
- `views/` - one render module per route
- `chord-wrap.js` - alignment-preserving mobile wrapping
- `chord-data.js` / `chord-diagrams.js` - fingerings and SVG diagrams
- `playback.js` - countdown and requestAnimationFrame auto-scroll
- `exporter.js` - standalone HTML songbook export
- `enrich-ondevice.js` - Prompt API session and tolerant JSON recovery
- `enrich-queue.js` - navigation-independent background enrichment
- `drive-sync.js` - GIS OAuth and Drive `appDataFolder` byte transport
- `sw.js` - versioned app-shell and runtime caching

### Data tooling

- `crawler/crawl.py` - resumable stdlib crawler
- `crawler/enrich.py` - Claude CLI catalog enrichment
- `crawler/enrich-gpt.py` - OpenAI API catalog enrichment
- `crawler/merge-enrichment.py` - per-letter merge
- `crawler/generate-wordcloud.py` - decorative/search-metadata wordcloud
- `.github/workflows/crawl.yml` - incremental Mon-Sat, full crawl Sunday

Only the crawler talks to nortabs.net's API. The production browser app loads
the committed static data and never proxies upstream requests.

## Catalog

Format:

```json
{
  "crawled_at": "2026-05-26T06:58:32Z",
  "letters": {
    "a": {
      "artists": [
        {
          "id": 1,
          "name": "Artist",
          "songs": [
            {
              "id": 2,
              "name": "Song",
              "tabs": [
                {
                  "id": 3,
                  "body": "...",
                  "chordnames": ["Am", "C", "G"]
                }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

Current measured corpus on June 6, 2026:

- 39 letter/digit buckets
- 1,215 artists
- 7,072 songs
- 7,669 tabs
- 222 songs with no tabs
- `catalog.json`: 24,573,073 bytes raw
- `enrichment.json`: 6,518,870 bytes raw
- Enrichment coverage: 99.7% of artists and 99.8% of songs

The incremental crawler compares artist/song/tab counts and reuses unchanged
content. The Sunday full crawl catches body edits and same-count replacements
that count-based incremental detection cannot see.

## Search

Search is built once at startup from the catalog, enrichment sidecar, and
local imports.

### Indexes

- Artist name plus artist enrichment
- Song/artist names plus artist and song enrichment
- Exact folded tokens from tab bodies
- IDF maps for each index

### Query behavior

1. Fold Norwegian characters and common ASCII spellings.
2. Tokenize terms of at least two characters.
3. Treat one-to-three-token searches as exploratory.
4. Treat four-or-more-token searches as lyric/phrase searches.
5. Prefix-expand name/enrichment indexes only for exploratory searches.
6. Use exact-token body matches with IDF weighting in both modes.
7. Propagate the strongest tab-body evidence to its song.
8. Use `MAX`, not `SUM`, across multiple tabs of the same song.
9. Boost user-curated songbook matches.
10. Separately boost UG imports without double-counting the synthetic UG
    songbook as user curation.
11. Offer Damerau-Levenshtein correction only for a single-token total miss.
12. Always offer live nortabs.net and Ultimate Guitar fall-through links.

Hand-maintained pseudo-artist tags and geographical token aliases supplement
the LLM metadata where small explicit rules are more reliable.

### Open search work

- Build a permanent regression query set before changing ranking further.
- Consider clipping combined body plus enrichment scores when one song wins
  on both signals.
- Validate `key_phrases` against source bodies during catalog enrichment.
- Consider lightweight typeahead from the existing sorted token array.

## Ultimate Guitar imports

The active flow is:

1. The userscript in `userscripts/` runs on the user's UG bookmarks page.
2. It fetches bookmarked tab pages with `GM.xmlHttpRequest`.
3. It downloads `tabtabtab-ug-import-YYYY-MM-DD.json`.
4. The user drops that file on `#/import/ug`.
5. Chrome Prompt API environments enrich each tab locally.
6. Other browsers import immediately with literal artist/title/body search.
7. Imports are registered as normal artist/song/tab objects with string IDs.
8. Search is rebuilt and the synthetic `Mine UG-importer` songbook appears.

Imported entries are first-class in letter browse, search, tab rendering,
songbooks, playback, chord diagrams, and HTML export.

The app strips lossless UG `[ch]` and `[tab]` wrappers when storing a tab.
Personal UG libraries are never committed or shipped with the public app.

## On-device enrichment

`enrich-ondevice.js` uses the browser `LanguageModel` Prompt API.

- A base session contains the schema and enrichment instructions.
- Each tab runs in a cloned session to avoid context accumulation.
- Output recovery handles reasoning tags, code fences, balanced JSON blocks,
  JSON5 syntax, truncated arrays/objects, and one retry.
- `enrich-queue.js` owns the sequential batch so route changes do not cancel it.
- Gemini Nano download progress is shown in a global status pill.
- App startup best-effort prefetches the model when appropriate.

This is intentionally a capability-enhanced path. The core import remains
usable without Chrome or an on-device model.

## Google Drive sync

Drive sync is optional. The app requests only:

```text
https://www.googleapis.com/auth/drive.appdata
```

The imported library is stored as one JSON file in the user's hidden
`appDataFolder`. Google Identity Services is loaded only after explicit
sign-in.

Current round trip:

1. Pull remote bundle.
2. Merge with local bundle.
3. Replace local state.
4. Rebuild search.
5. Push the merged bundle.

Background enrichment also coalesces Drive pushes into at most one in-flight
and one pending write.

### Required correctness work

The tab merge already chooses the newer `imported_at` value per tab. Artist
and song structures currently use shallow remote-wins merging, which can lose
different `song_ids` or `tab_ids` added concurrently on separate devices.

Before describing the merge as strictly monotonic, merge artist `song_ids`
and song `tab_ids` by union and retain the newest enrichment deliberately.
Add deterministic tests for this contract.

## Songbooks and sharing

- `Favoritter` is the permanent default songbook.
- User-created songbooks are ordered lists of tab IDs.
- `Mine UG-importer` is synthesized from the local-import store and cannot be
  renamed, deleted, reordered, or manually edited.
- Catalog-only songbooks can be shared compactly through the URL hash.
- A shared songbook containing private string IDs currently cannot transport
  the private body to another user's installation; recipients see unresolved
  entries.
- Standalone HTML export includes resolved bodies and therefore works for
  private tabs.

Near-term sharing work is limited to clearer private-tab placeholders.
Inlining private bodies into share URLs remains a later design question.

## Playback and rendering

- Auto-scroll starts after a five-second countdown.
- The user's current/manual scroll position always wins.
- Speed and preferred start position persist per tab.
- Chord-over-lyric wrapping keeps chord and lyric columns aligned.
- Five overlapping iOS rotation/font defenses are intentionally retained.
- Chord diagrams default to open `visegrep` fingerings and can switch to
  barre alternatives where available.
- Chord-shaped tokens are styled in chord lines and inline `[Chord]` notation.

The known long-token wrap issue remains parked: a line with no whitespace may
be hard-broken instead of left to horizontal overflow.

## Deployment and caching

Netlify serves the static repository contents. There is no compilation or
deployment artifact generation.

`version.js` contains `APP_VERSION`. The pre-commit hook rewrites it to the
current epoch and stages it. The value is used for:

- Query-string cache busting of catalog/enrichment fetches
- Service-worker cache names
- Deleting obsolete caches after activation

The service worker precaches the app shell and opportunistically caches large
JSON responses after first use.

## Roadmap

### Active / likely next

- Correct recursive Drive merge semantics and cover them with deterministic
  tests.
- Add a small zero-dependency regression harness for pure logic:
  search ranking, routing, chord wrapping, storage migration, and merging.
- Improve shared-songbook placeholders for private tabs.
- Capo-first `visegrep` transposition.
- Export to basic ChordPro.

### Deferred

- **Personal Word / `.docx` imports are explicitly deferred.**
  They are not part of the active or near-term roadmap.
- Multi-song Word document splitting is also deferred.
- A unified multi-format import screen is deferred with Word import.
- IndexedDB migration is deferred until measured localStorage pressure or
  another large import source makes it necessary.
- Full-Fat single-file export containing the entire app and catalog.
- Dark mode.
- Automated playback-duration discovery and smart scroll start.
- Anonymous crowd-derived playback defaults.
- Backend accounts, collaborative libraries, or hosted user content.
- Non-Chrome cloud-LLM fallback for imported-tab semantic enrichment.

### Explicitly not planned

See `TODONT.md`. In particular:

- No production app backend
- No analytics/tracking
- No npm build stack
- No CDN dependencies
- No shipped personal UG library
- No drag-and-drop songbook reorder replacing touch-friendly buttons

## Resolved API facts

- `/tabs/tab?id={id}` returns tab text in `body`, not `content`.
- `chordnames` is a JSON array.
- `/collections/browse?sw={letter}` requires explicit pagination with
  `limit` (maximum 50) and zero-indexed `page`.
- Browse artist records expose `tab_count` and `song_count`.
- Collection song records expose `tab_count`.
- Count-based incremental crawling cannot detect a remove-plus-add swap with
  unchanged total count; the weekly full crawl covers it.

## Historical references

- `archive/README.md` explains the superseded cloud-proxy era.
- `archive/NOLLAMA-DEPLOY-PLAN.md` contains the abandoned Azure/nollama
  deployment design.
- `archive/BENCHMARKING.md` and `archive/bench/` preserve cloud model research.
- `archive/DEV-TO-PLAN.md` is an abandoned standalone Copilot CLI competition
  concept, not the current application plan.
- The Flet app at `C:\devel\python\nortabs-app` remains a frozen UX/data-shape
  reference and is not kept in sync.
