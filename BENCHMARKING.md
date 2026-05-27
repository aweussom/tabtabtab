# Cloud-LLM benchmarking — for *future* private-tabs enrichment

## Scope (and what this is NOT)

This document is about benchmarking cloud-API LLMs for enrichment of **user-imported tabs** — UG bookmarks, Word docs, ChordPro files, anything that lands in `nortabs:private-tabs:v1`. It is about candidates for the *future* enrichment-as-a-service flow that PLAN.md sketches under "Search asymmetry without enrichment" (UG import section) and "Phase 5+ — Long-term vision".

**It is NOT about replacing the current catalog-enrichment pipeline.** `crawler/enrich.py` (Claude Sonnet, via Tommy's Max subscription) + `crawler/enrich-gpt.py` (OpenAI, via Tommy's API key) already produce the cross-checked `enrichment.json` that ships with the public nortabs.net catalog. That pipeline works, has tuned prompts (commit `303c689` for caching, `2ffe873` for cross-check, `40ec4cb` for concurrent in-flight requests), and Tommy's existing personal subscriptions make it cost-effectively a sunk-cost. Don't touch it.

The proposed cloud-API path solves a *different* problem: when a user (any user, not just Tommy) imports 250 UG tabs and wants those tabs to participate in NorTabs' "search by vibe" layer, who runs the LLM to enrich them?

Three plausible architectures, each with different model requirements (see "Architecture options" below). Benchmarking has to inform that choice, not just "which model is best in the abstract."

## Phase 2.5 update (2026-05-17): most of this is parked

The Phase 2.5 thin LLM proxy (see PLAN.md) now points at **local Qwen3.6 on Tommy's RTX 5090** via the existing OpenAI-compat Ollama endpoint, validated end-to-end on real English UG tabs. That collapses the open-cost-vs-quality matrix this doc was built to navigate:

- **Cost is zero at the margin.** Local Ollama, Tommy's hardware, no per-token bill. The "Cost per 100 entries" criterion below becomes moot for the proxy path.
- **Language scope is English-only** (PLAN.md "Language scope" decision). UG bookmarks are ~99.9% English; Norwegian content stays on the public-catalog enrichment pipeline. The "make-or-break Norwegian-language quality" criterion below **does not apply** to the proxy path. The "Norwegian region accuracy ≥80 %" and "Norwegian genre accuracy ≥75 %" pass/fail thresholds also do not apply.
- **Quality target is "better than UG's own search, free at the margin"** (PLAN.md "Quality target"), not "matches Claude/GPT-4 frontier output." Qwen3.6's mid-frontier wrongness (e.g. attributing Tecumseh Valley to John Prine) is acceptable; structural JSON correctness and verbatim `key_phrases` matter much more.

The rest of this document — candidate-model survey, gold-standard dataset construction, `enrich-bench.py` design, pass/fail criteria — remains valid for **a hypothetical future** where one of these reactivates:

1. We want to enrich Norwegian content via cloud LLMs (e.g. replacing the nightly Claude/OpenAI pipeline). Then Norwegian-language criteria come back as the make-or-break gate.
2. Local Ollama on Tommy's machine stops being available (hardware change, multi-user load), forcing a hosted-cloud fallback for the proxy. Then cost/quality cloud comparison matters.
3. Phase 5+ enrichment-as-a-service kicks off for a real user base. Then dedup + shared cache + per-user budgeting reshape the cost calculus entirely.

Until one of those triggers, do not invest in benchmark harness work. The rest of the doc stays as parked design notes.

## TODO: MiMo-V2.5 bench — blocked on token-plan key (2026-05-27)

Xiaomi cut MiMo-V2.5 pricing hard (up to 99% off) and the Standard token plan is $16/mo for 11 B credits (~9000 full re-enrichments of our 253-tab library/month — effectively unlimited). Cost + official-API + ToS-clean profile makes it a serious nollama.no production candidate, possibly displacing DeepSeek-Flash. **But it's untested in our bench.**

