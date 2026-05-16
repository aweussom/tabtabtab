#!/usr/bin/env python3
"""Build a `private-bundle.json` that ships with the web app.

Combines the raw UG export (`crawler/private/ug-import.json`) with the
LLM-enriched sidecar (`crawler/private/ug-enrichment.json`) into a single
file the web app loads at startup. Bundle contains:

  - All tabs, with bodies cleaned of UG's `[ch]X[/ch]` and `[tab]…[/tab]`
    wrappers (lossless — chord letter stays in the same column).
  - Synthetic artist + song entries derived from tab metadata so
    catalog.js's existing maps can absorb them with no shape change.
  - One pre-baked songbook ("Mine UG-importer") referencing every tab.

Run after the importer + enrichment have produced both inputs:

    python crawler/build-private-bundle.py

Output: `private-bundle.json` at repo root.

If `ug-enrichment.json` is missing, builds anyway with empty enrichment
overlays — the songbook + tabs still display correctly, just no
search-by-vibe coverage for the imports.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def slugify(s):
    """Match storage.js's slugify so artist/song IDs are stable across rebuilds."""
    s = s.lower()
    s = s.replace("ø", "o").replace("æ", "a").replace("å", "a")
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:40]


def clean_body(raw):
    """Strip UG's `[ch]X[/ch]` and `[tab]…[/tab]` wrapping markup.

    Lossless visually: chord letters stay in their original column positions
    because the wrapping tags are removed but the wrapped content is kept.
    Section markers like `[Verse]`, `[Chorus]`, `[Bridge]` are preserved —
    those are semantic, not wrapping.
    """
    raw = re.sub(r"\[/?ch\]", "", raw)
    raw = re.sub(r"\[/?tab\]", "", raw)
    return raw


def main():
    repo_root = Path(__file__).resolve().parent.parent
    import_path = repo_root / "crawler" / "private" / "ug-import.json"
    enrichment_path = repo_root / "crawler" / "private" / "ug-enrichment.json"
    out_path = repo_root / "private-bundle.json"

    if not import_path.exists():
        print(f"ABORT: {import_path} not found", file=sys.stderr)
        return 1

    data = json.loads(import_path.read_text(encoding="utf-8"))
    enrichment = (
        json.loads(enrichment_path.read_text(encoding="utf-8"))
        if enrichment_path.exists()
        else {"artists": {}, "songs": {}}
    )
    artist_enrichment = enrichment.get("artists", {})
    song_enrichment = enrichment.get("songs", {})

    bundle = {
        "version": 1,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": enrichment.get("model"),
        "songbook": {
            "id": "ug-import-main",
            "name": "Mine UG-importer",
            "tab_ids": [],
        },
        "tabs": {},
        "songs": {},
        "artists": {},
    }

    tabs = data.get("tabs") or []
    skipped_no_body = 0
    for tab in tabs:
        a = (tab.get("artist") or "").strip()
        s = (tab.get("song") or "").strip()
        tid = tab.get("id")
        body = tab.get("body")
        if not a or not s or not tid or not body:
            skipped_no_body += 1
            continue

        artist_id = f"ug-artist-{slugify(a)}"
        song_id = f"ug-song-{slugify(a)}__{slugify(s)}"

        if artist_id not in bundle["artists"]:
            bundle["artists"][artist_id] = {
                "id": artist_id,
                "name": a,
                "song_ids": [],
                "enrichment": artist_enrichment.get(artist_id, {}),
            }
        if song_id not in bundle["songs"]:
            bundle["songs"][song_id] = {
                "id": song_id,
                "name": s,
                "artist_id": artist_id,
                "tab_ids": [],
                "enrichment": song_enrichment.get(song_id, {}),
            }
            bundle["artists"][artist_id]["song_ids"].append(song_id)

        bundle["tabs"][tid] = {
            "id": tid,
            "song_id": song_id,
            "artist_id": artist_id,
            "body": clean_body(body),
            "chordnames": tab.get("chordnames") or [],
            "tab_type": tab.get("tab_type"),
            "source": tab.get("source"),
            "source_url": tab.get("source_url"),
        }
        bundle["songs"][song_id]["tab_ids"].append(tid)
        bundle["songbook"]["tab_ids"].append(tid)

    out_path.write_text(
        json.dumps(bundle, sort_keys=True, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {out_path} — "
        f"{len(bundle['tabs'])} tabs, {len(bundle['songs'])} songs, "
        f"{len(bundle['artists'])} artists. "
        f"Skipped {skipped_no_body} entries with missing fields."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
