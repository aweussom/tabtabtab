# NorTabs proxy (Phase 2.5 PoC)

Thin LLM passthrough + shared metadata cache for the UG-import enrichment flow. See `PLAN.md` "Phase 2.5 — Thin LLM proxy for UG-import enrichment" for the full design and rationale.

## Quick start (PowerShell 7 on Windows 11)

```powershell
cd proxy
Copy-Item .env.example .env
node server.js
```

(No `npm install` needed — the PoC has zero npm dependencies. Cache is a plain JSON file written via `node:fs`.)

Health check from another PowerShell window:

```powershell
Invoke-RestMethod -Uri http://localhost:8787/health
```

Enrich-tab call (stub mode — no API key needed):

```powershell
$body = @{
  artist = 'Elton John'
  song = 'Country Comfort'
  body = "Country Comfort chords`nElton John 1970"
  chordnames = @('A', 'D', 'Bm', 'G', 'E', 'F', 'C', 'Am', 'F#m', 'B', 'Em')
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:8787/enrich-tab -Method POST `
  -ContentType 'application/json' -Body $body
```

First call returns `cache: 'miss'` + canned enrichment; second call with same `(artist, song)` returns `cache: 'hit'` instantly. That validates the server + cache flow end-to-end without burning LLM credits.

## Going from stub to real LLM

Edit `.env`, set `PROXY_API_BASE` + `PROXY_MODEL` (and `PROXY_API_KEY` if the upstream requires one — local Ollama doesn't), restart the server. Server detects `PROXY_API_BASE` on startup and switches off stub mode. Same request shape, real enrichment in the response.

Three supported upstreams (see `.env.example` for full snippets):

| Upstream | API base | Auth |
|---|---|---|
| Local Ollama (e.g. RTX 5090 + `qwen3.6:latest`) | `http://localhost:11434/v1` | none |
| Ollama Cloud | `https://ollama.com/v1` | Bearer key |
| Mimo V2 Pro | `https://api.mimo.xiaomi.com/v1` | Bearer key |

All three speak OpenAI-compatible `/chat/completions` — server doesn't branch on backend.

The proxy is tuned for Qwen3-family quirks observed in the user's existing Python pipelines (`C:/devel/aweussom/python/evaluator` + `critique-llm`):

- Temperature defaults to `0.7` (Qwen3 sweet spot for these workloads).
- `<think>...</think>` and `<reflection>...</reflection>` blocks are stripped from response content before JSON parsing.
- Markdown fences (` ```json ... ``` `) are stripped defensively.
- 600 s timeout (covers Ollama cold-start when the model isn't in VRAM yet).
- 3-attempt exponential backoff with jitter on LLM errors (5 s base, 60 s max).

## Architecture

- `server.js` — `node:http` server, routes, CORS allowlist from env, body-content never logged.
- `enrich.js` — LLM passthrough. Stub mode returns canned data; real mode POSTs to OpenAI-compatible `/chat/completions`.
- `cache.js` — JSON file on disk, atomic tmp+rename on every put/del, full in-memory mirror at startup. Keyed by `sha256(normalized(artist) + '|' + normalized(song))`. Chosen over SQLite for portability (one human-readable file, no binary blob, no WAL siblings, trivial to bundle into the static web app for pre-warmed enrichment shipping).
- `shared/normalize.js` — title/artist normalization. Same file is imported verbatim by the browser client so server and client cannot drift on cache keys.
- `shared/hash-key.js` — sha256 derivation. Web Crypto in the browser, `node:crypto` on the server.

## Endpoints

### `POST /enrich-tab`

Request:
```json
{ "artist": "Elton John", "song": "Country Comfort", "body": "...", "chordnames": ["A","D","Bm"] }
```

Response (cache miss):
```json
{
  "enrichment": { "search_text": "...", "themes": [...], "mood": [...], ... },
  "cache": "miss",
  "model_used": "stub"
}
```

Headers (optional):
- `X-Force-Refresh: 1` — bypass cache, force a fresh LLM call. Used during prompt development.

### `GET /health`

Returns server status + stub/real mode + cache row count.

### `DELETE /cache/:key`

Dev-only. Deletes a single cache entry by its sha256 key. Disabled in production by `NODE_ENV=production`.

## Data hygiene

- Server logs `(artist, song, model, cache_hit, ms_taken, token_count)` only. Body content is **never** logged.
- Body is dropped after the LLM call returns; only the derived enrichment metadata is persisted. Same legal posture as `PLAN.md` Phase 5+.