Attempted 2026-05-27, blocked on auth:
- `enrich-bench.py` now supports arbitrary OpenAI-compat endpoints: `--base`, `--api-key-env`, `--extra-body` (JSON merged into payload — for `{"thinking":{"type":"disabled"}}` + `{"response_format":{"type":"json_object"}}`). Harness side is done.
- `api.xiaomimimo.com/v1` + the platform API key → **HTTP 402 "Insufficient account balance"** (key valid, pay-as-you-go balance empty).
- `token-plan-ams.xiaomimimo.com/v1` + the same key → **HTTP 401 "Invalid API Key"**.
- Conclusion: the token plan uses a **separate key** (the coding-tool key that works with Claude Code / OpenCode / KiloCode), distinct from the platform API key. Need to grab it from the Token Plan section of the dashboard and set it (`[Environment]::SetEnvironmentVariable("MIMO_TOKEN_KEY", ..., "User")`).

To resume: set `MIMO_TOKEN_KEY`, then
```
python crawler/enrich-bench.py --base https://token-plan-ams.xiaomimimo.com/v1 \
  --api-key-env MIMO_TOKEN_KEY --models mimo-v2.5-pro \
  --extra-body '{"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}}' --force
```
If that 401s too, next suspect is `api-key:` header vs `Authorization: Bearer` — add an auth-header-style flag and retry. `response_format: json_object` is worth keeping regardless — structured-output mode makes parsing bulletproof (eliminates fence-stripping + most salvage logic). It belongs in the production proxy + enrich-private.py once a working provider is confirmed.

## Why benchmark at all

The current catalog uses Claude Sonnet and GPT-4-class models. These are expensive (~$50-150 per full catalog enrichment) and Tommy's personal subscriptions absorb the cost. For *user-import* enrichment, scaling per-user-bookmarks-at-Tommy's-cost doesn't work — costs grow linearly with user count.

Cloud-API alternatives (Ollama Cloud, Groq, Together, DeepInfra, etc.) host open or semi-open models at lower per-token rates than frontier models. The bet is: a $0.10/M-token model can produce good-enough enrichment for ~$0.05 per imported 250-tab batch instead of $5-10 with Claude. Whether this bet pays off depends entirely on output quality, especially for Norwegian content.

## Candidate models (verify availability before benchmarking)

These are *categories* of model worth testing — not a promise that the exact named version is currently live on Ollama Cloud or any other provider. Cloud-API model rosters change monthly; check the provider's current model catalog before wiring up benchmarks.

| Family | Why a candidate | Norwegian-language risk |
|---|---|---|
| DeepSeek (Flash + Pro tiers) | Strong reasoning, good multilingual coverage on paper, aggressively priced | Trained heavily on English + Chinese; Norwegian is a long tail — quality may degrade on obscure folk/visegrep classification |
| NVIDIA Nemotron (Super tier) | Open-weights pedigree, decent at structured-output following | Same caveat as DeepSeek — likely treats Norwegian as a small-fraction-of-training-data |
| Qwen 3.5 (Alibaba) | Strong on structured JSON output, multiple sizes including small-and-cheap | Multilingual emphasis is Asian languages + English; Norwegian is sparse |
| Xiaomi MiMo (V2.5 Pro) | New entrant, marketed as reasoning-focused | Same risk amplified — Chinese-origin model, less Western-corpus coverage. The fact that nothing benchmarks it publicly on Norwegian is itself a signal |
| Mistral Small/Medium | European-origin, French-and-German exposure makes broader European training plausible | Better-than-Chinese-models on Nordic, probably; verify |
| Groq-hosted Llama 4 (if running on Groq) | Speed, not quality, is Groq's pitch — useful if latency matters | Llama family is broadly multilingual but Norwegian quality varies by fine-tune |

**The make-or-break criterion is Norwegian-language quality.** A model that confuses Vamp (Bergen rock) with Vamps (American glam-metal) is useless. A model that classifies "Mellom bakkar og berg" as "rock" because it doesn't recognize folk-song lyric patterns is useless. The pipeline must understand:

- Norwegian regions: østland, vestland, sørland, nordnorge, trøndelag — not "north" / "south" / "central"
- Norwegian genres: visegrep, salmer, julesanger, barnesanger, sørlandsviser — not just "folk" / "religious" / "Christmas"
- Norwegian artist tradition: knows that Bjørn Eidsvåg = Sauda/Stavanger, that DDE = Trøndelag, that Karpe = Oslo east-side, that Vamp = Bergen
- Bokmål vs. nynorsk vs. dialect — Postgirobygget and KORK can sing the same song in different forms; the enrichment must not flag dialectal variation as "non-Norwegian"

Models that fail this aren't fixable with better prompting — they lack the training-data exposure.

## Benchmark dataset

