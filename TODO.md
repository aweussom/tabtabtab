# TODO

Open work, near-term to far-term. Detailed design notes live in `PLAN.md`; this file is the focused backlog. Shipped items are marked ✅ in `PLAN.md` and not duplicated here.

## Near-term — likely next pass

- **Personal library import (Word docs + ChordPro)**. Thousands of personal `.docx` files (single songs + multi-song "sangbøker") + a small set of ChordPro `.chopro` files belong in the same private-tabs store as UG imports, with different `source` tags. ChordPro is straightforward (~80 lines JS, well-defined format). Word is trickier — single-song parsing via heuristics is ~150 lines, multi-song splitting needs an LLM (same pipeline as catalog enrichment).
- **Songbook share URLs handling for private tabs**. A shared songbook URL containing `ug-12345` IDs is meaningless to recipients — their TabTabTab install has no body for that ID. v1: render placeholders with "Privat tab — be avsender om eksport". v2: inline the tab body in the share URL.
- **IndexedDB fallback when localStorage fills up**. Word/sangbok import will easily exceed the 5-10 MB localStorage budget. Migrate the local-imports store to IndexedDB once we hit that ceiling — one-shot migration on first run after the cutover. Songbooks (small, ID-only) stay in localStorage.

## Mid-term — interesting but not blocking

- **Songbook HTML export — Full Fat**. The shipped "Lite" exporter (`exporter.js`) ships just the songbook's tabs in a standalone HTML. "Full Fat" would bundle the entire TabTabTab app + the full catalog as embedded JSON so the recipient gets a portable copy of the whole site. Concat all `.js` modules into one inline `<script type="module">`, embed catalog as `<script type="application/json">`, pre-populate localStorage with the songbook. Replaces Lite once proven.
- **Capo-first visegrep transposition**. Replaces nortabs.net's per-semitone transpose UI with "set capo at N to play in key X (open shapes)". Tommy's principle: *"Transponering bør IMNHO KUN gå til 'spillbare visegrep'"*. Default is capo-first; per-semitone shifts live behind an Advanced toggle. Algorithm scores capo positions by % of song's chords that land on open fingerings in `chord-data.js`.
- **Export to ChordPro**. Three tiers: (1) trivial `{start_of_tab}…{end_of_tab}` wrapper (~10 lines), (2) heuristic chord-line-over-lyric parser → inline `[Cm]lyric` (~100 lines, ~80% clean), (3) LLM conversion in `enrich.py` with `chordpro_verified` confidence flag. Start with (1).

## Long tail — when motivated or when need bites

- **Catalog/enrichment compression in the browser**. Three layers: (1) ship `catalog.json.br` (Brotli) instead of relying on Pages' gzip — ~5 lines in catalog.js + `DecompressionStream`, (2) keep per-letter compressed buckets in heap, decompress lazily on letter navigation, (3) MessagePack/CBOR instead of JSON. Only worth doing when heap pressure / cold-start parse time actually bites.
- **Auto-scroll duration LLM-YouTube lookup**. Future enrichment: LLM finds the song on YouTube, reads the duration, writes to `enrichment.songs[sid].youtube_duration_s`. Auto-accept threshold ≤ 240 s (radio-edit-like); longer durations need human confirmation. Replaces the hard 180 s default for tabs we have YouTube data for.
- **Crowd-sourced playback defaults via anonymous telemetry**. Once we have any kind of backend (Phase 5+), browsers ship `(tab_id, duration_s)` + `(tab_id, start_y_ratio)` via `navigator.sendBeacon`. Server aggregates median per tab, writes to `enrichment.songs[sid].playback_defaults`. User's own choices override always. Privacy: no user-id, no session-id, IP/headers not logged. Probably indefinitely deferred unless we end up wanting any backend at all.
- **Auto-scroll smart start-point**. Most tabs have header noise (capo info, tips, USENET headers). Today user manually scrolls past it then hits play. Future: LLM-tagged `enrichment.songs[sid].scroll_start_line` with `verified` confidence + "ask me + save forever" UX.

## Parked — accepted as-is until evidence says otherwise

- **iOS chord-wrap defensive shotgun minimization**. Five overlapping defenses landed together and fixed the iOS bug. CLAUDE.md "iOS chord-wrap" section enumerates them. Bisection would identify the minimum-necessary subset (likely 1 + one of {3,4} + 5) but the iOS user count for this app is effectively zero and the shotgun cost is near-nothing. If/when someone wants to minimize: revert one defense at a time on a branch, re-test rotation + A−/A+ on a physical iPhone.
- **0-tab songs in catalog**. The crawler occasionally returns songs with `tabs: []`. Currently kept (they render as "No tabs"). Open question whether to filter at crawl time; low impact.
- **Chord lines with embedded commentary** (`Am (Hold this)` style). The chord-styling heuristic threshold (≥70% chord-shaped tokens) misses these. Rare; revisit with explicit BB-markup parsing if it shows up in real usage.
