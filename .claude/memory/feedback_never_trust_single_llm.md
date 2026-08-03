---
name: never-trust-single-llm
description: "Tommy's binding design principle: never rely on a single LLM's output for quality-critical work — always build in a cross-check against a second model or a QA pass. Shapes every enrichment/quality flow in the project."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 34184579-7cd2-477b-b7a4-f4f76345762b
---

Never propose or design a quality-critical LLM flow that relies on a *single* model's output as the final word. Always build in a cross-check — a second model, or a QA pass — before treating enrichment as trustworthy.

**Why:** Tommy's stated principle, verbatim: *"Jeg stoler ALDRI på én LLM!"* It has shown up repeatedly across the project, so it's load-bearing, not a one-off:
- Public-catalog `enrichment.json` was produced by **Claude + GPT cross-check** on disjoint letter sets, then diffed to surface hallucinations (commit `2ffe873`).
- The planned **nightly Claude-Code CLI QC pass** over the enrichment corpus (PLAN.md Phase 2.5).
- The CLI enrichment pipeline (`crawler/enrich-private.py` + `build-private-bundle.py`) was **retained, not archived** (2026-05-27) specifically as a QA cross-check source against the new on-device Gemini Nano path — even though on-device is the product path. See [[ug-enrichment-chrome-ondevice]].

**How to apply:** when wiring or designing any enrichment / extraction / quality-sensitive LLM step, assume a second-model cross-check or QA pass is wanted. Don't archive/remove a working "alternative LLM" path just because a primary path was chosen — it likely has QA value. Don't present single-model output as authoritative for anything that ships. When the on-device path produces enrichment, the cloud/CLI pipeline is the reference to diff against, not dead weight.