The right test set is **30-50 entries from the existing catalog** that have already been through Claude+GPT cross-check and have validated `enrichment.json` entries. These are our gold standard. Pick entries that stress different axes:

- **Geographic spread**: 3-5 each from Trøndelag, Vestland, Sørland, Østland, Nordnorge
- **Genre spread**: visegrep (Vamp, Postgirobygget), salmer (sample 3 from the pseudo-artist "Salmer" bucket), julesanger (3 from "Julesanger"), barnesanger (3 from "Barnesanger"), rock (Karpe, DumDum Boys), pop (Sigrid, AURORA), older folk (Sigvald Tveit)
- **Era spread**: ~1970s (Vømmøl, Kuriosa-folk), 1980s (DumDum Boys), 1990s (deLillos, BigBang), 2000s (Madrugada, Kaizers), 2010s (Karpe, Sigrid), 2020s (girl in red, Sondre Justad)
- **Dialect spread**: bokmål-tunge artister (de fleste i Oslo), nynorsk-bruk (Vamp), trøndersk (DDE), bergensk (Vømmøl), nordnorsk (Vassendgutane)
- **Difficulty edge cases**: pseudo-artists (Lovsanger as thematic bucket), tab-only-no-lyrics (instrumental folk), cross-language covers (Norwegian artist covering English song)

Store the gold standard under `crawler/bench/gold/` with a simple naming convention: `<artist-slug>__<song-slug>.json` containing the `enrichment.songs[song_id]` and `enrichment.artists[artist_id]` slices.

## Benchmark mechanics

Build `crawler/enrich-bench.py`:

```
python crawler/enrich-bench.py --model deepseek-v4-flash --provider ollama-cloud \
  --input crawler/bench/inputs/ --output crawler/bench/runs/<model>/
```

For each candidate model:
1. Send the SAME prompt that `enrich.py` already uses (or a minor variant — keep it consistent across all candidates).
2. Record: full raw response, parsed JSON, parse-failure flag, latency (ms), input/output token counts.
3. Save to `crawler/bench/runs/<provider>__<model>/<artist-song>.json` with `{response_raw, response_parsed, parse_ok, latency_ms, tokens_in, tokens_out, cost_usd}`.

Then `crawler/bench/compare.py`:
- Walks `runs/` for all (model, entry) pairs
- For each entry: diffs against `gold/<entry>.json`
- Scores by criteria below
- Outputs a markdown table per criterion + overall ranking

## Pass/fail criteria

In priority order — fail any of these strictly, and the model is out:

1. **Schema compliance (≥95 %)**. Parses as valid JSON, all required fields present (`country`, `region`, `era`, `genre[]`, `notable`, `similar[]`, `search_text` for artists; `language`, `themes[]`, `mood[]`, `occasion[]`, `alt_titles{}`, `key_phrases[]`, `search_text` for songs). Below 95 % means we spend more time on retries than on actual enrichment.

2. **Norwegian region accuracy (≥80 % exact match)**. Bjørn Eidsvåg = Sauda/Stavanger/Sørland, not "Western Norway" or worse. This is the hardest test for non-Nordic-trained models.

3. **Norwegian genre accuracy (≥75 % exact match against gold)**. "visegrep", "salmer", "julesanger" — not "Norwegian folk" or "Christian music". The pseudo-artist boost in `search.js` depends on these being precise.

4. **Era accuracy within ±5 years (≥70 %)**. The catalog's `era` field is decade-granular; missing by more than one decade is wrong.

5. **Hallucination rate on `key_phrases` (≤5 %)**. A `key_phrases` entry that doesn't appear (with token folding) in the song body is a hallucination. Regex check against the body, exact mismatch = strike. Existing `enrich.py` has this issue too; new models must not be worse.

6. **Cost per 100 entries**. Soft criterion — but for a Phase 5+ enrichment-as-a-service flow, $1 per 100 entries × 250-tab user = $2.50 per import. Probably fine at user-trigger frequency; *not* fine if some abuser triggers 10× re-imports.

7. **Latency**. Soft criterion — but if a 50-entry benchmark batch takes > 20 minutes serial, parallel-in-flight has to compensate, which usually means more retry handling on rate-limits.

## Architecture options (this is what benchmarking informs)

Once we have benchmark winners, three deployment shapes are possible. The model choice depends on which we pick:

### A. Per-user, user-pays
User brings their own API key (Ollama Cloud, OpenAI, whatever). NorTabs ships a "configure enrichment provider" page where they paste the key, NorTabs calls the API from the browser, stores results in `nortabs:private-enrichment:v1`.

