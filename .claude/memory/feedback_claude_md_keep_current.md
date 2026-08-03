---
name: feedback-claude-md-keep-current
description: "User expects CLAUDE.md to be kept current with operational realities — proactively update it when new tooling, caching, or session-affecting things ship, not only when explicitly asked"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6ab1d93c-cd84-461f-8427-dac2793dd62b
---

When the project gains operational context that a fresh session would miss — new tooling, new caching layers, new "gotcha"-class facts — proactively offer to update `CLAUDE.md`. Don't wait for the user to ask.

CLAUDE.md is the "operational context a fresh session would otherwise miss" file (PLAN.md is the design log). New service workers, new build scripts, new crawler entrypoints, new env-var requirements, etc. all belong here.

**Why:** On 2026-05-16 the user pointed out that ~10 commits worth of operational changes (PWA service worker, UG private-bundle pipeline, BENCHMARKING.md, etc.) had landed without CLAUDE.md being touched. The service-worker bit specifically bit us mid-session — a fix I made to `chord-wrap.js` was masked on iOS because SW served the cached old file. If CLAUDE.md had mentioned the SW + `APP_VERSION` cache-key relationship, the previous session (or me) would have flagged it before pushing the user into "test on iOS to debug an invisible cache."

**How to apply:** After landing a non-trivial operational change (or when noticing the gap mid-session), check whether CLAUDE.md needs an entry. Bias toward asking the user "should I add X to CLAUDE.md?" rather than silently skipping. PLAN.md churn does NOT trigger this — only changes that affect how a fresh Claude session should *operate* in the repo.

Related: [[feedback-check-intent-before-suggesting-deletes]] (another "don't be naively literal" lesson from the same conversation).
