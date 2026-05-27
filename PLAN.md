# NorTabs Web — Plan

A static, single-page rewrite of `C:\devel\python\nortabs-app` (a Flet Python desktop app for nortabs.net guitar tabs). This repo replaces it — same data source, new platform, with features the original site lacks.

## Why this exists

Two motivations, in order:

**1. A constraint as creative driver.** Someone wrote Windows 95 as a JavaScript emulator running in a browser tab. Reading about that prompted a rule for web apps:

> **If it can be done in JavaScript, it shall be done in JavaScript.**

No bundler, no transpiler, no framework, no backend. Vanilla ES modules + one HTML file + one `<div id="app">`. Open `index.html` in any browser and it works; offline too. The catalog ships as one ~5 MB gzipped JSON embedded in the page. The shipped web app makes zero network calls to nortabs.net — only the nightly crawler does that, and only the server-side crawler runs Python. The goal is to find out how far the "browser is a complete computer" idea goes when taken seriously.

**2. Build a search engine that isn't stupid.** Most search is a substring match with Levenshtein on top. That's fine when you remember the title; it falls apart the moment you want to search by *vibe*. The Flet desktop app that came first (see [`nortabs-app`](C:\devel\python\nortabs-app)) was already obsoleted by nortabs.no's own official app, so the only reason to keep building was: how good can search get when an LLM-generated semantic layer feeds an in-browser inverted index with hand-tuned weighting? See the [Search](#search--current-state-and-journey) section — it's most of what this project actually *is*.

A polite-to-the-API constraint sits underneath both: explicit blessing from the nortabs.net owner, no ads, no tracking, no account, and almost all browsing happens against the pre-crawled static catalog so the live site barely touches their servers.

## Constraints and decisions (already settled)

| Decision | Choice | Why |
|---|---|---|
| Hosting | ~~GitHub Pages (static)~~ → **superseded 2026-05-27**: repo went private (Pages off on free plan), product moves to `tabtabtab.no` served as static files from Tommy's Azure VM. Still static, still no app-backend — just a different static host. See Phase 2.5 "SUPERSEDED" + the on-device decision. | Free, fast CDN was the original draw; private-repo + own-domain won out. |
| Stack | **Vanilla JS + HTML + CSS, no build step** | App has ~6 views and tiny state. Frameworks are overhead, not leverage. Open `index.html` → it works. |
| State | Single `state.js` module | Centralized, predictable. Re-render current view on state change. |
| Routing | `window.location.hash` + one `hashchange` listener | Shareable URLs, works under Pages' SPA limitations. |
| Data delivery | **Embed full catalog as one `catalog.json`** | Per-letter buckets: `{ crawled_at, letters: { a: {artists: [...]}, ... } }`. Whole site ~9 MB gzipped at current crawl (see below). One download → site is offline-capable, instant. |
| Favorites | `localStorage` | Simple, ~5 MB headroom is plenty. |
| Songbooks | Named groups of favorites, **shareable via URL hash** (`#/songbook?ids=12,847,3320`) | No backend needed for sharing — it's the killer feature versus nortabs.no. |
| Crawler | Scheduled GitHub Action — **incremental Mon-Sat + full Sun**, Python stdlib only | Daily incremental diffs `/collections/browse` (which carries `tab_count` + `song_count` per artist) against the existing catalog and only fetches changed artists/songs/tabs. Typical no-change night: ~80 reqs / ~1 min. Sunday full crawl: ~15 600 reqs at 200 ms ≈ 52 min, catches tab-body edits and same-count tab swaps that incremental can't see. Per-letter checkpoints in `crawler/data/<letter>.json` make crawls resumable. Commits updated `catalog.json` back to the repo. |
| API access pattern | Crawler only. **The shipped web app never hits nortabs.net for data.** Search fall-through is the only browser→nortabs touchpoint, and it just opens nortabs.net in a new tab (no embedding, no CORS). | Reduces load on the owner's API; site stays fast and offline-capable. |
| Search fall-through | When local search returns 0 hits, show a "Søk live på nortabs.net" link that opens `https://nortabs.net/?q=...` in a new tab. No embedding, no proxy. | Honest UX; preserves offline-first; zero CORS/infra cost. |
| LLM enrichment | Sidecar `enrichment.json` produced by a **Windows Task Scheduler job at 06:00 Oslo on Tommy's machine**, not in GitHub Actions. `scheduled-enrich.ps1` pulls latest catalog, calls `run-enrich.ps1` (Claude via `claude -p --model sonnet`), commits + pushes the sidecar. Optional parallel path: `run-enrich-parallel.ps1` adds an OpenAI API worker on a disjoint letter set. | Keeps API keys + LLM bills out of CI; the scheduler uses Tommy's existing personal subscriptions. Crawler stays simple and free. |
| CORS | Not relevant for the running app (no live API calls). Only the crawler hits the API, server-to-server. | — |

## Measured data sizes (full A-Z + 0-9 crawl, 2026-05-14)

- **1202 artists, 6876 songs, 7435 tabs** across all 36 letters.
- `catalog.json`: **22.7 MB raw, 4.6 MB gzipped** (~4.9× compression on chord/lyric text).
- Pagination: `/collections/browse?sw=X` caps at 50 results; use `&page=N` (0-indexed) until empty.
- Empty letter buckets in catalog: 0, 2-8, q, x (just present as `{artists: []}`). Letter 1 has 4 artists, 9 has 4 artists, y has 8 artists, z has 5 artists. Largest: S (155 artists), T (115).
- Earlier reference numbers in `C:\Users\wossn\catalog_a.json` (159 KB, unpaginated 10-artist sample) and PLAN-doc estimates of ~2500 artists / ~13 k tabs / ~9 MB gzipped are now obsolete — actual catalog is roughly half the estimated size.

## Reference: the Python app

When in doubt about UX or data flow, read the existing app at `C:\devel\python\nortabs-app`. Pointers:

- **Overall GUI flow + architecture diagram**: `README.md` (sections "Detailed Flow" and "Component Responsibilities"). This is the canonical view of artist → song → tab → tab-content navigation, favorites flow, auto-scroll playback, and the back/forward history stack. The web app should mirror this UX.
- **API shape**: `api.py` (`NorTabsAPI` class). All endpoints, query params, and observed response shapes are documented in docstrings. The crawler in this repo should match this exactly.
- **View-by-view UI**: `views/views_main.py`, `views_collections.py`, `views_songs.py`, `views_tabs.py`, `views_favorites.py`, `views_search.py`. Each is one screen.
- **Favorites data shape**: `favorites.py` (`FavoritesManager`). Useful as a starting point for the localStorage schema — though we'll likely add songbook grouping.
- **History/back-forward stack pattern**: `navigation.py`. Concept transfers cleanly to hash routing.
- **Auto-scroll playback**: `app.py` — `start_playback`, `start_preparation_countdown`, `start_auto_scroll`. The 5-second countdown UX should carry over.

The Python app does **not** need to be kept in sync — it's a frozen reference.

## Search — current state and journey

Search is the star player. Everything else (browse, songbooks, auto-scroll, exports) is plumbing around it. The current implementation lives entirely in [`search.js`](search.js) — about 360 lines, zero dependencies, runs entirely in the browser against the embedded catalog + enrichment.

### Current capabilities

**Indexes**, built once at page load:

- `_artistIndex: Map<token, Set<artistId>>` — fed by artist name + LLM `search_text` + (for pseudo-artists) hand-curated tag string + token-alias expansions.
- `_songIndex: Map<token, Set<songId>>` — fed by artist name + artist enrichment + song name + song enrichment.
- `_bodyIndex: Map<token, Set<tabId>>` — fed by tab body (the chord-over-lyric text).
- `_artistIdf / _songIdf / _bodyIdf` — IDF weights, `log((total+1)/(df+1))` clamped to `[0.05, 1.0]`. Distinctive tokens (`tjene`, `kroppen`, `fairytale`) win; filler tokens (`jeg`, `vil`, `på`) lose.

**Query pipeline**, in order:

1. **Fold** the query: lowercase, then `ø→o`, `æ→a`, `å→a`, then bigram aliases `oe→o`, `ae→a`, `aa→a`, then NFD-normalize and strip remaining diacritics. `Bjørn`, `bjoern`, `bjorn`, `BJØRN` collapse to the same token.
2. **Tokenize and classify**: ≤3 tokens → *exploratory*, 4+ tokens → *phrase*. Phrase mode disables the name indexes entirely, so the pasted lyric `jeg vil tjene penger på kroppen min` lands on the song via body match alone — `jeg`/`vil`/`på` can no longer drag every artist named "Vilde" into the song frame.
3. **Match**:
   - Short queries get prefix-expanded against `_allTokens` (sorted, binary search). Exact match scores ×1.0, prefix match scores ×0.6. Artist hits weighted ×10 × `artistIdf`, song hits ×5 × `songIdf`.
   - Body matches are always exact, weighted by `bodyIdf × 4`.
