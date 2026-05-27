#!/usr/bin/env python3
"""One-shot: split the legacy single-file enrichment.json into per-letter files
under enrichment/<letter>.json. Run once after refactoring enrich.py to use
per-letter outputs.

Reads catalog.json to determine which letter each artist/song belongs to.
Leaves enrichment.json in place — it gets overwritten by merge-enrichment.py
the next time it runs anyway.

Idempotent: re-running merges existing per-letter files with whatever the
legacy file contains (legacy entries win on conflict — they're newer if
this script just ran after a legacy-mode enrich run).
"""
import argparse
import json
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description="Migrate single-file enrichment to per-letter")
    p.add_argument("--catalog", default="catalog.json")
    p.add_argument("--in", dest="in_file", default="enrichment.json")
    p.add_argument("--out-dir", default="enrichment")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    in_path = Path(args.in_file)
    out_dir = Path(args.out_dir)
    catalog_path = Path(args.catalog)

    if not in_path.exists():
        print(f"input not found: {in_path}", file=sys.stderr)
        sys.exit(1)
    if not catalog_path.exists():
        print(f"catalog not found: {catalog_path}", file=sys.stderr)
        sys.exit(1)

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    enrichment = json.loads(in_path.read_text(encoding="utf-8"))

    # Build lookup: artistId/songId → letter
    artist_letter = {}
    song_letter = {}
    for letter, bucket in (catalog.get("letters") or {}).items():
        for artist in bucket.get("artists", []):
            artist_letter[str(artist["id"])] = letter
            for song in artist.get("songs", []):
                song_letter[str(song["id"])] = letter

    by_letter = {}  # letter → {"artists": {}, "songs": {}}
    orphan_artists = 0
    orphan_songs = 0

    for aid, data in (enrichment.get("artists") or {}).items():
        letter = artist_letter.get(aid)
        if letter is None:
            orphan_artists += 1
            continue
        by_letter.setdefault(letter, {"artists": {}, "songs": {}})["artists"][aid] = data

    for sid, data in (enrichment.get("songs") or {}).items():
        letter = song_letter.get(sid)
        if letter is None:
            orphan_songs += 1
            continue
        by_letter.setdefault(letter, {"artists": {}, "songs": {}})["songs"][sid] = data

    print(f"split {sum(len(d['artists']) for d in by_letter.values())} artists + "
          f"{sum(len(d['songs']) for d in by_letter.values())} songs across "
          f"{len(by_letter)} letters", file=sys.stderr)
    if orphan_artists or orphan_songs:
        print(f"orphans skipped (id not in catalog): "
              f"{orphan_artists} artists, {orphan_songs} songs", file=sys.stderr)

    if args.dry_run:
        print("[dry-run] no files written", file=sys.stderr)
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    for letter in sorted(by_letter.keys()):
        data = by_letter[letter]
        # Merge with existing per-letter file if present (legacy entries win
        # on conflict — they're presumed newer).
        existing_path = out_dir / f"{letter}.json"
        if existing_path.exists():
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
            merged_artists = {**(existing.get("artists") or {}), **data["artists"]}
            merged_songs = {**(existing.get("songs") or {}), **data["songs"]}
        else:
            merged_artists = data["artists"]
            merged_songs = data["songs"]
        out = {
            "version": 1,
            "letter": letter,
            "model": enrichment.get("model"),
            "enriched_at": enrichment.get("enriched_at"),
            "artists": merged_artists,
            "songs": merged_songs,
        }
        text = json.dumps(out, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        existing_path.write_text(text, encoding="utf-8")
        print(f"  wrote {existing_path} ({len(merged_artists)} artists, "
              f"{len(merged_songs)} songs)", file=sys.stderr)


if __name__ == "__main__":
    main()
