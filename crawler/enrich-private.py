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

    # Enrich artists
    for name, aid in todo_artists:
        print(f"[artist] {name}")
        prompt = ARTIST_PROMPT.format(name=name)
        try:
            resp = call_llm(cli_cmd, prompt)
            state["artists"][aid] = extract_json(resp)
            done += 1
        except Exception as e:
            print(f"  FAIL: {e}", file=sys.stderr)
            state["artists"][aid] = {"search_text": name.lower()}
        save_state(out_path, state, args.model_tag)
        if args.limit and done >= args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            return 0

    # Enrich songs
    for sid, (a, s) in todo_songs:
        print(f"[song] {a} — {s}")
        body = body_by_song_id.get(sid, "")[:800]
        prompt = SONG_PROMPT.format(artist=a, song=s, body=body)
        try:
            resp = call_llm(cli_cmd, prompt)
            state["songs"][sid] = extract_json(resp)
            done += 1
        except Exception as e:
            print(f"  FAIL: {e}", file=sys.stderr)
            state["songs"][sid] = {"search_text": f"{s} {a}".lower()}
        save_state(out_path, state, args.model_tag)
        if args.limit and done >= args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            return 0

    print(f"\nDone. {len(state['artists'])} artists, {len(state['songs'])} songs in {out_path}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
