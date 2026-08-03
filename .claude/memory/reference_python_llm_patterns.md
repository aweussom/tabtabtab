---
name: reference-python-llm-patterns
description: "Two sibling Python projects with battle-tested Ollama+Qwen integration patterns the user reuses across LLM work — strip-think-tags regex, retry/backoff defaults, system+user split, model+temperature defaults"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6ab1d93c-cd84-461f-8427-dac2793dd62b
---

When the user asks "look at how I do LLM calls elsewhere" or you need to wire up an LLM call in any of his projects, these two directories are the canonical reference:

- `C:\devel\aweussom\python\evaluator\` — battle-tested Ollama integration. Key files: `analyze_book.py` (retry/backoff, think-tag extraction, streaming-vs-nonstream fallback, OpenAI-compat client), `models.ini` (per-model temperature + context + timeout defaults).
- `C:\devel\aweussom\python\critique-llm\` — sibling project with same patterns. Key files: `shared/llm_provider.py` (`strip_reasoning_tags()` regex), `shared/ollama_client.py` (`/api/chat` → `/api/generate` fallback + error taxonomy), `shared/llama_client.py` (Ollama SDK usage).
- `C:\devel\aweussom\python\critique-llm\instructions_private\qwen\novels\` — multi-file numbered `.md` prompt structure (`01-system_prompt.md`, `02-...`, etc.) the user prefers for layering instructions.

**Defaults the user has converged on** (carry them forward verbatim unless there's a reason not to):
- Temperature **0.7** for Qwen3-family.
- Timeout **600 s** (covers Ollama cold-start when model isn't in VRAM yet).
- Retry: **3 attempts**, exponential backoff (base 5 s, max 60 s, 10 % jitter).
- Strip `<think>...</think>` AND `<reflection>...</reflection>` from response content before parsing — pattern `(?:<think>)?[\s\S]*?<\/think>\s*` handles both standard pairs AND the unclosed-opening variant (some models drop the opener but keep the closer).
- System + user message split (system: instructions; user: actual content). No Qwen `<|im_start|>` wrapping — SDK / OpenAI-compat endpoint handles it internally.
- Authorization header is **optional** — local Ollama doesn't need one, Ollama Cloud and Mimo do.

**Local Ollama**: runs on `http://localhost:11434` on the dev machine (RTX 5090, ~32 GB VRAM). `qwen3.6:latest` (36B MoE, Q4_K_M, ~24 GB) is the primary dev model. Other models pulled locally: `qwen3:8b`, `qwen3-embedding:4b`, `nemotron3:33b`, plus several `:cloud`-routed remote models.

Used by [[feedback-claude-md-keep-current]] reasoning when this project's `proxy/` needed to mimic existing patterns rather than invent a new shape (see `proxy/enrich.js`).
