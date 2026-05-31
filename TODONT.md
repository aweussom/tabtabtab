# TODONT

Deliberate non-features. These are decisions we've already made AGAINST doing something, recorded so future contributors (and future-self) don't relitigate. Each entry has the *why* — break the rule only with new information that overturns it.

## Architecture

- **No bundler, no transpiler, no build step.** The shipped web app is vanilla ES modules + HTML + CSS. Open `index.html` in any browser — it works. No `package.json`. The project's whole self-imposed constraint is *"if it can be done in JavaScript in the browser, it shall be"* — adding a bundler is conceding that the browser isn't enough, and we have evidence the browser IS enough. Adding npm tooling without explicit user buy-in is a regression.
- **No backend for the production app.** The static app makes zero network calls to anything we operate. Catalog data is shipped JSON. User imports live in their own localStorage + their own Google Drive. On-device LLM enrichment runs in their browser. The only code that hits an external service is the nightly catalog crawler (GitHub Action against nortabs.net, with permission). Standing up our own backend crosses an architectural line — every alternative has been considered and rejected.
- **No analytics, no tracking, no cookies set by us.** localStorage is the only state we write, and it stays on the user's device. If we ever need crowd-sourced playback defaults (see TODO.md), the design is `navigator.sendBeacon`-only with no user-id, no session-id, no logged IP — strictly anonymous tab-id-to-value pairs. No funnel analytics, no error reporting service, no third-party JS at all.
- **No CDN-loaded fonts or libraries.** JSON5 is *vendored* (`vendor/json5.min.js`), not loaded from a CDN. The only exception is Google Identity Services for Drive sync (`accounts.google.com/gsi/client`) — and even that is lazy-loaded only when the user actually clicks "Sign in", so anyone who never syncs never fetches from Google.
- **No mock-mode, no test fixtures, no fake-data layer in shipped code.** The catalog IS the data. The on-device LLM IS the LLM. We test by using the real thing.

## UX choices

- **No HTML5 native drag-and-drop reorder.** Tab reorder in songbooks uses ↑/↓ buttons. Drag-and-drop is bad on touch, and the music-stand-on-phone use case is touch-first. If a desktop-only "drag with mouse to reorder" affordance is ever wanted, it goes on top of the ↑/↓ as a secondary, not a replacement.
- **No per-semitone transposition as the primary UX.** The default transposition surface is capo-first ("set capo at N to play in key X with open shapes"). Per-semitone shifts that land on F♯/C♯ where every chord becomes a barre live behind an Advanced toggle. Tommy's principle: *"Transponering bør IMNHO KUN gå til 'spillbare visegrep'"*.
- **No Drive sync without explicit sign-in.** Drive sync is opt-in. The lazy-loaded GIS script means users who never sign in never fetch from Google. Auto-pull on boot only runs if a token is cached.
- **No verification fallback for Drive.** We deliberately use `drive.appdata` (non-sensitive scope) so Google's verification process isn't needed. We'll never request `drive` or `drive.file` — they'd require verification and they'd let us see user data we shouldn't see.
- **No catalog-side LLM-tagged search asymmetry warning per tab.** UG-imported tabs are indexed on artist + song + body (literal text) only; they don't get the LLM semantic layer that catalog tabs receive. We accept this asymmetry quietly — adding per-tab "this tab is not vibe-searchable" UI would clutter the result list with caveats. The TODO is to one day enrich UG-imports too (on-device Gemini Nano already does this for the user's local imports).

## Data

- **No shipping of personal UG libraries with the public app.** `crawler/private/` is gitignored. The shipped `private-bundle.json` is intentionally absent. A demo bundle with cleanly-licensed content might ship in the future; one person's personal UG library shouldn't.
- **No re-import orphan removal.** When a user re-imports a UG export and a previously-imported tab is no longer in their UG bookmarks, we don't delete it from TabTabTab — orphan-removal requires explicit user intent. Users can manually delete via the songbook UI.
- **No catalog content modifications.** Catalog data comes from nortabs.net with permission and is shipped as-is. Our work goes in the enrichment overlay (`enrichment.json`), not in the catalog itself. The enrichment is freely sharable back to nortabs.net (MIT, README has a note explicitly inviting this).

## Tooling

- **No CI test runner.** There are no automated tests in this project. The deploy pipeline runs the nightly crawler GitHub Action; that's all. Manual smoke-tests via the dev server (`python -m http.server 8765`) cover the "does it work" question.
- **No npm dependencies for the shipped app, ever.** The vendor folder contains exactly one library (JSON5) for a single targeted purpose (lenient parse of LLM output that often emits non-strict JSON). Adding another library requires the same bar: small, focused, vendored, not loaded from CDN, not requiring a build step.
- **No automated screenshot regression testing.** Screenshots in `docs/screenshots/` are hand-captured for the README + user guide. iOS chord-wrap is verified by manually rotating an iPhone. Browser-automation testing would require more tooling than this project's value justifies.
