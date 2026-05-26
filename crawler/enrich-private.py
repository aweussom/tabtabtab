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
    p.add_argument("--cli", default=DEFAULT_CLI,
                   help="LLM CLI invocation (default: 'claude -p --model sonnet')")
    p.add_argument("--model-tag", default=DEFAULT_MODEL_TAG)
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
    cli_cmd = args.cli.split()
    in_path = Path(args.input)
    out_path = Path(args.output)

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
            resp = call_llm(cli_cmd, prompt + STRICT_SUFFIX)
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
        save_state(out_path, state, args.model_tag)
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
        save_state(out_path, state, args.model_tag)
        if args.limit and done >= args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            return 0

    print(f"\nDone. {len(state['artists'])} artists, {len(state['songs'])} songs in {out_path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
