# archive/

Superseded work, kept for reference. Nothing here ships or runs in the live app.

## The cloud-proxy era (superseded 2026-05-27)

This was the **pre-Chrome-AI plan** for UG-import enrichment: a thin cloud LLM proxy that the browser would call, because at the time the assumption was "the browser can't call an LLM directly." Chrome shipping the built-in Prompt API (Gemini Nano, on-device) made that assumption false, so UG enrichment moved on-device and Chrome-only. See `PLAN.md` → "Phase 2.5 — SUPERSEDED" for the full decision.

| Path | What it was |
|---|---|
| `proxy/` | Node 24 thin LLM proxy (OpenAI-compat passthrough + JSON cache). Was to run on the Azure VM and front a cloud LLM for UG enrichment. |
| `NOLLAMA-DEPLOY-PLAN.md` | Step-by-step deploy of that proxy to `nollama.no` on the Azure VM (nginx + systemd + certbot). |
| `BENCHMARKING.md` | Cloud-LLM model-selection notes (Norwegian-quality criteria, cost/quality matrix). |
| `bench/` | `enrich-bench.py` output: DeepSeek-Flash / DeepSeek-Pro / Nemotron / Qwen3.5 runs against 5 gold-standard tabs. Picked DeepSeek-Flash before the whole path was superseded. |
| `enrich-bench.py` | The bench harness (OpenAI-compat, arbitrary endpoint via `--base`/`--api-key-env`/`--extra-body`). |

## Why kept, not deleted

It informed the on-device decision, and it's the starting point if a **non-Chrome cloud fallback** is ever built (the committed scope is Chrome-only; non-Chrome users currently get literal search without the semantic layer). Also: the MiMo-V2.5 bench was never run (blocked on the token-plan key — see the BENCHMARKING.md TODO), so if cloud enrichment ever returns, that thread resumes here.
