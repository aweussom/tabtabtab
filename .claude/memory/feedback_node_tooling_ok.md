---
name: feedback-node-tooling-ok
description: "Node/npm tooling is allowed in nortabs-web — CLAUDE.md's \"don't introduce node tooling without asking\" was about avoiding a build step, not banning Node globally"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b4ec95a7-5956-47e7-97ba-6fa8db8b2e09
---

Node and other toolkits are fine to use in `nortabs-web` when genuinely needed. The CLAUDE.md line "do not introduce node tooling without asking" reflects a narrower concern: the user does not want a **build step** (bundler/transpiler) for the shipped web app — it stays vanilla JS modules + HTML + CSS, served as-is.

**Why:** The user clarified this on 2026-05-14 while installing Node so the chrome-devtools-mcp plugin's MCP server (`npx chrome-devtools-mcp@latest`) could start. Their words: "I was keeping node out of this project to stay away from having to 'build' pages. I'm fine with using node/other toolkits for this project if need be."

**How to apply:**
- Dev-time helpers (test runners, linters, MCP servers, scripts) using Node are OK — propose them when they materially help.
- Do NOT introduce a bundler/transpiler (webpack, vite, rollup, babel, tsc-for-output, etc.) for the shipped app. The browser must still load `index.html` directly with raw ES modules.
- When in doubt about whether something crosses the "build step" line, ask before adding it.