4. **Songbook boost**: any tab in the user's local songbooks gets a **×4 score multiplier**. The user's own taste re-weights everything.
5. **Body → song propagation**: the best body match per song boosts that song's score by ×3 of its max tab score. A lyric query surfaces the *song* on the songs frame, not just an isolated tab number.
6. **Multi-tab dedup**: body propagation uses `MAX` across the song's tabs, not `SUM`. A popular song with five user-uploaded tabs no longer auto-wins over a niche song with one tab.
7. **Three result frames**: Songs → Artists → Lyrics, twenty entries each, sorted by `(score desc, hits desc)`.
8. **"Mente du …?"**: only when zero hits *and* the query is a single token. Damerau-Levenshtein distance ≤ 2 against `_allTokens`, early-exit at distance 1. Multi-token zero-hit suggestions are usually worse than nothing.
9. **Fall-through**: a `Søk live på nortabs.net` link is always rendered at the bottom of the result list (zero-hit *or* with-hits), opening `https://nortabs.net/?q=...` in a new tab. Honest UX, no embedding, no CORS.

### Two hand-curated layers on top of the LLM enrichment

Most semantic metadata is LLM-generated and lives in `enrichment.json`. Two small data tables in `search.js` sit on top:

- **`PSEUDO_ARTIST_TAGS`** — eight nortabs.net "artists" are actually thematic buckets (Lovsanger, Julesanger, Barnesanger, Fotballsanger, Salmer, 17. mai-sanger, Sørlandsviser, Folkeviser). LLM enrichment treats them as obscure artists and produces thin tags. Each gets a hand-picked synonym string instead, so `jul`, `advent`, `gospel`, `kirke`, `tilbedelse`, `kystkultur`, `fedreland` etc. all resolve. Cutoff: ≥7 songs per bucket. Children inherit the tags through the existing artist-enrichment path.
- **`TOKEN_ALIASES`** — equivalence groups for tokens that mean the same place. `[trondheim, trondhjem, tronder, tronderrock, trondelag, nidaros]` collapse into one search class; same for Oslo/Kristiania/Christiania, Bergen/bergensk/bergenser, Stavanger/siddis. Members must be written in folded form. Append as gaps surface.

Both are small, append-only data tables. No plumbing, no migration step.

### The LLM enrichment pipeline

`enrichment.json` carries the semantic layer that makes "search by vibe" work. Per-artist fields: `country`, `region`, `era`, `genre[]`, `notable`, `similar[]`, `search_text`. Per-song fields: `language`, `themes[]`, `mood[]`, `occasion[]`, `alt_titles{no,en}`, `key_phrases[]`, `search_text`. The `search_text` is a flat lowercase keyword blob that the index actually consumes — the other fields are there so a human (or future feature) can see the structured reasoning.

Two implementations:

- **`crawler/enrich.py`** — local Claude via `claude -p --model sonnet`. Quota-aware (reads `~/.claude/quota-data.json`). Wrapper `run-enrich.ps1` sleeps through 5-hour Max resets, resumable letter-by-letter.
- **`crawler/enrich-gpt.py`** — OpenAI API variant, concurrent in-flight requests via ThreadPoolExecutor.

Both write to per-letter files (`enrichment/<letter>.json`) under file locks so they can run in parallel against disjoint letter sets. The default split is Claude `a–m`, OpenAI `n–9`; `merge-enrichment.py` assembles the per-letter files into `enrichment.json` at the end.

### Journey: what worked, what failed

The repo's git log reads like a search-tuning diary. Notable stops:

| Commit | Change | Why |
|---|---|---|
| (initial) | Inverted index + exact match + prefix expansion + Damerau-Levenshtein fuzzy + Norwegian diacritic folding | Baseline. Felt good on simple queries, terrible on quoted lyrics. |
| `5716980` | Enrich quota-awareness | Claude-Max 5h resets stopped serial enrichment mid-letter. `run-enrich.ps1` reads quota-data.json and sleeps through resets. |
| `b43ef05`, `be9ad42` | Add OpenAI variant via the `openai` SDK | Second LLM lets us run parallel + cross-check. |
| `303c689` | Split prompt into stable prefix + per-entry suffix | Prompt caching cut input-token cost on long runs. |
| `7c940a4`, `18d391a` | Refactor enrichment to per-letter files + locks | Required for safe parallel writes; also made partial enrichments resumable. |
| `2ffe873` | Parallel enrichment: cross-check + reverse + merge | Run each LLM on the other's letters → diff. Surfaces hallucinations (one model claims certainty where the other admits ignorance) and genuinely ambiguous catalog entries. |
| `40ec4cb` | Concurrent in-flight requests in `enrich-gpt.py` (ThreadPool) | Make OpenAI runs an order of magnitude faster than serial. |
| `110fb3f` | Graceful Ctrl+C + content-filter handling | Long unattended runs need to interrupt cleanly. |
| `90ebb69` | Body search: IDF weighting + exact-match only | **Big one.** Body prefix expansion was the worst noise source: chord-over-lyric text contains thousands of 2-3 char prefixes. Switched to exact-only on bodies, plus IDF weighting on all three indexes so `tjene`/`kroppen` dominate `jeg`/`vil`/`på`. |
| `a6c9cc0` | Phrase mode + multi-tab dedup + Hjem-clears-search | Even with IDF, 4+ token queries dragged artists into the song frame via name index. Fix was structural: phrase queries skip name indexes entirely. Same commit: `MAX` body score per song, not `SUM`. |
| `7e18b62` | Always show "Søk live på nortabs.net" at bottom of results | Users want the live-search second-opinion button even when local results exist, not only on zero-hit. |
| `ce687e3` | Pseudo-artist tag search | Discovered that some "artists" are curated thematic buckets. Hand-picked synonym strings replace the LLM's thin output for those eight. |
| `71f45f7` | Token aliases | `tronder` was missing songs tagged `trondheim`. A 4-line data table covers the common cases; LLM doesn't need to be exhaustive about every transliteration. |

What was tried and ripped out:

- **Prefix expansion on body tokens.** Killed in `90ebb69`. Body text contains every short prefix imaginable; prefix matching turned every body token into a noise generator.
- **`SUM` body scores across a song's tabs.** Killed in `a6c9cc0`. Multi-upload-popular songs were drowning niche songs with stronger actual matches.
- **"Mente du …?" on multi-token queries.** Single-token only now. Damerau-Levenshtein on `jeg vil tjeen pegnen` produces nonsense suggestions — better to show nothing than wrong.
- **Showing the live-search button only on zero results.** Always visible now.
- **Single-LLM enrichment.** Claude alone produced gaps; OpenAI alone produced different gaps. Cross-check + reverse runs are how the catalog reached usable coverage.

### Open search questions

- **Re-ranking the songs frame when both body match and song enrichment fire on the same song.** Current behavior sums; might want to clip or take a logarithm so a song that wins on both signals doesn't completely starve nearby contenders.
- **Per-tab body weighting by tab-type.** The catalog distinguishes "chords", "tab", "bass", etc. A lyric phrase match probably means more when it's in a "chords" tab (always has lyrics) than in a "tab" tab (might be instrumental). Currently all tab types are treated equally.
- **Multi-pass enrichment for `key_phrases` quality.** LLMs occasionally hallucinate phrases that don't appear in the body. A regex check + retry-with-stricter-prompt pass would tighten this.
- **Search history / typeahead.** Not yet built. The folded-token sorted array (`_allTokens`) is half the data structure already; surfacing it as a suggestion list is small work.

## Roadmap

### Phase 1 — Local UI shell (current focus)
Goal: a static page that loads `catalog.json` (letter A) and lets you click through artist → song → tab → tab body. No polish, no styling beyond legible.

Tasks:
1. Copy `C:\Users\wossn\catalog_a.json` → `catalog.json` in this repo.
2. Scaffold:
   - `index.html` — single root `<div id="app">`, loads `app.js` as a module.
   - `state.js` — central state object (current view, current letter, current artist/song/tab, favorites, songbooks, history). Exposes `getState()`, `setState(patch)`, and a `subscribe(fn)` for re-render.
   - `router.js` — parses `location.hash`, dispatches to view, updates state on navigation.
   - `catalog.js` — in-memory catalog accessor (loads `catalog.json` once, indexes by id; no network calls to nortabs.net).
   - `views/` — one file per screen: `letter-index.js`, `artist.js`, `song.js`, `tab.js`, `favorites.js`, `songbook.js`. Each exports a `render(state, root)`.
   - `app.js` — wires router + state + views, mounts on `<div id="app">`.
   - `style.css` — minimal, readable.
3. Implement letter-A end-to-end browsing. Hash URLs:
   - `#/` — letter index (A-Z + 0-9). Only "A" works.
   - `#/letter/a` — artists for A.
   - `#/artist/:id` — songs for artist.
   - `#/song/:id` — tabs for song.
   - `#/tab/:id` — tab body.

