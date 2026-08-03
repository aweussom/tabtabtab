---
name: agentry-copilot-acp-proxy
description: "Tommy's own tool at C:\\devel\\aweussom\\python\\agentry — a Flask proxy that wraps GitHub Copilot CLI as an OpenAI-compatible HTTP API, killing the per-call -p startup overhead. Directly usable as an enrichment backend for nortabs-web via the existing --ollama flag."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 34184579-7cd2-477b-b7a4-f4f76345762b
---

Tommy built **Agentry** (`C:\devel\aweussom\python\agentry`) — a single-file Flask proxy (~400 lines, `agentry.py`) that holds ONE persistent `copilot --acp` subprocess and drives it over the Agent Client Protocol (JSON-RPC over stdio), exposing the result as an **OpenAI-compatible HTTP API** on `localhost:8765`.

**What problem it solves**: CLI coding tools (`copilot -p`, `claude -p`) pay ~8 s subprocess-startup overhead *per call*. Agentry keeps the process warm across requests → per-turn latency drops to the model's own floor (~2-3 s for short replies). This is exactly the overhead `crawler/enrich-private.py`'s default CLI mode (`claude -p --model sonnet`) suffers from.

**Currently wraps**: GitHub Copilot CLI (`copilot --acp`). Free tier exposes `gpt-5-mini` (default), `gpt-4.1`, `claude-haiku-4.5`. Built to be extended to `claude-code`, `qwen3-code`, `antigravity-cli`, `codex`. Auth piggybacks on the existing `copilot login` cred-store token (must launch from the same interactive logon session). Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (SSE streaming), `POST /v1/cancel`. Launch via `start.ps1` (Windows) or `start.sh` (Linux/WSL).

**Direct connection to nortabs-web** (the killer insight): the `--ollama` flag I added to `crawler/enrich-private.py` is *really* a generic "OpenAI-compatible endpoint" flag despite the name. It points at any `/v1/chat/completions` base URL. So:

```
python crawler/enrich-private.py --ollama \
  --ollama-base http://localhost:8765/v1 \
  --ollama-model claude-haiku-4.5
```

…routes UG-tab enrichment through Copilot CLI's **free-tier Haiku** via Agentry — no code change needed. This is the missing piece for [[DEV-TO-PLAN]]'s Phase 1 [ESCALATE] ("verify copilot-cli can take a raw prompt and return a response without shell-command framing"). Agentry IS the answer: it turns the interactive CLI into a clean programmatic backend.

**Status**: personal spike, single-user, gray-ToS-zone (wraps a vendor interactive CLI as a programmatic backend — use a non-critical account, don't expose externally, keep volume modest). Has a published dev.to article (the "manic developer smashing a guitar into a laptop" origin story — same NorTabs project lineage). Web UI is copied/pared-down from Tommy's [[reference_python_llm_patterns|NoLlama]] project.

Also present in that dir: `antigravity-sdk-python/` (Google's Antigravity agent SDK, vendored) — Tommy is exploring it as a future backend.

The web app's `proxy/` (NorTabs enrichment proxy) and Agentry are conceptual siblings: both are thin OpenAI-compatible wrappers. NorTabs proxy fronts cloud LLM endpoints; Agentry fronts a local agent-CLI subprocess.