- **Pros**: Zero NorTabs-side cost. No backend. Privacy: user's key, user's data.
- **Cons**: Most users don't have an LLM API key. Friction.
- **Model requirement**: any benchmark winner works; user picks based on their existing subs.

### B. GitHub Action enrichment "service" (token-gated)
NorTabs runs a GitHub Action that listens for `repository_dispatch` events. User uploads their UG export to a small CDN-fronted bucket; Tommy gets a notification, triggers the action manually (or auto-triggers with rate-limiting). Action fetches the export, runs enrichment via Ollama Cloud (cost from Tommy's account), commits result to a per-user repo or an opaque cache, signals user to fetch.

- **Pros**: Centralized cost ceiling (Tommy controls). No real backend (just GH + a bucket).
- **Cons**: Tommy is bottleneck. Privacy: user's tab list visible to Tommy. Doesn't scale beyond friend-group.
- **Model requirement**: cheapest passing-quality model wins. Quality > speed.

### C. Real Phase 5+ backend (current preferred path — Azure VM API)
Token-authenticated HTTP endpoint on Tommy's existing Azure VM. User's browser POSTs `{artist, song, body}` → API calls cloud LLM → returns `{enrichment: {...}}`. Server-side cache keyed by `hash(artist + normalized(song))` means popular bookmarks (Hotel California, Wonderwall, etc.) hit cache from second user onward. **Bodies are transient — processed and dropped, never stored.** See PLAN.md "Architecture principle" under Phase 5+ for the legal rationale.

- **Pros**: Tommy controls LLM API key + rate limits + cache directly. Shared cache amortizes cost massively for overlapping repertoire. Real product surface. Azure VM already exists at zero marginal cost.
- **Cons**: Real ops (uptime, security patching, abuse handling). Single point of failure vs. distributed alternatives.
- **Model requirement**: best cost/quality ratio. Latency matters less than for synchronous user-facing flows since browser can `fetch()` and show a "henter enrichment..." spinner.
- **Why this beat the alternatives** (Cloudflare Worker, Supabase, GitHub Actions): see PLAN.md Phase 5+ "Earlier-considered alternatives" — short version: GH Actions' payload limits force awkward indirection, Cloudflare Worker hits free-tier limits, Supabase/Firebase overshoot the actual scope.

## Open questions

1. **Cross-check across models** — current pipeline runs Claude + GPT on disjoint letter sets and merges. Should the cloud-API path require *two* candidate models running in parallel for cross-check, or do we trust a single model for private content (lower stakes than public catalog)? I lean toward single-model for private tabs (user's own collection, they can re-import if quality is poor) and dual-model only if architecture C lands.

2. **Prompt-cache compatibility** — `enrich.py` uses Anthropic's prompt-caching (commit `303c689`) by splitting the prompt into stable prefix + per-entry suffix. Ollama Cloud's caching semantics differ across hosted models. Cost projections in benchmarks need to account for whether caching actually fires.

3. **What if no candidate passes Norwegian-language criteria** — fallback to Claude/GPT via cheaper tiers (Claude Haiku, GPT-4o-mini)? These are still "Western frontier" models, more expensive than open-weights but with stronger Norwegian. Re-budget under that scenario.

4. **MiMo V2.5 Pro is a wildcard** — Xiaomi is new in the Western model market. If benchmarks include it, treat results with extra skepticism: scoring it well on a 50-entry test doesn't guarantee it doesn't catastrophically fail on the long tail. Run a second pass on a wider 200-entry sample before betting on it.

5. **License terms for redistributing enrichment** — some hosted models have output-redistribution restrictions. If Phase 5+ caches enrichment results across users (architecture C), check the chosen model's terms. Doesn't apply to architectures A or B.

## Decision gates

Don't start benchmarking until two things are clear:

1. **A real candidate list verified against current Ollama Cloud (or other provider) availability.** Spending an afternoon writing `enrich-bench.py` and then discovering only two of five candidates have live endpoints is wasted work.

2. **Tommy has time/interest to set up the API keys.** This isn't a "build it speculatively" project — it's a "build it when the need is concrete." The need becomes concrete when (a) UG import lands in NorTabs and someone actually uses it, or (b) Phase 5+ planning starts in earnest.

Until then, this document parks the thinking so it doesn't need to be rediscovered.
