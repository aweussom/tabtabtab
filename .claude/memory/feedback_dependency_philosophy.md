---
name: dependency-philosophy
description: "Tommy is NOT anti-dependency. The 'vanilla JS, no bundler' ethos is about avoiding bundler/framework/backend bloat — not about zero deps. Small, focused, widely-used libs are welcome."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 34184579-7cd2-477b-b7a4-f4f76345762b
---

Don't dogmatically avoid third-party dependencies in the name of the project's "vanilla JS / no build step" ethos. That ethos targets **no bundler, no framework, no backend** — not **no libraries**. A dependency is fine when it is **small, focused, and widely used out in the world**.

**Why:** stated 2026-05-27 — *"Jeg har som sådan ikke noe IMOT dependencies. Men de bør være små, fokuserte og MYE brukt dere ute i verden."* Said in response to me reflexively hand-porting JSON-recovery logic into the spike and justifying it as "no external lib — keeps it dependency-free, on-brand." That avoidance was an over-correction; a small mature lib (e.g. `json5`, which the Python pipeline already uses) would have been an acceptable, even better, choice.

**How to apply:**
- A clean fit from a small/focused/popular lib (json5, fflate, pako, etc.) is worth *proposing*, not avoiding. Don't pretend hand-rolling is automatically more "on-brand."
- Keep the no-bundler constraint: for the static app, that means vendoring the lib's single minified file into the repo (works offline, no build step) or a `<script>` from a reputable CDN — not adding npm + a build pipeline.
- Still avoid: large/kitchen-sink libs, niche/unmaintained ones, anything that drags in a framework or a build step. The bar is "small, focused, battle-tested, millions of users."
- Hand-rolling is still right when the logic is tiny and bespoke (e.g. the project's folding/IDF search internals) — judgment call, but the default isn't "never a dep."
