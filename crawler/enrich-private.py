#!/usr/bin/env python3
"""LLM enrichment for private-tabs imports (UG bookmarks, Word docs, etc.).

Reads `crawler/private/ug-import.json`, calls Claude on every unique
artist and every unique (artist, song) pair, writes results incrementally
to `crawler/private/ug-enrichment.json` (resumable per-entry).

Reuses prompts + helpers from `enrich.py`. Same single-LLM serial pattern;
the volume here is small (typically <300 entries from one user) so we
don't need the per-letter parallelization the catalog enricher has.

Typical use:
    # First-time enrichment of the whole import:
    python crawler/enrich-private.py

    # Continue an interrupted run (resumable — skips already-enriched):
    python crawler/enrich-private.py

    # Force re-enrich everything:
    python crawler/enrich-private.py --force

    # Use a different CLI subscription:
    python crawler/enrich-private.py --cli "copilot suggest"
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Reuse the catalog enricher's prompts + helpers verbatim.
from enrich import (
    ARTIST_PROMPT, SONG_PROMPT, DEFAULT_CLI, DEFAULT_MODEL_TAG,
    call_llm, extract_json, reconfigure_streams,
)

# Optional — only needed for --ollama mode. Importing lazily would be
# cleaner but this script is small and the failure message is clearer
# when we report it up-front.
try:
    import requests as _requests
except ImportError:
    _requests = None

# Ollama-mode defaults. The default model is the bench v2 winner — see
# PLAN.md Phase 2.5 "Bench v2 update" and NOLLAMA-DEPLOY-PLAN.md Phase 3
# for the rationale (100% schema-compliance, 100% kp hit-rate, fastest
# of the top-quality tier). Override with --ollama-model when iterating.
DEFAULT_OLLAMA_BASE = "http://localhost:11434/v1"
DEFAULT_OLLAMA_MODEL = "deepseek-v4-flash:cloud"
OLLAMA_SYSTEM_MSG = (
    "You enrich a guitar-tab catalog with search metadata for a web app. "
    "Output ONE JSON object only — no markdown fences, no commentary, no "
    "surrounding text."
)
# Strip reasoning-model think blocks defensively. Mirrors the same regex
# used in proxy/enrich.js and crawler/enrich-bench.py — see
# reference_python_llm_patterns memory.
_THINK_RE = re.compile(r"(?:<think>)?[\s\S]*?</think>\s*", re.IGNORECASE)
_REFLECT_RE = re.compile(r"<reflection>[\s\S]*?</reflection>\s*", re.IGNORECASE)


def call_ollama(model, user_msg, base_url=DEFAULT_OLLAMA_BASE,
                temperature=0.7, timeout=600):
    """OpenAI-compat /chat/completions against local Ollama daemon (which
    transparently routes :cloud-suffixed models to Ollama Cloud).
    Returns the response content string, with think-tag stripping.
    Raises on HTTP error or empty content."""
    if _requests is None:
        raise RuntimeError(
            "--ollama mode requires the `requests` package "
            "(pip install requests)"
        )
    url = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": OLLAMA_SYSTEM_MSG},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "temperature": temperature,
    }
    resp = _requests.post(url, json=payload, timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(
            f"Ollama HTTP {resp.status_code}: {resp.text[:200]}"
        )
    data = resp.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("Empty content in LLM response")
    content = _THINK_RE.sub("", content)
    content = _REFLECT_RE.sub("", content)
    return content.strip()

# Appended to every prompt — the catalog enricher's prompts are kept
# unchanged. The catalog has tuned its prompt against thousands of entries
# already; private imports need extra brevity discipline because Claude
# sometimes goes verbose on songs (especially well-known ones with rich
# context) and gets output-truncated mid-string, breaking JSON parsing.
STRICT_SUFFIX = (
    "\n\nCRITICAL: Output MUST be exactly one valid JSON object that ends with `}`. "
    "search_text MUST be 30-50 words MAXIMUM — be concise. "
    "If you find yourself listing many synonyms, stop after the most useful ones. "
    "Never emit prose before or after the JSON."
)


def _balance_text(text):
    """Walk the text once, tracking unescaped string-state and brace/bracket depth.
    Returns (depth, brackets, in_str). Used by salvage_truncated_json."""
    in_str = False
    escape = False
    depth = 0
    brackets = 0
    for ch in text:
        if escape:
            escape = False
            continue
        if in_str:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "[":
            brackets += 1
        elif ch == "]":
            brackets -= 1
    return depth, brackets, in_str


def salvage_truncated_json(text):
    """Best-effort recovery for LLM output that was truncated mid-string.

    Walks the text once to find unbalanced quotes and braces, then appends
    the necessary closers. Won't fix every truncation (e.g. mid-key or
    mid-array-numeric-literal) but handles the common case where Claude
    runs over the output budget while producing search_text.
    Returns a parseable JSON dict, or None if salvage isn't feasible.
    """
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    start = text.find("{")
    if start < 0:
        return None
    text = text[start:]
    depth, brackets, in_str = _balance_text(text)
    if depth <= 0 and brackets <= 0 and not in_str:
        # Already balanced — extract_json should have handled it. Don't salvage.
        return None
    salvaged = text
    if in_str:
        salvaged += '"'
    while brackets > 0:
        salvaged += "]"
        brackets -= 1
    while depth > 0:
        salvaged += "}"
        depth -= 1
    try:
        return json.loads(salvaged)
    except json.JSONDecodeError:
        return None


def is_thin_fallback(entry, query_text):
    """True if `entry` matches the thin-fallback shape we write on enrich failure.
    Used by --retry-thin to identify which entries to re-process.
    """
    if not isinstance(entry, dict):
        return True
    keys = set(entry.keys())
    if keys != {"search_text"}:
        return False
    return entry.get("search_text") == query_text


def slugify(s):
    """Match storage.js's slugify so artist/song IDs are stable across rebuilds."""
    s = s.lower()
    s = s.replace("ø", "o").replace("æ", "a").replace("å", "a")
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:40]


