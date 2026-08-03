---
name: ug-enrichment-chrome-ondevice
description: "BINDING decision (2026-05-27): UG-import enrichment runs on-device via Chrome's built-in Prompt API (Gemini Nano), Google-Chrome-only. Supersedes the cloud-proxy plan. Includes how to provision + the API shape that worked."
metadata: 
  node_type: memory
  type: project
  originSessionId: 34184579-7cd2-477b-b7a4-f4f76345762b
---

**Decision (2026-05-27, binding): UG-import enrichment runs ON-DEVICE in the browser via Chrome's built-in Prompt API (Gemini Nano). Google-Chrome-only, going forward.**

**Why:** Chrome shipped the built-in Prompt API (`LanguageModel` global) to stable (Chrome 148 verified on Tommy's machine). On-device = not a network call, so the entire premise that justified the cloud proxy ("browser can't call cloud LLMs, CORS blocks it, proxy not optional") is void for Chrome users. Matches the project's "browser is a complete computer" ethos: zero backend, zero cost, zero CORS, zero API key, works offline.

**How to apply:**
- The cloud-proxy work (`proxy/`, `NOLLAMA-DEPLOY-PLAN.md`, the DeepSeek-Flash/MiMo benchmarking in `crawler/bench/` + `BENCHMARKING.md`) built the now-SUPERSEDED path. Not deleted — it informed the decision and may return as a non-Chrome fallback — but no longer on the critical path. `nollama.no` no longer needs to host a UG-enrichment proxy.
- Public-catalog enrichment (`crawler/enrich.py`, Claude/OpenAI nightly producing `enrichment.json`) is a SEPARATE concern, unaffected.
- Non-Chrome users still get full *literal* search over UG imports (artist/title/lyric/chord text) — just not the LLM semantic layer in-browser. A cloud fallback for them is possible later but explicitly NOT being built now.
- When touching PLAN.md Phase 2.5, the on-device decision is the live plan; the proxy text below the "SUPERSEDED" banner is historical.

**Validation (2 English UG tabs, 2026-05-27):** Tecumseh Valley + Let Her Go. Semantic-layer quality (`search_text`/`themes`/`mood`/`key_phrases`) matched the cloud models; `key_phrases` came back verbatim-identical to the DeepSeek-Flash baseline. ~9-10 s per song on an RTX 5090. For 253 tabs serial ≈ ~40 min, entirely client-side.

**`display_suppress` was DROPPED** — it was only aesthetic (hiding UG legal preambles / USENET headers from the rendered tab). Gemini Nano can't do it: line-index counting is beyond a ~3-4B on-device model (it returned `[0..19]` on Tecumseh, which would eat the title + first verse). If ever revisited: prepend line numbers to the body so the model *reads* indices instead of *counting* — that trick would also fix the cloud models hallucinating out-of-range indices.

**Prompt API shape that worked** (Chrome 148):
- Provision once per profile: flags `#prompt-api-for-gemini-nano` (Enabled) + `#optimization-guide-on-device-model` (Enabled BypassPerfRequirement), relaunch, then `chrome://components` → "Optimization Guide On Device Model" → Check for update (downloads Gemini Nano ~2-4 GB).
- `await LanguageModel.availability()` → `"available"` when ready (else `unavailable`/`downloadable`/`downloading`).
- `await LanguageModel.create({ expectedInputs: [{type:'text', languages:['en']}], expectedOutputs: [{type:'text', languages:['en']}], initialPrompts: [{role:'system', content: ...}] })`. The `outputLanguage` key is NOT recognized; the language-safety warning fires unless you use the `expected*` form.
- `await session.prompt(userText)` → string. Sometimes wraps in ```json fences — strip them. `session.destroy()` when done.
- Requires a secure context (https or localhost). The dev static server (`python -m http.server`) on localhost qualifies.

**Project naming is in flux** (2026-05-27 brainstorm): NorTabs-Web may be renamed for the UG-import product — candidates floated include tabtabtab.com, Tabby McTabFace, Webby-Tabby. Not decided. See also [[reference_agentry_copilot_proxy]] (Tommy's Copilot-CLI proxy — still useful for personal/cloud enrichment) and [[reference_python_llm_patterns]].