### Phase 2 — Differentiating features
1. **Search**: see the [Search — current state and journey](#search--current-state-and-journey) section above. That's the star player; everything else is plumbing around it.
2. **Favorites & Songbooks**: see dedicated section below.
3. **Auto-scroll playback**: port the 5-second countdown + smooth scroll from `app.py`. `requestAnimationFrame`-driven.

### Favorites and songbooks (extended scope)

Concept: a **songbook** is a named, ordered collection of tabs. "Favorites" is just the default songbook ("Favoritter") — same data model, special slot in UI.

- Storage: `localStorage`, namespaced `nortabs:songbooks:v1`. Shape:
  ```json
  {
    "songbooks": [
      { "id": "fav", "name": "Favoritter", "created_at": "...", "tab_ids": [2783, 6127, ...] },
      { "id": "sommerleir-2026", "name": "Sommerleir 2026", "tab_ids": [...] }
    ]
  }
  ```
- A tab can live in multiple songbooks.
- UI: heart icon on tab view → quick-add to "Favoritter"; "+ Legg til i sangbok" → picker for other songbooks (create new from same dialog).
- **Sharing without backend**: `#/songbook/shared?name=Sommerleir+2026&ids=2783,6127,5675` — the URL *is* the share. Recipient opens it, songbook hydrates from URL params, then optionally "Lagre til mine sangbøker" persists locally. No auth, no server, no shortener. This is the killer feature versus nortabs.no.
- **Search weighting**: tabs in any of the user's local songbooks get a large score boost. Effectively: "if I've bookmarked Bjørn Eidsvåg, his name should win over a less-known same-letter artist."
- Future (Phase 4+ maybe): if we later add a backend for discovery/listing other people's public songbooks, the URL-hash share continues to work for private collections.

### Phase 2.5 — SUPERSEDED 2026-05-27: UG enrichment moves on-device (Chrome-only)

**BINDING DECISION (2026-05-27): UG-import enrichment runs ON-DEVICE in the browser via Chrome's built-in Prompt API (Gemini Nano). It is Google-Chrome-only, going forward.** The thin cloud proxy below was the *pre-Chrome-AI* plan; it is no longer the primary path for UG enrichment.

**What changed**: Chrome shipped the built-in Prompt API (`LanguageModel` global, Gemini Nano on-device) in stable (Chrome 148 verified on Tommy's machine 2026-05-27). This is NOT a network call — it's an on-device model — so the entire premise that justified the proxy ("the browser can't call cloud LLMs, CORS blocks it, the proxy is not optional") is void for Chrome users. Validated end-to-end:

- `LanguageModel.availability()` → `available` after one-time provisioning (flags `#prompt-api-for-gemini-nano` + `#optimization-guide-on-device-model=BypassPerfRequirement`, then download the "Optimization Guide On Device Model" component via `chrome://components`).
- Tested on 2 English UG tabs (Tecumseh Valley, Let Her Go). **Semantic-layer quality matches the cloud models** (DeepSeek-Flash et al.): `search_text` / `themes` / `mood` / `key_phrases` were accurate and `key_phrases` came back verbatim-identical to the cloud baseline. ~9-10 s per song on an RTX 5090.
- Create with `expectedInputs`/`expectedOutputs: [{type:'text', languages:['en']}]` (the `outputLanguage` key is not recognized; the language warning fires without the `expected*` form).
- **`display_suppress` is dropped** (it was only aesthetic anyway). Gemini Nano over-suppressed line ranges (counting line indices is beyond a ~3-4B on-device model — it returned `[0..19]` on Tecumseh, eating the title + first verse). If we ever revisit it, prepend line numbers to the body so the model *reads* indices instead of *counting* them — that trick would help the cloud models too (they hallucinated out-of-range indices).

**Why Chrome-only is acceptable**: it matches the project's "browser is a complete computer" ethos — zero backend, zero cost, zero CORS, zero API key, works offline. Non-Chrome users still get full *literal* search over their UG imports (artist/title/lyric/chord text); they just don't get the LLM semantic layer in-browser. That asymmetry is the same kind already accepted in the UG-import backlog ("Search asymmetry without enrichment"). A cloud fallback for non-Chrome users is possible later but is explicitly NOT being built now — Chrome-only is the committed scope.

**Ripple effects** (downstream of this decision, to reconcile): the cloud-proxy work (now in `archive/proxy/`, `archive/NOLLAMA-DEPLOY-PLAN.md`, `archive/bench/`) was building the now-superseded path. It is not deleted — it informed the decision and may return as the non-Chrome fallback — but it is no longer on the critical path. `nollama.no` no longer needs to host a UG-enrichment proxy. The public-catalog enrichment pipeline (`crawler/enrich.py`, Claude/OpenAI nightly) is unaffected — that's a separate concern.

**CLI enrichment pipeline retained as QA cross-check** (not the product path): `crawler/enrich-private.py` + `crawler/build-private-bundle.py` are NOT archived, even though on-device enrichment is the product path. They survive deliberately as a **quality cross-check source** — the principle is *never trust a single LLM*. On-device Gemini Nano output gets cross-checked against the CLI pipeline's cloud/Claude output (the same cross-check discipline that produced the public catalog's `enrichment.json` via Claude+GPT). When the on-device `#/import/ug` client flow ships, these CLI tools stay as the QA/reference path, not the user-facing one.

**Next near-term piece — cross-device sync via Google Drive `appDataFolder`** (elevated to near-term 2026-05-27): now that enrichment runs on-device, a user's imported + enriched UG library lives in their browser's localStorage/IndexedDB — which is *per-device*. The moment in-browser enrichment works (it does), the obvious next want is "take my tabs with me" across laptop / phone / desktop.

The clean, still-serverless answer: **Google sign-in (OAuth) + store the user's private-tabs + enrichment JSON in Google Drive's hidden `appDataFolder`.**

- `appDataFolder` is Drive's special per-app hidden folder (OAuth scope `drive.appdata`) — invisible in the user's normal Drive UI, and each app can only see its own. Minimal scope, easy for a user to trust, and Google's verification for it is lighter than full-Drive access.
- The copyrighted UG content lives in the **user's own Google Drive**, never our infrastructure — exactly the "NorTabs never stores user-content bodies" legal posture. We host nothing but the static app shell; Google handles auth + storage + cross-device sync.
- Result: a fully serverless, per-user-private, cross-device-synced UG library — **static app + on-device AI (enrichment) + the user's own Drive (sync). No backend of ours anywhere in the loop.**

This was sketched in "Phase 5+ — Long-term vision" (Google Drive as the auth + storage layer) as a *far-future* item — but only because back then enrichment needed a server, so Drive-sync was bundled into the big-backend story. On-device enrichment removes that server dependency, so the Drive-sync piece **detaches from Phase 5+ and becomes the near-term priority**: it's the last thing standing between "works on one device" and "works everywhere, privately, with zero infra of ours."

Scope notes for when it's built:
- Auth: Google Identity Services (GIS) token flow in-browser; request only `drive.appdata`. A pure-client app may not need any server-side token exchange (TBD when built).
- Storage shape: the `nortabs:private-tabs:v1` + `nortabs:private-enrichment:v1` payloads serialize to one (or a few) JSON files in `appDataFolder`. Read on login, write on change (debounced). Conflict handling: last-write-wins is likely fine for single-user-multi-device; revisit if it bites.
- Offline-first stays intact: localStorage/IndexedDB remains the working copy, Drive is the sync backstop. Anonymous/offline use never touches Google.

---

**[Historical — the pre-Chrome-AI proxy plan, retained for context]**

A minimal Node 24 backend on Tommy's Azure VM that lets the browser-side UG-import flow do real LLM-enrichment without ever shipping API keys to the client. This is the *thin* form of the Phase 5+ architecture — single endpoint, no auth, no persistence beyond a shared metadata cache. Magic-link auth + per-user rate limits get added later if/when traffic demands.

**Why now, why this shape**: in-browser UG-import is the main differentiator beyond the shipped NorTabs catalog. The browser can't call cloud LLMs directly — every cloud LLM API blocks browser-origin via CORS deliberately (verified on Ollama Cloud 2026-05-17; Mimo V2 Pro and Claude/OpenAI/Anthropic share the same posture). Local Ollama works only for the user themselves on the machine they're sitting at; WebLLM is a 1-2 GB download with quality below Mimo/Claude. The thin proxy is therefore not optional, only its scope is.

**Architecture principle (binding)**: bodies are transient; only metadata is persisted server-side. Server logs `(artist, song, model, cache_hit, ms_taken, token_count)` — never the body. Same legal posture as Phase 5+.

**Noise suppression — LLM tags, JS suppresses** (binding, decided 2026-05-26 after enrich-bench v1, architecture pivoted same day from regex-based to LLM-tagged):

> Motivating quote: *"I want the tab, not the tab author's personal life story."*

UG tab bodies frequently contain noise that isn't part of the song itself: UG `#PLEASE NOTE` legal preambles, USENET-era email headers (the Tecumseh Valley export in our sample data has a full 1993 header preserved verbatim through UG → Tampermonkey → JSON), tabber commentary, capo/tuning notes, tabber signatures (`Set8`-style), and other free-form prose. We want this hidden in the web UI and ignored by the LLM during enrichment.

Original sketch was a regex-based stripper shared by both surfaces. Pivoted because **the LLM is genuinely smarter than any regex we'd write**, and we're already calling it per tab during enrichment. So: let the LLM do the smart noise-detection work *once*, capture its judgement as metadata in the enrichment output, then let dumb JS apply that metadata at render time. Zero regex maintenance on either side.

**Data shape — extend the enrichment output with one field**:

```jsonc
{
  "search_text": "...",
  "themes": [...],
  // ... all existing fields ...
  "key_phrases": [...],
  "display_suppress": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  //                  ^ 0-indexed line numbers in body.split("\n") to hide
}
```

**Prompt instruction added to `SONG_PROMPT`** (in `enrich.py` / `proxy/enrich.js` system message):

> Additionally, scan the body for lines that are *not part of the song itself* — UG legal preambles (`#PLEASE NOTE` blocks), USENET email headers, tabber commentary, capo/tuning notes, author signatures. Return their 0-indexed line numbers (in `body.split("\n")`) in a `display_suppress` array. Include only lines that should be hidden from a guitarist reading the tab. **Do NOT include** chord-only lines, `[tab]...[/tab]` fingering diagrams, or section markers like `[Verse]` / `[Chorus]` — those ARE part of the tab.

**Web UI consumer — 5 lines in `views/tab.js`**:

```js
const suppress = new Set(enrichment?.display_suppress || []);
const visible = body.split('\n').filter((_, i) => !suppress.has(i)).join('\n');
```

Missing `display_suppress` field (old enrichment record, non-UG tab) → show all lines. Backwards-compatible by construction. No migration step.

**LLM consumer**: the LLM ALSO benefits from the same insight, but differently. Two complementary moves:

1. **Drop the `body[:1200]` truncation cap** — Ollama Cloud is flat-rate, so token cost is no longer a constraint. Full body in the prompt = LLM sees the *actual lyrics* (which were getting truncated out under the old cap when blurb consumed the first ~400 chars). Validated empirically by enrich-bench v1: DeepSeek-Pro returned 0 `key_phrases` on Passenger's *Let Her Go* because the truncated 1200-char body was mostly chord intro + tabber notes, not actual lyrics.
2. **Add a prompt instruction** asking the LLM to focus on lyric content when deriving `themes` / `mood` / `key_phrases`, ignoring the same noise categories listed for `display_suppress`. The LLM is doing two related jobs in one call now: (a) tag the noise, (b) enrich based on the non-noise.

**Bench v2 update (2026-05-27)** — context size mattered more than model choice: with the truncation cap dropped, `deepseek-v4-flash:cloud` jumped from worst-in-v1 (80% kp hit-rate, 3 invented lyric phrases on *Let Her Go*) to best-in-v2 (100% kp hit-rate, 100% `display_suppress` accuracy on gold-standard tests, 34.8 s mean latency — 27% faster than Nemotron). Same model, same prompt; only the input context changed. Confirms the architectural bet: **context size mattered more than model choice for this task**. Default upstream switched from Nemotron to DeepSeek-Flash in `NOLLAMA-DEPLOY-PLAN.md` Phase 3; Nemotron retained as fallback. The `display_suppress` field worked correctly across *all four* tested models — the LLM-tags-JS-suppresses architecture is robust to model choice, not specific to any one. (Note: Flash is a reasoning-variant; Ollama Cloud bills ~3-4× the visible output as "completion tokens" for hidden internal reasoning. Flat-rate sub absorbs it. The `raw_content` we receive is tight and clean.)

**Why this is the right shape**:

- **LLM does the smart work once**, server-side at enrichment time. Cached in the enrichment record, served forever to all clients.
- **JS does the dumb work many times**, client-side at render. One `Array.filter` per render. Cheap.
- **No regex maintenance burden** on either side. Iterating on "what counts as blurb" = update the prompt and re-enrich. No client release needed.
- **Legal posture unchanged** — `display_suppress` is metadata about the body, not the body itself. The cache contract (PLAN.md Phase 2.5 "Architecture principle") still holds.
- **Single source of truth** — same LLM call produces both the enrichment and the suppression hints, so they can never drift.

**Trade-offs / edge cases**:

- **Line numbering is fragile**: server and client must agree on `\n`-split as canonical. The existing `private-bundle.json` shape preserves body verbatim, so this should be rock-solid out of the box — but worth a defensive guard (`String(body).split('\n')` on both sides, no CRLF normalization between).
- **LLM hallucinates indices** (gives a number out of range) → JS `filter((_, i) => !suppress.has(i))` simply ignores indices that don't match any line. Cheap defense.
- **LLM suppresses too aggressively** (hides real lyrics) → caught at bench / smoke-test time. If it becomes a real problem, prompt can be tightened or a per-tab override stored in localStorage.
- **Sanity cap** worth considering: if LLM returns `display_suppress` covering >50% of the body, log a warning. Probably wrong.

**Implementation shape** (pinned as follow-on after the deploy plan):

- Update `enrich.py` `SONG_PROMPT` to add the `display_suppress` field + instruction. Same prompt is reused verbatim by `proxy/enrich.js` and `crawler/enrich-bench.py` via existing import paths.
- Drop the `body[:800]` / `body[:1200]` truncation in `enrich-private.py` and `enrich-bench.py`. Send full body.
- Update `views/tab.js` body-rendering to read `enrichment.display_suppress` and filter lines before passing to `wrapTabBody()`.
- Re-run enrich-bench v2 to verify Nemotron correctly identifies blurb on Tecumseh Valley (golden test) and produces empty `display_suppress` on Jolene (no-blurb baseline). Re-evaluate if any model degrades on existing metrics due to the larger context.

**Cache invalidation policy when the prompt changes**: when `SONG_PROMPT` evolves (e.g. when we add `display_suppress`), the clean move is to wipe `enrichment-cache.json` and re-enrich everything against Nemotron. ~8 s/tab × 253 tabs ≈ 30 min per full reset; flat-rate Ollama Cloud sub absorbs the cost. Backwards-compat handling of missing fields (e.g. `display_suppress`) stays as a *defensive fallback* in the JS render path (covers the brief window between prompt-update and re-enrich completion), but is not a hard constraint — we own the cache and can bulldoze it whenever it serves us.

**Quality control via Claude-Code CLI** — a single full-corpus pass, *not* a recurring schedule. After a prompt iteration + wipe-and-re-enrich (per the cache invalidation policy above), kick off an overnight `claude -p` run that walks every cache entry and rates Nemotron's output. The pass takes hours over hundreds of tabs, runs unattended once, surfaces a report — does not repeat nightly. Triggered by prompt changes, not by the clock. Pattern lifted from the catalog enrichment's cross-check approach (commit `2ffe873`, "Cross-check across models"); same idea, retargeted at the UG-cache. Catches drift: prompt regressions, model-specific blind spots, the occasional Nemotron hallucination that the bench's 5-tab sample didn't surface. Not at PoC time — pinned so we don't reinvent it later.

**Supersedes existing CLAUDE.md note**: the UG-import section says cosmetic noise is "hidden at render-time via regex filters in the view, not stripped at import — too varied to detect safely without losing real content." That guidance is replaced by LLM-tagged suppression. Update CLAUDE.md when this lands.

**Endpoint contract**:
- `POST /enrich-tab` — body `{artist, song, body, chordnames?}` → returns `{enrichment, cache: 'hit' | 'miss', model_used}`.
- Server hashes `(artist, normalized(song))` to derive the cache key, checks the JSON cache, returns cached enrichment or calls LLM and stores result. Per-tab not bulk; browser orchestrates parallelism (3-4 in-flight via `Promise.all`-batches).
- CORS allowlist: `https://aweussom.github.io` (prod) + `http://localhost:8000` (dev). Origin-checked in middleware. Not open-CORS.

**Cache deduplication is per song, not per prompt-or-model**. Wonderwall enriched via Mimo and Wonderwall enriched via Ollama Cloud hash to the same key; the 1000th user hits cache regardless of which model produced the original entry. Trade-off: prompt experimentation during development needs an `X-Force-Refresh: 1` header or manual `DELETE /cache/<key>` to bypass. Acceptable cost.

**Cache storage: plain JSON file** (decided 2026-05-17). One human-readable file (`enrichment-cache.json`), atomic tmp+rename writes on every put/del, full in-memory mirror at startup. Chosen over SQLite (which the first sketch used) for *portability*: easy to inspect, diff, scp between hosts, or bundle into the static web app if we ever want to ship pre-warmed enrichment with the site. Survives LLM swaps unchanged — the key is `hash(artist, normalized(song))`, so an entry written by Qwen3.6 is reused as-is when we later swap in Mimo or DeepSeek. Dataset is small enough (target single-digit thousands of entries) that synchronous write-through is irrelevant.

**Stack — modern minimal Node 24**:
- ESM modules (`"type": "module"` in `package.json`), no bundler, no transpiler, no TypeScript build step.
- Built-in `node:http`, `node:fs`, `fetch`, `crypto` (for `sha256` cache keys).
- Zero npm dependencies. Cache is a JSON file written through `node:fs`; no native build step.
- Node 24 (LTS 2025-10+) chosen specifically to avoid GitHub Actions deprecation warnings on older versions.
- Folder `proxy/` in this repo. Shared logic (`normalize.js`, `hash-key.js`) lives in `proxy/shared/` and is imported verbatim by both server and client — single source of truth for the cache key so server and client can never drift.

**Model selection**: server-side env var (`PROXY_MODEL`, `PROXY_API_BASE`, `PROXY_API_KEY`). One-line swap between Mimo V2 Pro ($16/mo, ~unlimited credits for this workload), Ollama Cloud (insane free quota for the relevant Deepseek-class models), and local Ollama (Tommy's RTX 5090 + `qwen3.6:latest`, zero marginal cost). A/B-test quality without touching client. **Validated 2026-05-17**: local Qwen3.6 produces schema-compliant JSON for English UG tabs end-to-end (cold-call latency ~24 s, ~3.85 k tokens per song, cache hit returns instantly). Occasional factual ding (e.g. attributed Tecumseh Valley to John Prine instead of Townes Van Zandt) is the expected mid-frontier-model wrongness BENCHMARKING.md predicted — doesn't break parseability or `key_phrases` accuracy.

**Language scope** (settled 2026-05-17): the proxy enriches **English content only**. UG bookmarks are ~99.9% English in practice; users who want Norwegian-language tabs are served by the public NorTabs catalog and its existing Claude/OpenAI nightly enrichment pipeline (`crawler/enrich.py` + `crawler/enrich-gpt.py`), which is already paid for via Tommy's personal Max + API subs. This collapses two follow-ons: (a) `proxy/enrich.js` SYSTEM_PROMPT no longer asks for cross-language synonyms — tighter prompt, cleaner output, less work for a "pretty good, not fantastic" model like Qwen3.6; (b) BENCHMARKING.md's "make-or-break Norwegian-language quality" criterion does not apply to this path. If/when a future architecture wants cloud-LLM enrichment for the public catalog itself (replacing the nightly pipeline), that criterion comes back; for the UG-import proxy, it does not.

**Quality target** (settled 2026-05-17): "better than anyone else, preferably at no cost." The reference quality bar is UG's own search (which has no semantic/vibe layer at all), not Claude/GPT-4 frontier output. Local Qwen3.6 on Tommy's RTX 5090 clears that bar at $0 marginal cost. Don't tune for "perfect" — tune for "obviously useful, free at the margin."

**Client-side surface**:
- New route `#/import/ug` (existing `#/songbook/ug-import-main` untouched).
- User drops UG-JSON → app iterates tabs → calls `POST /enrich-tab` 3-4 in parallel → live progress bar → results land in `nortabs:private-enrichment:v1` (localStorage, with IDB migration when payload exceeds ~5 MB — see Personal Library Import for that cutover).
- `search.js` indexer grafts private-enrichment into the same indexes that consume `enrichment.json` (matches "Tommy-personal escape hatch" already spec'd in the UG-import backlog entry).

**Deployment — local-first, then VM**:
- PoC runs on Tommy's Windows machine (PowerShell 7) for the first weeks. `node proxy/server.js` with a stub mode that returns canned enrichment when no API key is configured, so the server / cache / browser flow can be developed end-to-end without burning credits.
- Production deploy: **Tommy's existing Azure free-tier VM**, on the same Tailscale network as the RTX 5090 workstation. Two upstream-LLM layouts that fall out of this:
  1. **Hosted LLM (Mimo, Ollama Cloud, DeepSeek)** — proxy runs on Azure VM and calls a public LLM endpoint over the internet. Simple, no dependency on Tommy's workstation being awake. Cost = whichever provider's bill applies.
  2. **Workstation LLM (RTX 5090 + Qwen3.6 via Ollama)** — proxy on Azure VM calls `http://<workstation-tailscale-ip>:11434/v1/chat/completions` over the Tailscale tunnel. Zero LLM cost at the margin, but enrichment is only available when the workstation is awake + Ollama is running. Tailscale handles auth + encryption + NAT transparently, so this is genuinely one env var (`PROXY_API_BASE`) away from the hosted layout.
  
  Production deploy mechanics: `systemd` unit on the Azure VM, reverse-proxied via nginx for HTTPS termination on a subdomain (e.g. `enrich.nortabs.<domain>`). Single Node process. No Docker, no orchestration. The JSON cache file lives on the VM's disk; backups are `scp enrichment-cache.json` to wherever Tommy wants.

**Known deferred items** (pinned here so we don't forget):
- Magic-link auth + per-user rate limit — add when shared-key cost or abuse becomes a real concern. Not at PoC time.
- Brotli on responses — small payload (~few KB enrichment JSON), gzip via nginx is enough for prod, no need at PoC.
- Observability beyond `console.log` — add when prod traffic is non-zero.

**Out of scope for Phase 2.5**: enrichment of the shipped public catalog (still produced by `crawler/enrich.py` on Tommy's machine against Claude/GPT subscriptions). The proxy serves user-imported private tabs only. Public-catalog enrichment continues to flow into `enrichment.json`; private-tab enrichment flows into `nortabs:private-enrichment:v1` client-side and the shared JSON cache (`enrichment-cache.json`) server-side.

### Phase 3 — Full crawler + automation
1. `crawler/crawl.py` — Python script that mirrors `nortabs-app/api.py` endpoints to produce `catalog.json`. Politeness delay configurable (default 100 ms). Outputs deterministic JSON (sorted keys) so git diffs are minimal. Supports `--incremental`, which loads the existing `catalog.json`, seeds per-letter checkpoints from it (so a partial run still merges into a complete catalog), then diffs `/collections/browse` against the previous state and only fetches changed artists/songs/tabs. Empties existing tab metadata is reused for unchanged tab IDs — only new tab IDs trigger a `/tabs/tab` body fetch.
2. `.github/workflows/crawl.yml` — two cron triggers in one workflow: **Mon-Sat 03:00 UTC** runs `--incremental` (typical ~1 min); **Sun 03:00 UTC** runs a full crawl (~52 min) to catch tab-body edits and same-count tab swaps that incremental can't detect. Plus `workflow_dispatch` with a `mode` choice for manual rebuilds. Single `concurrency: catalog-crawl` group prevents overlap. Bumps `version.js` (cache-bust epoch) in the same commit when `catalog.json` changes. Requires the repo's "Workflow permissions" to be set to "Read and write" so `GITHUB_TOKEN` can push.
3. `.github/workflows/pages.yml` — deploy to GitHub Pages on push to `main`.

### Phase 5+ — Long-term vision (no concrete plans yet)

**Multi-user / band-sharing with real backend.** Eventually: login + persistent shared storage so a band or kulturskole-gruppe can pool their private tabs (UG imports, Word docs, ChordPro) into a single shared library. Each member's personal tabs flow into the group's collective bookshelf. Songbooks become collaborative.

This is a *deliberate* departure from the "no infra" decision settled in Phase 1. It only happens when:
1. The single-user offline app has proved its core value.
2. Sharing-via-URL-hash has shown its limits in practice (probably around the multi-user-private-tabs case where shared songbook URLs can't transport bodies).
3. A clear group of users actually wants this — not just hypothetically.

**Architecture principle: NorTabs never stores user-content bodies — only LLM-output (enrichment metadata) is cached server-side.** The clean legal/architectural split that emerged from the UG-import design (see "Search asymmetry without enrichment" in the UG section above):

- **User content (chord/lyric bodies for UG/Word/ChordPro imports)**: lives ONLY in the user's Google Drive (the auth + storage layer). NorTabs' backend receives bodies *transiently* during enrichment processing — request comes in, LLM analyzes it, body is dropped, only the derived metadata (`genre`, `themes`, `mood`, `era`, `key_phrases`, etc.) is returned and cached. NorTabs is a *processor*, not a *distributor* — which keeps the project on the right side of TONO / publisher rights claims that apply to redistributing copyrighted song bodies.
- **Enrichment metadata cache**: keyed by `hash(artist + normalized(song))`, shared across users. The thousandth person to import "Wonderwall" hits the cache from the first import. Metadata isn't the work; it's *about* the work — Wikipedia-style fair-use territory.

**Backend implementation: a minimal token-authenticated API on Tommy's existing Azure VM** (preferred over earlier candidate options Supabase/Firebase/Cloudflare Worker, and explicitly *not* GitHub Actions). The Azure VM already exists at zero marginal cost; the surface area is small (single HTTP endpoint, body→enrichment, cache lookup, LLM passthrough), and Tommy controls the LLM API key and rate-limit policy directly. Auth piggybacks on Google OAuth (the same flow that grants Drive access — server-side validates the bearer token). Single endpoint, single responsibility.

Earlier-considered alternatives and why they didn't win:
- **GitHub Actions + repository_dispatch**: 64 KB payload limit forces awkward "upload body to intermediate URL, trigger workflow with URL, workflow fetches" flow. Workflow logs may leak bodies if logging-hygiene slips. Three moving parts where one would do.
- **Cloudflare Worker**: clean and stateless, but limits push hard past free tier (~$5/mo + LLM costs). Tommy's Azure VM is already paid for and idle.
- **Supabase/Firebase**: oriented around full-CRUD apps with managed auth — overshoots when the actual need is "POST body → GET enrichment". Their auth integration is an advantage we don't need (Drive OAuth handles it).

Anonymous/offline-only usage continues to work without ever touching the API — Drive auth is opt-in for users who want cross-device sync + enrichment for their imports.

**Log hygiene is a hard rule:** the enrichment endpoint *never* logs body content, only `(artist, song)` pairs and tag results. Stack traces redacted via wrapper. Tested before deploy.

### Phase 4 — Polish
1. Responsive layout (this needs to work well on a phone in front of a music stand).
2. Dark mode (chord sheets are read for long stretches).
3. Service worker → real PWA, full offline support, "Add to home screen".
4. Open Graph metadata for shared songbook URLs.

## Open questions for future sessions

- Should songbook URLs carry full tab IDs (compact) or a base64-encoded title list (resilient to ID changes upstream)? Probably IDs for v1, fall back to title-match if an ID 404s.
- Some songs in the letter-A crawl returned 0 tabs (47 songs, 52 tabs total — close to 1:1 but a few empties). Worth checking whether `tab_count > 0` is reliable, and whether to filter empty songs from the catalog.

## Backlog / TODO

- **Tolerant JSON parser for LLM output in enrich.py** (✅ implemented): `extract_json()` now does (a) a string-aware balanced `{...}` finder so the first complete top-level object wins regardless of trailing prose or a second emitted object, then (b) falls back from strict `json.loads` to `json5.loads` so unquoted keys / single quotes / trailing commas / comments parse cleanly. `json5` is a local-only dep (`pip install json5`) — never installed on the GitHub Actions crawler or shipped to the browser. The failure mode that motivated this was "Extra data" on Børge Rømma 2026-05-15 — LLM emitted a clean JSON object followed by an apologetic prose paragraph; greedy regex matched everything, `json.loads` choked. Smoke-tested against 8 cases covering trailing prose, two emitted objects, leading prose, braces inside strings, code fences, trailing commas, and unquoted keys.

- **Take direct control of catalog/enrichment compression in the browser** (planned, not yet built):
  - Today: GitHub Pages serves `catalog.json` with HTTP `Content-Encoding: gzip` (~5 MB on the wire). The browser decompresses transparently; JS receives a ~24 MB string and parses to a ~30+ MB object tree in heap. This is fine while [[feedback_perf_over_memory]] holds ("client RAM is not a constraint, optimize for perceived speed"), but worth revisiting if any of these change:
    1. UG/Word/ChordPro private-tab imports start growing heap noticeably.
    2. We want true offline-first via service worker — own-controlled compression on disk simplifies cache management.
    3. Cold-start parse time surfaces as a measurable bottleneck on low-end devices.
  - Three layers we could own ourselves, roughly ordered by cost:
    1. **On-wire: ship `catalog.json.br` (Brotli)**. Build step gzip-compresses or brotli-compresses the catalog after each crawl; the browser fetches the compressed asset directly and uses `DecompressionStream` (native, no library) to inflate. Brotli typically beats gzip by 15-25% on text-heavy JSON. Cost: tiny — one line in the crawler workflow, ~5 lines in `catalog.js`. Wins: removes our dependency on Pages' content-encoding plumbing, smaller bytes on the wire.
    2. **At rest in heap: per-letter compressed buckets**. Keep the catalog as a `Map<letter, Uint8Array>` of compressed letter buckets in memory. When the user navigates to letter `X`, decompress `X`'s bucket lazily into the working set. The "compressed filesystem in browser memory" pattern Tommy remembers — `fflate` (~10 KB minified, streaming inflate) or `pako` (battle-tested) are the obvious libraries; `LZ-string` if we want pure-JS-string in/out for compatibility with `localStorage`. Wins: heap footprint drops by ~5×, and we can fan out lazy decompression across `requestIdleCallback` ticks so home-page render stays fast. Costs: per-letter access is no longer free; needs careful coordination with search-index build (which currently walks the whole catalog at startup).
    3. **Binary format: MessagePack or CBOR instead of JSON**. ~30% smaller than JSON pre-compression, but post-gzip the JSON-vs-binary delta is small because JSON's repetitive structure compresses well already. Probably only worth it as a follow-up to (2), where we want fast random-access deserialization of a single compressed bucket.
  - Likely path: do (1) the moment Pages' gzip handling ever feels insufficient (~half a day of work). Graduate to (2) only when real heap-pressure measurements demand it. Skip (3) unless cold-start parse time becomes a real complaint.
  - Cross-cutting concern: cache-busting (`?v=${APP_VERSION}`) needs to apply to whichever asset(s) we ship, including the per-letter buckets in path (2).

- **Capo-first visegrep transposition** (planned, not yet built):
  - nortabs.net offers per-semitone transposition. That's not what most casual players want — semitone shifts often land in keys like F♯ or C♯ where every other chord becomes a barre, and you've made the song *harder* to play. Tommy's principle, transcribed verbatim: *"Transponering bør IMNHO KUN gå til 'spillbare visegrep'"*.
  - **Capo is the default, strongly hinted; chord-letter shifts only via an "Advanced" toggle.** Default UX presents capo positions that keep the player on open shapes they already know (C, D, E, G, A, Am, Em, Dm). The escape hatch *"Advanced mode → vanlig transponering"* unlocks the per-semitone chord-letter shifts for users who can't (or won't) use a capo, but the default path doesn't expose them.
  - **Example UX**:
    > **Transponer G → A**
    > → *"Sett capo i 2. bånd — spill som G-dur (anbefalt — alt åpent)"*
    > → *"Advanced mode → vanlig transponering"* (unfolds chord-letter shifts at +2 semitones)
  - **Algorithm** (default capo path):
    1. Determine the song's effective key Y (from the chord set, or just from `tab.chordnames`).
    2. For each candidate capo position N (0-7; higher than 7 is impractical and silly-looking):
       - Compute "play as" key X = Y − N semitones.
       - Score X by **% of the song's chords whose transposed equivalent has an open / non-barre fingering** in `chord-data.js`. Likely flag each fingering entry with `visegrep: true | false` rather than infer from `barre`.
    3. Surface the **top 2-3 (N, X) pairs**, not all 12 semitones. Buttons read e.g. *"Capo 3 — spill som D-dur (alt åpent)"* or *"Capo 0 — som vist (1 barré: Hm)"*. The N=0 (no-capo) option is always offered as the "what's on screen" baseline.
    4. **Capo preserves audible pitch.** Capo can only raise pitch, never lower. The capo path is therefore explicitly *"keep the song sounding the same but fingerings simpler"*. Players who genuinely want to *change* audible key (e.g. lower their voice's comfort) take the Advanced-mode path.
  - **UX details**:
    - When user picks a capo+key, the chord-name strings in the tab body and the chord-diagram foldout both re-render with the transposed names. The fingerings stay open-shape.
    - Persist the choice per-tab in localStorage (same store as `getTextScale` / `getPlaybackDuration`) so reopening the tab restores the player's preferred capo position.
    - Advanced-mode toggle is per-user (not per-tab) — once a player turns it on, every tab shows the full per-semitone transpose controls.
  - **First surface already shipped**: the chord-display `vise ↔ barré` toggle wired through `getChordMode`/`setChordMode` in `storage.js`. Chords with both an open visegrep voicing and a barre alternative (currently F, F#m, Bb, Fm, Cm, Hm) flip together when the user clicks the toggle in the chord foldout. When per-semitone transposition lands, the natural design is for it to read the SAME `nortabs:chord-mode` key (or live next to it as a second Advanced-mode flag if we find users want them independent).
  - Builds on the existing `chord-data.js` + `chord-diagrams.js`: the same fingering database that drives the foldout tells us which keys are "playable" for a given song's chord set.

- **Reorder tabs within a songbook**: musicians need to rearrange set lists. Implement up/down arrow buttons next to each tab in the songbook detail view. Don't bother with HTML5 native drag-and-drop — bad on touch, and the music-stand-on-phone use case is touch-first. Vanilla ↑/↓ buttons work everywhere, accessible, ~30 lines of code.

- **Export to ChordPro / other formats**: musicians often want to import songs into ChordPro-aware apps (OnSong, SongBook+, ChordSheetJS-based readers, etc.). Three implementation tiers:
  1. *Trivial*: wrap the body in `{start_of_tab}…{end_of_tab}` ChordPro directives. Preserves chord-over-lyric formatting, accepted by most readers but rendered less prettily than inline syntax.
  2. *Heuristic parser*: detect chord-line-over-lyric-line patterns, emit inline `[Cm]lyric` ChordPro syntax. ~100 lines, hits ~80 % cleanly.
  3. *LLM conversion*: extend `enrich.py` to produce `chordpro_body` per tab, with `chordpro_verified` ∈ {`heuristic`, `llm-high`, `human`}. Same human-in-the-loop pattern as scroll-start-point. ~95 % clean output for ChordPro-compliant readers.
  
  Start with (1) for immediate value; graduate to (3) when `enrich.py` grows per-tab fields (alongside scroll-start-line and YouTube-duration). PDF export is already implicitly available via `window.print()` on the HTML export.

- **Secondary search fall-through to Ultimate Guitar**: when local search has 0 hits, alongside the existing "Søk live på nortabs.net" link, add a "Søk på Ultimate Guitar" link. Format: `https://www.ultimate-guitar.com/search.php?search_type=title&value=<encoded query>`. Useful when nortabs.net also has nothing (Norwegian site, narrower coverage than UG's English-dominant catalog). Same approach: new tab, no embedding, no CORS.

- **Songbook HTML export — Lite shipped, Full Fat planned (eventually replaces Lite)**:
  - **Lite** (`exporter.js`) — static HTML, the songbook's tabs only, TOC + auto-scroll HUD. ~200-500 KB. Works offline, prints cleanly, no app dependency. Email-friendly. *Shipped — to be deprecated once Full Fat is proven.*
  - **Full Fat** — bundles the entire NorTabs app + the full catalog as embedded JSON, with the user-selected songbook pre-loaded as favorites and the URL pre-set to `#/songbook/<id>` so the file opens directly on that songbook. Recipient gets a portable copy of the whole site: full search, browse, all artists. Filesize: ~5 MB (catalog dominates) — under Gmail's 25 MB limit. Recipient can also drop in their own JSON (UG-imported or otherwise) to extend the bundle. Kulturskole/teacher use case: share a baseline with the whole catalog browsable, students add their own tabs on top. A `@media print` block in Full Fat replicates Lite's print output, so once Full Fat lands, Lite becomes redundant.
  
  Implementation notes for Full Fat:
  - Concat all `.js` modules into a single inline `<script type="module">` block (ES modules can't import-relative inside a single HTML file). A small build step in Python/Node walks the import graph.
  - Embed catalog as `<script type="application/json" id="embedded-catalog">…</script>`. Modify `catalog.js`'s `loadCatalog()` to check for that block first and fall back to `fetch('catalog.json')`.
  - Embed `enrichment.json` the same way if/when it exists at build time.
  - Pre-populate `localStorage["nortabs:songbooks:v1"]` with the user-selected songbook so it appears as a favoriter automatically on first open.
  - Add a `#/import` page (or extend `#/songbooks`) so recipient can drop in private-tab JSON files.

- **Personal library import (Word docs + ChordPro)** (planned, not yet built):
  - Tommy has thousands of personal Word documents — both single songs and multi-song "sangbøker" — plus a small set of ChordPro files. These should land in the same `nortabs:private-tabs:v1` store as UG imports, just with different `source` tags.
  - Schema extension: `source` becomes `"ultimate-guitar" | "word" | "chordpro" | "manual"`, with optional `source_filename` for traceability.
  - **ChordPro** files: parse natively (well-defined format — `{title:}`, `{artist:}`, `[Chord]lyric` syntax). ~80 lines of JS. Map directives to our schema, output bodies in chord-over-lyric format for consistency with nortabs/UG entries.
  - **Word documents** (.docx): trickier. Two implementation tiers:
    1. *Single-song doc*: unzip `.docx` (it's a ZIP), extract `word/document.xml`, parse text content. Heuristics to identify title (first heading/large text) and artist (often line 2). Body is the rest as chord-over-lyric. ~150 lines, hits ~70 % cleanly.
    2. *Multi-song "sangbok" doc*: needs splitting. Use LLM (same `enrich.py` pipeline) to: extract raw text, send to Sonnet/Opus, ask "split into songs, identify title + artist for each, return JSON array". Each result becomes a private tab. Costs O(N tokens per document), worth it given Tommy's Max subscription.
  - **Import UX**: extend the planned `#/import` page (currently UG-only) to accept multiple file types. Drag-drop or file picker, sniff format from extension/content, route to the right parser. Show preview before commit ("Found 12 songs in 'sangbok-2024.docx', import all?").
  - Same songbook/search/export integration as UG private tabs — once a tab is in `nortabs:private-tabs:v1`, it's first-class regardless of source.

- **Ultimate Guitar bookmark import** (userscript shipped + validated on real data; NorTabs-side import UI still to build):
  - **Scope: chord/lyric only.** NorTabs is "tekst & akkorder". UG's chord tabs (chord-letters-over-lyrics, the same format as nortabs.net catalog) are the only first-class target. UG also publishes "Tab" (string-by-string fret notation), "Bass", and "Drum" tabs — these are *imported* but tagged via `tab_type`, and the renderer can grey them out or hide them. Proper guitar-tablature rendering is out of scope — someone else can build that on top later. Most useful UG bookmarks are "Chords" type anyway.
  - **Acquisition** (✅ implemented, validated on Tommy's real 259-bookmark UG account: 253 OK / 6 failed): a Tampermonkey/Violentmonkey/Greasemonkey userscript runs on `ultimate-guitar.com/user/mytabs*`. It injects a floating "⬇ Eksporter til NorTabs" button, then on click:
    1. Scrapes the bookmark list from the DOM (`article[isdesktop=true] div` rows yield `{artist, title, link}` — works as of 2026-05).
    2. For each entry, fetches the tab page with `credentials: 'same-origin'` (sends the user's UG session cookies, so paid Official Tabs unlock for Pro/Lifetime subscribers — `omit` left them locked).
    3. Parses `window.UGAPP.store.page.data.tab_view.wiki_tab.content` out of the page's `<div class="js-store" data-content="…">` JSON state.
    4. Decodes HTML entities (UG stores Norwegian/Swedish chars as `&Auml;`, `&oslash;`, `&aring;` etc.) by round-tripping through a throwaway `<textarea>`.
    5. Extracts chord names from inline `[ch]X[/ch]` markup before keeping the rest of the body raw.
    6. Politeness delay of 800 ms between requests. Full 259-bookmark run completes in ~3.5 minutes.
    7. Downloads `nortabs-ug-import-YYYY-MM-DD.json` with `{version, exported_at, ok_count, failed_count, tabs[], failed[]}`.
    
    Gotchas:
    - **UG paginates bookmarks at 50/100/All.** User must set the page-size filter to "All" first so all entries live in the DOM before the script runs — otherwise it only scrapes the visible page.
    - **The remaining ~2 % failure rate is concentrated on UG Official Tabs that publishers protect against scraping more aggressively** (even with valid session cookies for Pro/Lifetime users). These come back with `tab_view.wiki_tab.content` empty. Workaround: bookmark the free `-chords-` community version of those songs instead. Empirically 6 of 259 failed this way — Hotel California, Twist And Shout, Brown Eyed Girl, Down On The Corner, Tennessee Whiskey, Shallow. The pattern: all have `-official-` in the URL, all are big radio-canon songs with active publisher monitoring.
    
    Source: `crawler/userscripts/nortabs-ug-exporter.user.js`. Install in a userscript manager (Tampermonkey, Violentmonkey, or Greasemonkey) — all three accept the same `// ==UserScript==` header format.
  - **Import UX** (still to build): new `#/import` page in the app with `<input type="file">` (drag-drop welcome). User picks the JSON, app parses it, shows a confirm dialog with the count ("Found 253 tabs from Ultimate Guitar. Import all?"), then writes to `localStorage["nortabs:private-tabs:v1"]` and creates/merges the songbook (see Surface below).
  - **Body format**: kept faithfully raw in the JSON export — `[ch]X[/ch]`, `[tab]…[/tab]`, `[Verse]`/`[Chorus]`/`[Bridge]` section markers, UG `#PLEASE NOTE` legal preambles, even USENET-era email headers in old chord charts — all preserved verbatim. The NorTabs *import-side* strips lossless wrapping (`[ch]X[/ch]` → `X`, `[tab]…[/tab]` → contents) to save ~30 % localStorage footprint without semantic loss (chord letter stays in the same column position). Section markers stay. Cosmetic noise (legalese preamble, email headers, `Set8`-style signatures) is hidden at render-time via regex filters in the view, not stripped at import — too varied to detect safely without losing real content.
  - **Surface: songbook model.** Each UG import operation creates or merges into a single `"ug-import-main"` songbook ("Mine UG-importer"). UG-imported tabs are *not* surfaced via the catalog browse-by-letter path — no shadow artists, no badges on artist pages, no song-count integration. Reuses the existing songbook infrastructure (list view, share-via-URL, ×4 search-boost for songbook members). Mental model is one line: *import → ny sangbok*. The user can manually drag UG tabs into other curated songbooks ("Sommerleir 2026") as needed; that's a normal songbook membership operation, not import-side magic.
  - **Storage schema**:
    ```json
    nortabs:private-tabs:v1 → {
      "version": 1,
      "tabs": {
        "ug-12345": {
          "id": "ug-12345",
          "source": "ultimate-guitar",
          "source_url": "https://tabs.ultimate-guitar.com/...",
          "tab_type": "Chords",
          "artist": "Townes Van Zandt",
          "song": "Tecumseh Valley",
          "body": "...chord text (UG wrappers stripped at import)...",
          "chordnames": ["C","G","Am"],
          "imported_at": "2026-05-16T10:02:31Z"
        }
      }
    }
    nortabs:songbooks:v1 → existing schema, with one extra entry:
      { "id": "ug-import-main", "name": "Mine UG-importer", "tab_ids": ["ug-12345", ...] }
    ```
  - **Search index**: at startup, `search.js`'s index builder walks `nortabs:private-tabs:v1` in addition to the catalog, so UG-imported tabs are indexed with the same artist/song/body weighting. Songbook-membership boost (×4) applies automatically since they're in `"ug-import-main"`. ~10 lines of additional indexer code.
  - **Route `#/tab/ug-12345`**: `catalog.js`'s `getTab()` checks `nortabs:private-tabs:v1` when the ID starts with `ug-`. Returns `{tab, song, artist, letter}` shape mirroring the catalog accessor so views need no per-source branching beyond a small "UG"-badge when `source === 'ultimate-guitar'`.
  - **Songbook sharing**: a shared songbook URL containing `ug-12345` IDs is meaningless to recipients — their NorTabs install has no body for that ID. v1: render placeholders with "Privat tab — be avsender om eksport". v2 candidate: inline the tab body in the share URL for private tabs (~7 KB per private tab uncompressed; gzip on the wire helps). Default to v1.
  - **Re-import logic**: identify by `id` (UG tab IDs are stable and globally unique within UG). If `nortabs:songbooks:v1["ug-import-main"]` already exists, merge new tab IDs into its `tab_ids` (preserve user-added tabs, dedupe). For each tab in the new import: if the ID already exists in `private-tabs:v1`, replace the body (preserve songbook memberships in *user-curated* songbooks like "Sommerleir 2026"); if new, add. Tabs removed from UG bookmarks since last import are *not* deleted from NorTabs — orphan-removal would require user intent and is deferred.
  - **Storage budget**: 253 real tabs from Tommy's UG account = 1.1 MB raw JSON, ~770 KB after `[ch]/[tab]`-stripping at import. Roughly 12-22 % of a 5-10 MB localStorage budget. Comfortable headroom for UG alone. Real pressure starts when Word/sangbok-import lands (see Personal Library Import below).
  - **IndexedDB fallback when localStorage fills up** (likely once the Word/sangbok import lands — Tommy has thousands of personal docs at ~10-50 KB each, which easily exceeds 5-10 MB): migrate `nortabs:private-tabs:v1` to IndexedDB. ~50 % of available disk per origin (gigabytes in practice), async API doesn't block the main thread on large reads, structured object stores support indexed lookups. One-shot migration: on first run after the cutover, read the localStorage payload, `put()` each tab into an object store, delete the old key. `getTab()` becomes async — small refactor across `views/tab.js` and the search-index builder (which already walks all private tabs at startup). Songbooks (small, ID-only) stay in localStorage indefinitely. Catalog + enrichment stay shipped JSON — IndexedDB is only for per-user mutable content.
  - **Search asymmetry without enrichment, by design (Phase 1-4).** UG-imported tabs are indexed on artist + song + body text only — they do **not** get the LLM-tagged semantic layer (`country`, `region`, `era`, `genre[]`, `themes[]`, `mood[]`, `occasion[]`, `alt_titles{}`, `key_phrases[]`, `search_text`) that catalog tabs receive. This means search-by-vibe ("trist akustisk", "bryllupssang fra 90-tallet", "kystkultur") *will not find* a user's UG-imported "Wonderwall" even though it's clearly all three of those things. Tabs ARE findable by what the user types literally (artist name, song title, lyric phrases, chord names) — the degradation is specifically on the *associative* search layer that defines NorTabs' core value proposition.
    
    This asymmetry is accepted in Phase 1-4 because the enrichment pipeline (`crawler/enrich.py`) runs on Tommy's personal Claude/OpenAI subscription against the *public* catalog and produces a single shared `enrichment.json` everyone benefits from. Running it per-user against private content would either (a) require each user to set up their own LLM access and run the pipeline locally (high friction, anti-NorTabs ethos of "open and it works"), or (b) require a NorTabs-operated backend that processes user uploads and burns LLM budget per-user (out of scope until Phase 5+).
    
    **Tommy-personal escape hatch (optional Phase 2.5):** `enrich.py` could grow a `--private-tabs nortabs:private-tabs:v1.json` input mode that reads a UG-export JSON, calls Claude on the same per-song-and-per-artist prompts, and writes to a sidecar `nortabs:private-enrichment:v1` localStorage key (or future IndexedDB store). NorTabs' search index loader would check this sidecar at startup and graft its entries into the same indexes the public `enrichment.json` feeds. Asymmetric — only people who run their own pipeline get enriched private tabs — but valid for Tommy + power users.
    
    **Phase 5+ enrichment-as-a-service** (when backend exists, see "Long-term vision"): user uploads UG-export → backend deduplicates against existing enrichment cache (many users share the same UG bookmarks for popular songs) → enriches uncached entries via the same Claude pipeline → returns enriched JSON → app stores it alongside private tabs. Crosses the same legal/licensing line as "shared catalog content" did, but lighter — *metadata* about songs is different from *content* of songs. Probably defensible. Defer the decision until Phase 5+ actually starts.

- **Narrow down exactly what is needed for iOS chord-wrap fix** (parked — shotgun accepted, debug HUD removed 2026-05-17):
  - Five overlapping defenses landed together and verified the bug fixed on a real iPhone. The CLAUDE.md "iOS chord-wrap: defensive shotgun in place" section enumerates them with rationale; not duplicated here. Bisection would identify the minimum-necessary subset (likely 1 + one of {3,4} + 5), but the iOS user count for this app is effectively zero and the shotgun cost is near-nothing, so the work is parked indefinitely.
  - If/when someone does want to minimize: revert one defense at a time on a branch and re-test rotation + A−/A+ on a physical iPhone. The yellow debug HUD has been removed; re-add it (last seen in commit history) for measurement visibility without Safari Web Inspector. (1) is fundamental — PC needs it too — so it always stays.

## Auto-scroll playback duration (planned)

Default playback duration is **180 s** (3 min — radio-edit length). Sing-along guitar tabs are essentially never used with solo-extended versions, so 180 s is the right fallback. Per-tab user adjustments persist and override.

Future enrichment: LLM finds the song on YouTube, reads the video duration, writes to `enrichment.songs[sid]`:
```json
{
  "youtube_url": "...",
  "youtube_duration_s": 247,
  "youtube_verified": "llm-auto" | "needs-human" | "human"
}
```

Auto-accept threshold: **240 s**. LLM-found duration ≤ 240 s → `llm-auto`, used as default. Duration > 240 s → `needs-human`, stored but **not** used as default until a human confirms (same "ask me + save forever" pattern as scroll-start-point). This rules out live versions, extended jams, etc. as accidental defaults.

### Crowd-sourced defaults via anonymous telemetry (Phase 5+)

When the Azure VM API (see "Phase 5+ — Long-term vision") is in place, the browser can ship anonymous playback telemetry — *(tab_id, duration_s)* and *(tab_id, start_y_ratio)* pairs — and the server aggregates them across users. The aggregated values become the bundled defaults in the next deploy cycle, so the most-popular tabs converge to the right values without human curation or LLM guessing.

**Why this is a better signal than LLM-YouTube-lookup for popular tabs:** the LLM only knows the canonical recording's duration. Real players use shorter or longer scroll times depending on their actual performance pace, capo experiments, intro length they actually played through, etc. Crowd-median captures actual playing reality. The LLM path still helps for the long tail where telemetry never accumulates enough samples.

**Telemetry signals worth collecting:**
- `duration_s` (auto-scroll length the user picked)
- `start_y_ratio` (where the user scrolled before hitting play, normalized to body height — see "Auto-scroll scroll-start-point" below; aggregated user position is a better signal than LLM for popular tabs)

**Signals NOT worth collecting** (too personal / not actionable):
- Text scale (synshemmede vs. unge — personal)
- Chord-mode `vise` vs `barre` (depends on player skill, not on the song)
- Favoriter / songbook membership (private, not behavioral defaults)

**Aggregation method: median over mean.** One outlier (a user setting 600 s on a 3-minute song while they grabbed coffee) skews the mean. Median is robust. Alternatively bucket-mode (round to nearest 15 s, take the most-common bucket) — captures "what most people landed on".

**Sample threshold:** require ≥ N (probably 5-10) distinct samples before adopting a crowd-default over the LLM-or-hardcoded default. One user's preference is noise, not signal.

**Privacy + log-hygiene rules** (extending the Azure VM ones):
- Telemetry payload contains ONLY `(tab_id, value)` — no user-ID, no session-ID, no timestamp the server keeps.
- Server logs neither IP nor request headers on the telemetry endpoint. Counter increments only.
- Use `navigator.sendBeacon()` at unload, not realtime POST — minimizes both client UX impact and server load.
- Telemetry endpoint is rate-limited per IP to prevent a single bad actor from skewing aggregates (e.g., 10 requests per minute is plenty for honest behavior).

**Pipeline integration:**
- Telemetry accumulates on the Azure VM between deploys.
- Crawler (or a sidecar batch process) reads the aggregated counts → computes median per signal per tab → writes to `enrichment.songs[sid].playback_defaults: {duration_s: 247, start_y_ratio: 0.18, sample_count: 47}`.
- Browser reads `playback_defaults` from enrichment when populating HUD initial state, but the user's own `nortabs:playback:v1` localStorage entry overrides always — crowd-default is a *starting point*, not a *correction*.

User's own tuning always wins. Crowd-default only kicks in for tabs the user has never customized.

## Auto-scroll scroll-start-point (planned)

70-90 % of tabs have "noise" at the top (uploader notes, capo info, tips). For now, auto-scroll always starts from the user's current scroll position — they scroll past the noise themselves, then hit play. Future iterations should add a smart default jump-to-line:

1. **Heuristic**: first line with ≥2 chord-shaped tokens (G, Am, C#m, F#7…). Free baseline, catches most tabs.
2. **LLM-augmented**: enrichment job analyzes each tab body, stores `scroll_from_line` and `scroll_verified` ∈ {`heuristic`, `llm-high`, `human`} in `enrichment.tabs[tid]`.
3. **Human-in-the-loop for edge cases**: when LLM is unsure (or heuristic disagrees with LLM), the app shows a "Stemmer startpunktet?"-prompt — the user confirms or corrects, app saves `scroll_verified: "human"` to the sidecar. Tab IDs are stable and bodies don't change in practice, so a human verification holds "for all eternity" — future LLM runs skip the entry entirely.

User position **always** overrides the suggested jump: if user has scrolled before hitting play, that position wins regardless of what's stored.

## Resolved API facts

- `/tabs/tab?id={id}` returns the chord/lyric text in **`body`**, not `content`. The Python app's `api.py:326` `data.get("content")` is wrong. Crawler uses `body`. ✓
- `tab.chordnames` is a **JSON array of strings** (e.g. `["Am","Bb","C"]`), not a space-separated string. Crawler stores it as-is; views must join for display. ✓
- `/collections/browse?sw={letter}` paginates with **`&limit={N}` (cap 50) and `&page={N}` (0-indexed)**. Without pagination params, it returns 10 results — easy to mistake for "this letter has 10 artists". Loop until response is empty. ✓
- Both `/collections/browse` and `/collections/collection?id=X` carry **cheap change-detection signals**: browse entries include `tab_count` + `song_count` per artist; collection entries include `tab_count` per song. The incremental crawler diffs these against the existing catalog and skips deeper fetches when counts match. Caveat: a tab being replaced (one removed + one added on the same song, same total count) is invisible to this diff — only the weekly full crawl catches it. ✓

## Working artifacts (outside the repo)

- `C:\Users\wossn\catalog_a.json` — superseded; the 10-artist unpaginated sample. Do not use.
- `C:\Users\wossn\nortabs_crawl_test.py` — proto-crawler (also unpaginated, also superseded). `crawler/crawl.py` in this repo is the real one.
- `C:\Users\wossn\nortabs_a.json`, `nortabs_artist.json`, `nortabs_tab.json` — raw single-endpoint samples, useful when verifying API shape.
