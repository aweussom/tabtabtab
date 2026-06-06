# tabtabtab

A static, offline-first web app for guitar tabs. Two ways in: **browse** the ~7700-tab [nortabs.net](https://nortabs.net) Norwegian catalog, or **import your own** [Ultimate Guitar](https://www.ultimate-guitar.com) bookmarks and let your *browser* enrich them with an on-device LLM. No backend, no account, no tracking. Optional Google Drive sync for your own imports — your tabs, your Drive, never our servers.

**Home**: [nortabs.netflify.app](https://nortabs.netlify.app)

> The nortabs.net catalog browser is still the core; `tabtabtab` is the same app grown a bring-your-own-tabs half — see [Bring your own tabs](#bring-your-own-tabs--and-your-browser-does-the-ai).

---

## Why this exists

Two motivations, and neither of them is "there's a market for this":

**1. A self-imposed constraint.** Someone wrote Windows 95 as a JavaScript emulator in a browser tab. Reading about that, I adopted a rule for web apps:

> **If it can be done in JavaScript, it shall be done in JavaScript.**

No bundler, no transpiler, no framework, no backend. Vanilla ES modules, one HTML file, one `<div id="app">`. Open `index.html` in a browser — it works. Open it offline — it still works. Drop it on a USB stick — works there too. The entire site, including ~7600 tabs of lyric/chord data, ships as one ~5 MB gzipped JSON file embedded in the page.

This is a constraint as creative driver, not a religious belief. Backends are fine. I just wanted to see how far the "browser is a complete computer" idea goes when you take it seriously. The latest milestone: even the *AI* runs in the browser now. The enrichment layer — the one thing that genuinely looked like it needed a server — turns out not to, because Chrome ships an on-device LLM (Gemini Nano, via the Prompt API). So the rule survives even the AI. See [Bring your own tabs](#bring-your-own-tabs--and-your-browser-does-the-ai).

**2. Search is almost always stupid, and I wanted to fix that — at least here.** Most search is a substring match with a sprinkle of Levenshtein on top. You can search for the title fragment if you remember it exactly. You cannot search for a *vibe*. You cannot search for "that bittersweet tronderrock song about driving home from a funeral", because no field in any database contains the word "bittersweet" next to "tronderrock". This project's enrichment pipeline + search engine try to do that. See **[Search](#search-the-star-player)** below — it's most of what this project actually *is*.

A small third thing: I had built a [Flet desktop app](../nortabs-app) for the same data, the official nortabs.no shipped their own ad-supported app shortly after, and I wanted somewhere to keep tinkering. So: hobby. No ads, no tracking, no account. Explicit blessing from the nortabs.net owner.

---

## A walk through it

The app is browsing-first: letter → artist → song → tab. Search runs in the same view, on top.

**Home — the entry point.** A-Z + Æ Ø Å + 0-9. Sticky search bar above. A wordcloud built from the enriched metadata sits behind (faintly visible in the lower right — "childhood" peeks out).

![Home — letter grid and sticky search bar](docs/screenshots/01-home.png)

**Letter index.** Every artist whose name starts with the chosen letter. Pulled from the in-memory catalog — instantaneous even on letters with 150+ artists.

![Letter C — list of artists](docs/screenshots/02-letter-c.png)

**Artist page.** Songs are listed with their tab count in parentheses. "Bare Du (2)" means two different uploaders have transcribed it; "Blodsbrødre (1)" means one.

![CC Cowboys — songs and tab counts](docs/screenshots/03-artist-cc-cowboys.png)

**Song page.** Each upload, with credit. Some songs have one tab; popular ones have several to compare.

![Bare Du — tabs by PedAndersen and Tom73](docs/screenshots/04-song-bare-du.png)

**Tab view.** Chord-over-lyric body in monospace. The frame sizes itself to the actual content width — narrow songs sit centred, wide ones spread out up to ~1400 px. Heart toggles Favoritter. ▶ Auto-scroll launches the 5-second countdown + smooth scroll (HUD bottom-centre tracks remaining time, 3 min by default). The `A+` / `a−` overlay on the right edge adjusts text size persistently per tab.

![Bare Du — tab view, chord-over-lyric body with auto-scroll HUD](docs/screenshots/06-tab-bare-du.png)

**Songbooks.** Named, ordered collections of tabs. "Favoritter" is the default; you can create more (e.g. "Fjelltur påsken 2026"). Sharing is by URL — the URL *is* the share; recipient opens it and the songbook hydrates from the hash, with an option to save locally.

![Sangbøker — Favoritter + Fjelltur påsken 2026](docs/screenshots/05-songbooks.png)

---

## Search — the star player

You can search by:

| Query | Why it matches |
|---|---|
| `eurovision` | Genre/event tag from LLM enrichment; surfaces every artist who competed |
| `melankolsk` / `melancholic` | Mood tag — Norwegian and English equivalents indexed together |
| `barnesanger` | Genre + the pseudo-artist bucket "Barnesanger" with curated synonyms |
| `trondheim` | Region tag — *and* `trondhjem`, `tronder`, `trønderrock`, `nidaros`, `trøndelag` all resolve to the same set via token aliases |
| `roadtrip` | Occasion tag |
| `bryllup` | Occasion — wedding songs across genres |
| `jeg vil tjene penger på kroppen min` | Verbatim lyric — body match propagates up, the right song wins the result |
| `bjoern eidsvaag` | Diacritic folding: `ø↔o↔oe`, `æ↔a↔ae`, `å↔a↔aa` for ASCII keyboards |
| `rybek` | Single-token typo → "Mente du *rybak*?" via Damerau-Levenshtein |

None of those terms exist in the raw nortabs.net data. They come from an LLM-generated `enrichment.json` layered on top of the crawled catalog: every artist gets country / region / era / genre / similar-artists tags; every song gets language / themes / mood / occasion / alternate titles / key lyric phrases. Roughly 50,000 LLM calls and a day of compute went into producing it.

### What the search engine actually does

Implementation lives entirely in [`search.js`](search.js) (~360 lines, no dependencies). At page load it builds three inverted indexes — `artistIndex`, `songIndex`, `bodyIndex` — folded to ASCII-friendly form, plus three IDF maps so common tokens (`jeg`, `vil`, `på`) get near-zero weight and distinctive ones (`tjene`, `kroppen`, `fairytale`) dominate.

A query goes through several stages:

1. **Fold** the query the same way the index was folded. `Bjørn` and `bjoern` and `bjorn` and `BJØRN` are the same token.
2. **Tokenize** and decide: short query (1-3 tokens) is *exploratory*, long (4+ tokens) is a *phrase*. Phrase mode skips the name indexes entirely — when you paste a remembered lyric, you don't want `jeg` and `vil` to drag every artist named "Vilde" into the results.
3. **Match.** Short queries use prefix expansion on names (`ryba` → `rybak`, `barnsanger` → `barnesanger`), with an `exact > prefix` score multiplier. Body matches are always exact, but weighted by IDF.
4. **Propagate body matches upward.** When a lyric matches a tab, the *song* it belongs to gets a 3× boost on the song frame. So typing a half-remembered line lands you on the right song, not just the right tab.
5. **Dedup multi-tab songs.** A song with five user-uploaded tabs would otherwise score 5× a song with one — unfair. The body score is the *max* across the song's tabs, not the sum.
6. **Songbook boost.** Tabs the user has bookmarked get a 4× multiplier — if you've added Bjørn Eidsvåg to a songbook, his name wins over a less-known same-letter artist.
7. **Three result frames** — Songs, Artists, Lyrics, in that order, twenty entries each.
8. **"Mente du …?"** Only when nothing hit and the query was a single token. Multi-token zero-result is usually a hopeless query and Damerau-Levenshtein guessing makes it worse, not better.
9. **Fall-through.** Zero hits always shows a `Søk live på nortabs.net` link at the bottom — honest UX, no embedded iframe, just a new tab.

### Two small hand-curated layers

Most enrichment is LLM-generated. Two thin layers sit on top:

- **`PSEUDO_ARTIST_TAGS`** — nortabs.net has eight curated buckets that are *not* real artists (`Julesanger`, `Salmer`, `Barnesanger`, `Fotballsanger`, `17. mai-sanger`, `Lovsanger`, `Sørlandsviser`, `Folkeviser`). Each gets a hand-picked synonym string so searching `jul`, `kristen`, `gospel`, `kirke`, `tilbedelse`, `kystkultur` lands on the bucket. The cutoff is ≥7 songs per bucket; smaller ones get no special treatment.
- **`TOKEN_ALIASES`** — small groups of tokens that mean the same place. `[trondheim, trondhjem, tronder, tronderrock, trondelag, nidaros]` all collapse to a single equivalence class. Same for `[oslo, kristiania, christiania]`, `[bergen, bergensk, bergenser]`, `[stavanger, siddis]`. Append as gaps surface.

Both are small data tables in `search.js`. No plumbing, no migrations, no API.

### How we got here (what worked, what didn't)

The repo's git log reads like a search-tuning diary. The interesting stops along the way:

- **Started with a flat inverted index.** Exact match on artist names, song names, and tab bodies; Damerau-Levenshtein for typos; prefix expansion everywhere. Felt good on simple queries. Felt awful on quoted lyrics — `jeg vil tjene` would surface every song with `jeg` *or* `vil` *or* `tjene` and the noise drowned the signal.
- **IDF weighting (commit `90ebb69`).** Computed `log((total+1)/(df+1))` per token, clamped. Distinctive tokens (`tjene`, `kroppen`) now win, filler tokens (`jeg`, `på`) lose. Body search switched from prefix expansion to exact-only at the same time — body was the worst offender for prefix noise, since chord-over-lyric text contains every short prefix imaginable.
- **Phrase mode (commit `a6c9cc0`).** Even with IDF, long queries kept dragging artists into the song frame via the name index. The fix was structural: 4+ tokens means "user typed a phrase" → skip the artist and song *name* indexes entirely, let body matches alone drive the song frame. Multi-tab dedup landed the same day — `MAX` body score per song, not `SUM`.
- **Body-to-song propagation.** A body match boosts the *song* score by 3× the best tab score. So a lyric query surfaces the song, not just a specific tab number. The song view then shows all tabs as usual.
- **LLM enrichment, take 1: Claude only.** Ran `claude -p --model sonnet` over the whole catalog. Quality was good but quota-bounded — a serial run took days, and a Max-subscription 5-hour reset would stop it mid-letter. Built `run-enrich.ps1`: a quota-aware wrapper that reads `~/.claude/quota-data.json`, sleeps through resets, and resumes letter-by-letter.
- **LLM enrichment, take 2: parallel with OpenAI.** Added `enrich-gpt.py` running concurrently against the OpenAI API. Refactored output from one monolithic `enrichment.json` to per-letter files with locks so both LLMs could write in parallel without races. The default split is Claude `a–m`, OpenAI `n–9`; the merge step assembles `enrichment.json` last.
- **Cross-check + reverse runs.** With both LLMs producing comparable JSON, I could send each letter through *both* and diff. Disagreements surfaced where the catalog was genuinely ambiguous (covers, hymn variants, weird transliterations). The "reverse" pass — Claude doing OpenAI's letters and vice versa — filled gaps where one model had hallucinated and the other had been honest about not knowing.
- **Prompt caching for cost (commit `303c689`).** Split the prompt into a stable prefix + per-entry suffix so the OpenAI prompt cache could hit on every request after the first. Cut input-token cost meaningfully on long runs.
- **Pseudo-artists (commit `ce687e3`).** Discovered that some "artists" in the catalog are actually genre buckets curated by nortabs.net. The LLM enrichment treated them as obscure artists and produced thin tags. Replaced those with hand-picked synonym strings.
- **Token aliases (commit `71f45f7`).** Users typing `tronder` were missing songs tagged `trondheim`. Rather than asking the LLM to be exhaustive about every transliteration, a 4-line data table covers the common cases. Easy to grow.

What I tried and ripped out:

- **Prefix expansion on body tokens.** Killed it in `90ebb69`. Every English chord-over-lyric body contains thousands of 2-3 char prefixes; prefix matching turned every body token into a noise generator.
- **Summing body scores across a song's tabs.** Killed in `a6c9cc0`. A popular song with five uploaded tabs would always rank above a niche song with one tab, regardless of how strong the actual lyric match was. Switched to `MAX`.
- **"Mente du …?" on multi-token queries.** Only fires on single-token queries now. Damerau-Levenshtein on "jeg vil tjeen pegnen" produces nonsense suggestions — better to show no suggestion than a wrong one.
- **Showing the live-search button only on zero results.** Replaced with "always visible at the bottom" — turns out users want it even when they have results, as a "second opinion" button.

---

## What else is here

Beyond search, the app has:

- **Songbooks**: named, ordered tab collections in `localStorage`. Share by URL — `#/songbook/shared?name=Sommerleir+2026&ids=2783,6127` *is* the share. No backend.
- **Auto-scroll playback**: 5-second countdown then smooth-scroll the tab body at a tempo chosen per song. Adjustable.
- **Mobile-first chord wrap**: chord-over-lyric tabs reflow without breaking the chord-to-syllable alignment.
- **Offline-capable**: once the page has loaded, it works offline. Songbook export embeds the songbook's tabs into a standalone HTML file you can email.
- **Wordcloud background**: the home page background is a wordcloud generated from the enriched metadata. Decorative, but it's also a sanity check that enrichment actually produced something.

---

## Bring your own tabs — and your browser does the AI

The nortabs.net catalog is Norwegian and finite. But the same search-by-vibe machinery works on *any* chord/lyric tab — so `tabtabtab` also imports your own.

How it works:

1. A userscript (Tampermonkey / Violentmonkey) scrapes your [Ultimate Guitar](https://www.ultimate-guitar.com) bookmarks into a JSON file. Validated on a real 259-bookmark account: 253 OK, 6 publisher-locked.
2. You drop that JSON into the app. Your tabs land in `localStorage` — searchable, browsable, in your songbooks, right next to the catalog.
3. **The enrichment runs on-device.** Chrome's built-in Prompt API (Gemini Nano) reads each tab in *your* browser and tags themes / mood / occasion / key phrases — the semantic layer that makes "search by vibe" work. No server, no API key, no cost, nothing uploaded.

That third step is the whole trick. Enrichment is the one thing that *looked* like it needed a backend — you can't run a decent LLM in a browser, surely? Except now you can: Chrome ships one. Your copyrighted tabs never touch anyone's server; they're enriched by your own machine, and (optionally) synced across your devices through *your own* Google Drive — a hidden per-app folder (`appDataFolder`, scope `drive.appdata`) that's invisible to everyone, including me.

**Status — honest, it's a hobby in motion:** the userscript and the catalog-side bundling are shipped. On-device enrichment is *validated* (Chrome 148, Gemini Nano; semantic quality matched the cloud models that built the catalog). The drop-it-in-yourself import UI and Drive sync are in progress.

**Chrome-only, by choice.** On-device AI is a Chrome feature today (Edge/other Chromium will inherit it; feature-detection means they light up automatically when they do). Other browsers still get full *literal* search over your imports — artist, title, lyric, chord text — they just don't get the AI semantic layer in-browser. An acceptable asymmetry for a design that refuses to run a backend.

---

## Architecture

Vanilla JS modules, no build step. Open `index.html` in any browser — it works.

```
tabtabtab/                    # repo (local folder may still be nortabs-web)
├── index.html                # single root, loads app.js as a module
├── app.js                    # router + state + view dispatch
├── state.js                  # central state with pub/sub
├── router.js                 # hash routing
├── catalog.js                # loads catalog.json once, indexes by id
├── search.js                 # the star player — see above
├── chord-wrap.js             # context-sensitive line wrapping for mobile
├── storage.js                # localStorage for songbooks + playback
├── playback.js               # auto-scroll engine
├── exporter.js               # songbook → standalone HTML export
├── version.js                # cache-busting stamp (auto-bumped on commit)
├── views/                    # one file per screen
├── catalog.json              # crawler output (committed, ~23 MB raw / 5 MB gzipped)
├── enrichment.json           # merged LLM enrichment (committed)
├── enrichment/<letter>.json  # per-letter enrichment checkpoints
├── home-wordcloud.svg        # decorative background
├── style.css
├── .github/workflows/
│   └── crawl.yml             # nightly incremental crawl + Sunday full crawl
├── crawler/                  # local-only tooling — never ships to the browser
│   ├── crawl.py              # nortabs.net catalog crawler (stdlib only)
│   ├── enrich.py             # catalog LLM enrichment via `claude -p`
│   ├── enrich-gpt.py         # OpenAI API variant (concurrent)
│   ├── merge-enrichment.py   # combine per-letter → enrichment.json
│   ├── generate-wordcloud.py # build home-wordcloud.svg
│   ├── run-enrich.ps1        # quota-aware serial wrapper for Claude
│   ├── run-enrich-parallel.ps1 # disjoint-letter parallel driver
│   ├── scheduled-enrich.ps1  # daily 06:00 Oslo Task Scheduler entry
│   ├── userscripts/          # UG bookmark exporter (Tampermonkey)
│   ├── enrich-private.py     # UG enrichment — kept as a QA cross-check
│   └── build-private-bundle.py # builds private-bundle.json (personal/QA)
└── archive/                  # superseded cloud-proxy era — see archive/README.md
```

See `CLAUDE.md` for operational details and `PLAN.md` for the design log and backlog.

---

## Running locally

```sh
python -m http.server 8765
# Open http://localhost:8765/ in any browser.
```

That's it. There is no build step.

---

## Crawling and enrichment

The crawler and enrichment scripts are local tools — they don't ship to the browser.

```sh
# Full catalog crawl from scratch (~52 min at 200 ms politeness delay):
python crawler/crawl.py

# Incremental crawl: diff /collections/browse against the existing
# catalog.json, fetch only changed artists/songs/tabs (~1 min typical):
python crawler/crawl.py --incremental

# Local LLM enrichment via `claude -p` (Sonnet 4.6 by default):
python crawler/enrich.py

# OpenAI API variant (concurrent):
$env:OPENAI_API_KEY = "..."
python crawler/enrich-gpt.py

# Parallel: Claude on a-m, OpenAI on n-9, then merge:
pwsh -File crawler/run-enrich-parallel.ps1

# Refresh enrichment.json from per-letter files:
python crawler/merge-enrichment.py

# Regenerate the homepage wordcloud:
python crawler/generate-wordcloud.py
```

Automation:

- **Crawl** runs as a GitHub Action: incremental Mon-Sat 03:00 UTC, full Sun 03:00 UTC. Commits `catalog.json` + bumps `version.js` if anything changed.
- **Enrichment** runs as a Windows Task Scheduler job on the author's machine at 06:00 Oslo. Pulls latest catalog, invokes `run-enrich.ps1`, commits + pushes any enrichment changes. Kept local because the LLM bill goes to a personal subscription, not CI.

Dependencies:

- Crawler: stdlib only.
- `enrich.py`: needs the `claude` CLI on `PATH` and `pip install json5` (lenient parser for occasional LLM-output glitches).
- `enrich-gpt.py`: `pip install openai`.
- `generate-wordcloud.py`: `pip install wordcloud pillow numpy`.

---

## For nortabs.net's owner

If you're reading this and you maintain nortabs.net: **feel free to grab `enrichment.json` and use it however you want.** The MIT license below makes it explicit; this section is the friendlier version.

The semantic search dimensions (genres, moods, themes, occasions, regions, alternate titles, lyric phrases) took roughly 50,000 LLM calls and a day of compute. If they would help your search on the live site, please just take them. No attribution required, though obviously appreciated.

The crawler is rate-limited (200 ms between requests, ~15 600 requests for a full Sunday sweep, ~1 minute for a no-change incremental on weekdays) so it doesn't hammer your servers. If you'd prefer a different cadence or a feed-based approach, drop me a note.

---

## License

MIT — see [LICENSE](LICENSE). Catalog content is sourced from nortabs.net and remains the property of its uploaders; the enrichment metadata, source code, and aggregations in this repository are MIT-licensed.

---

## Acknowledgments

- The owner of nortabs.net for graciously permitting API access.
- All the uploaders on nortabs.net who painstakingly transcribed these tabs.
- The Flet desktop app (`nortabs-app`) that came first.