def load_state(out_path):
    if not out_path.exists():
        return {
            "version": 1,
            "enriched_at": None,
            "model": None,
            "artists": {},
            "songs": {},
        }
    return json.loads(out_path.read_text(encoding="utf-8"))


def save_state(out_path, state, model_tag):
    state["enriched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state["model"] = model_tag
    out_path.write_text(
        json.dumps(state, sort_keys=True, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="crawler/private/ug-import.json")
    p.add_argument("--output", default="crawler/private/ug-enrichment.json")
    # CLI mode (default — shells out to `claude -p` or similar)
    p.add_argument("--cli", default=DEFAULT_CLI,
                   help="LLM CLI invocation (default: 'claude -p --model sonnet'). "
                        "Ignored when --ollama is set.")
    p.add_argument("--model-tag", default=DEFAULT_MODEL_TAG,
                   help="Tag written to the output file's `model` field in CLI mode. "
                        "Ollama mode uses --ollama-model verbatim.")
    # Ollama HTTP mode (--ollama → bypass CLI shell-out, call Ollama API directly)
    p.add_argument("--ollama", action="store_true",
                   help="Call Ollama HTTP API directly (OpenAI-compat) instead of "
                        "shelling out to a CLI. Use this for batch runs against "
                        f"Ollama Cloud (default model: {DEFAULT_OLLAMA_MODEL}).")
    p.add_argument("--ollama-base", default=DEFAULT_OLLAMA_BASE,
                   help=f"Ollama OpenAI-compat base URL (default: {DEFAULT_OLLAMA_BASE})")
    p.add_argument("--ollama-model", default=DEFAULT_OLLAMA_MODEL,
                   help=f"Model name passed to Ollama (default: {DEFAULT_OLLAMA_MODEL}). "
                        "Use `:cloud`-suffixed names to route through Ollama Cloud.")
    # Run control
    p.add_argument("--force", action="store_true",
                   help="Re-enrich entries that already have output")
    p.add_argument("--retry-thin", action="store_true",
                   help="Re-enrich only entries that got the thin fallback (search_text-only) in a previous run")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop after N successful enrichments (0 = no limit)")
    p.add_argument("--dry-run", action="store_true",
                   help="List what would be enriched; don't call LLM")
    return p.parse_args()


def main():
    reconfigure_streams()
    args = parse_args()
    in_path = Path(args.input)
    out_path = Path(args.output)

    # Build the LLM caller closure once, based on flags. Single source of
    # truth — enrich_one calls call_fn(prompt) without caring whether the
    # backend is a CLI subprocess or an HTTP request.
    if args.ollama:
        def call_fn(prompt_text):
            return call_ollama(args.ollama_model, prompt_text,
                               base_url=args.ollama_base)
        model_tag = args.ollama_model
        print(f"Mode: Ollama HTTP ({args.ollama_model} via {args.ollama_base})")
    else:
        cli_cmd = args.cli.split()
        def call_fn(prompt_text):
            return call_llm(cli_cmd, prompt_text)
        model_tag = args.model_tag
        print(f"Mode: CLI subprocess ({args.cli})")

    if not in_path.exists():
        print(f"ABORT: input file not found: {in_path}", file=sys.stderr)
        return 1

    data = json.loads(in_path.read_text(encoding="utf-8"))
    tabs = data.get("tabs") or []
    if not tabs:
        print(f"ABORT: no tabs in {in_path}", file=sys.stderr)
        return 1

    state = load_state(out_path)
    if args.force:
        state["artists"] = {}
        state["songs"] = {}

    # Collect unique artists and (artist, song) pairs from the import.
    artists = {}  # name -> artist_id
    songs = {}    # song_id -> (artist_name, song_name)
    for tab in tabs:
        a = tab.get("artist") or ""
        s = tab.get("song") or ""
        if not a or not s:
            continue
        aid = f"ug-artist-{slugify(a)}"
        sid = f"ug-song-{slugify(a)}__{slugify(s)}"
        artists.setdefault(a, aid)
        songs.setdefault(sid, (a, s))

    print(f"Loaded {len(tabs)} tabs → {len(artists)} unique artists, {len(songs)} unique songs.")
    if args.retry_thin:
        # Only re-process entries that match the thin-fallback shape.
        todo_artists = [(name, aid) for name, aid in artists.items()
                        if is_thin_fallback(state["artists"].get(aid), name.lower())]
        todo_songs = [(sid, (a, s)) for sid, (a, s) in songs.items()
                      if is_thin_fallback(state["songs"].get(sid), f"{s} {a}".lower())]
    else:
        todo_artists = [(name, aid) for name, aid in artists.items() if aid not in state["artists"]]
        todo_songs = [(sid, ans) for sid, ans in songs.items() if sid not in state["songs"]]
    print(f"To enrich: {len(todo_artists)} artists, {len(todo_songs)} songs.")

    if args.dry_run:
        for name, aid in todo_artists[:10]:
            print(f"  artist: {name}  →  {aid}")
        for sid, (a, s) in todo_songs[:10]:
            print(f"  song:   {a} — {s}  →  {sid}")
        print("(dry-run — no LLM calls)")
        return 0

    done = 0
    body_by_song_id = {}
    for tab in tabs:
        a = tab.get("artist") or ""
        s = tab.get("song") or ""
        if not a or not s:
            continue
        sid = f"ug-song-{slugify(a)}__{slugify(s)}"
        # Keep the longest body as the most informative sample
        existing = body_by_song_id.get(sid, "")
        body = tab.get("body") or ""
        if len(body) > len(existing):
            body_by_song_id[sid] = body

    def enrich_one(label, prompt, fallback):
        """Call LLM, try strict parse, then salvage truncated output, else fallback."""
        resp = None
        try:
            resp = call_fn(prompt + STRICT_SUFFIX)
            return extract_json(resp), False
        except Exception as strict_err:
            salvaged = salvage_truncated_json(resp)
            if salvaged is not None:
                print(f"  SALVAGED: closed truncated JSON for {label}", file=sys.stderr)
                return salvaged, True
            print(f"  FAIL: {strict_err}", file=sys.stderr)
            return fallback, False

    # Enrich artists
    for name, aid in todo_artists:
        print(f"[artist] {name}")
        result, _salvaged = enrich_one(
            label=name,
            prompt=ARTIST_PROMPT.format(name=name),
            fallback={"search_text": name.lower()},
        )
        state["artists"][aid] = result
        done += 1
        save_state(out_path, state, model_tag)
        if args.limit and done >= args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            return 0

    # Enrich songs
    for sid, (a, s) in todo_songs:
        print(f"[song] {a} — {s}")
        # Full body — no truncation. Ollama Cloud flat-rate sub makes token
        # cost irrelevant, and the LLM needs the actual lyrics (which were
        # getting truncated out when blurb consumed the first 400-800 chars).
        # See PLAN.md Phase 2.5 "Bench v2 update" for the empirical proof.
        body = body_by_song_id.get(sid, "")
        result, _salvaged = enrich_one(
            label=f"{a} — {s}",
            prompt=SONG_PROMPT.format(artist=a, song=s, body=body),
            fallback={"search_text": f"{s} {a}".lower()},
        )
        state["songs"][sid] = result
        done += 1
        save_state(out_path, state, model_tag)
        if args.limit and done >= args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            return 0

    print(f"\nDone. {len(state['artists'])} artists, {len(state['songs'])} songs in {out_path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
