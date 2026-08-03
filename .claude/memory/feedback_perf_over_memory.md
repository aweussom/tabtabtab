---
name: feedback-perf-over-memory
description: "For nortabs-web, optimize for perceived speed vs the live site; client-side memory is not a constraint. Defer compression/ZIP decisions until after full crawl."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a8aff128-0d47-4b66-a74c-8f83cb8107b7
---

Runtime memory in the user's browser is not a concern for this project. The goal is "anything that makes the web app faster than nortabs.net is positive." Don't propose memory-saving optimizations (per-tab gzip, lazy decompression, etc.) as defaults.

**Why:** User explicitly said "det er ikke MITT minne" — they care about end-user perceived speed, not client RAM footprint. Compression was discussed for `body` fields specifically (they compress well), but the decision is to wait until the full A-Z catalog is crawled before deciding if any compression is even needed.

**How to apply:**
- Phase 1/2: ship `catalog.json` uncompressed, load once into memory, index by id. Don't preemptively gzip per-tab.
- Revisit compression only after full crawl, and only if catalog size becomes a real problem (transfer or load time, not memory).
- When proposing optimizations in this repo, lead with latency/perceived-speed wins, not memory wins.
