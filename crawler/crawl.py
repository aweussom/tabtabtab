#!/usr/bin/env python3
"""nortabs.net catalog crawler. Polite (configurable delay), resumable via per-letter checkpoints.

Zero dependencies (stdlib only) — runs in GitHub Actions without a setup step.

Output shape (root catalog.json):
    {
      "crawled_at": "2026-05-14T19:33:00Z",
      "letters": {
        "a": { "artists": [{id, name, songs: [{id, name, tabs: [{id, body, ...}]}]}] },
        ...
      }
    }
"""
import argparse
import gzip
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://nortabs.net/api/v1"
DEFAULT_UA = (
    "NorTabsWebCrawler/1.0 "
    "(hobby project; contact: tommy.leonhardsen@q-free.com)"
)
DEFAULT_DELAY_MS = 100
# Norwegian alphabet adds æ, ø, å after z. nortabs.net's browse endpoint
# accepts these (URL-encoded). Digits last so the natural index order matches
# what users expect.
ALL_LETTERS = list("abcdefghijklmnopqrstuvwxyzæøå0123456789")


def fetch_json(url, user_agent, timeout=15):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json",
            "Referer": "https://nortabs.net/",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


PAGE_SIZE = 50  # API caps limit at 50; pages are 0-indexed.


def fetch_artists_for_letter(letter, delay_s, user_agent, log):
    """Paginate /collections/browse?sw={letter} until empty."""
    artists = []
    page = 0
    sw = urllib.parse.quote(letter)  # æ/ø/å need percent-encoding
    while True:
        url = f"{BASE}/collections/browse?sw={sw}&limit={PAGE_SIZE}&page={page}"
        batch = fetch_json(url, user_agent).get("collections", [])
        time.sleep(delay_s)
        if not batch:
            break
        artists.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return artists


def fetch_tab_body(tab, delay_s, user_agent, log):
    """Fetch a single tab's body. Returns the catalog tab dict or None on failure."""
    tid = tab["id"]
    try:
        tdata = fetch_json(f"{BASE}/tabs/tab?id={tid}", user_agent)
        time.sleep(delay_s)
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        log(f"    ! tab {tid} failed: {e}")
        time.sleep(delay_s)
        return None
    return {
        "id": tid,
        "tab_type_id": tab.get("tab_type_id"),
        "rating_stars": tab.get("rating_stars"),
        "uploaded_by_name": tab.get("uploaded_by_name"),
        "body": tdata.get("body", ""),
        "chordnames": tdata.get("chordnames"),
        "chordfingerings": tdata.get("chordfingerings"),
        "formatting_id": tdata.get("formatting_id"),
        "transposing": tdata.get("transposing"),
    }


def fetch_full_song(song, delay_s, user_agent, log, reuse_tabs=None):
    """Fetch a song's tab list and bodies. If `reuse_tabs` is provided,
    tabs whose ids are already there are reused without a body re-fetch."""
    sid, sname = song["id"], song["name"]
    try:
        sdata = fetch_json(f"{BASE}/songs/song?id={sid}", user_agent)
        time.sleep(delay_s)
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        log(f"  ! song {sid} failed: {e}")
        time.sleep(delay_s)
        return None
    reuse = {t["id"]: t for t in (reuse_tabs or [])}
    out_tabs = []
    for tab in sdata.get("tabs", []):
        existing = reuse.get(tab["id"])
        if existing is not None:
            out_tabs.append(existing)
            continue
        result = fetch_tab_body(tab, delay_s, user_agent, log)
        if result is not None:
            out_tabs.append(result)
    return {"id": sid, "name": sname, "tabs": out_tabs}


def fetch_full_artist(aid, aname, delay_s, user_agent, log):
    """Fetch an artist's collection + all songs + all tab bodies."""
    try:
        adata = fetch_json(
            f"{BASE}/collections/collection?id={aid}&songs=1", user_agent
        )
        time.sleep(delay_s)
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        log(f"  ! artist {aid} fetch failed: {e}")
        time.sleep(delay_s)
        return None
    songs = adata.get("songs") or adata.get("tabs") or []
    out_songs = []
    for song in songs:
        result = fetch_full_song(song, delay_s, user_agent, log)
        if result is not None:
            out_songs.append(result)
    return {"id": aid, "name": aname, "songs": out_songs}


def crawl_letter(letter, delay_s, user_agent, log):
    t0 = time.time()
    log(f"[{letter}] fetching artist list (paginated)")
    artists = fetch_artists_for_letter(letter, delay_s, user_agent, log)
    log(f"[{letter}] {len(artists)} artists")

    out_artists = []
    for ai, artist in enumerate(artists, 1):
        log(f"[{letter}] ({ai:>3}/{len(artists)}) {artist['name']}")
        result = fetch_full_artist(
            artist["id"], artist["name"], delay_s, user_agent, log
        )
        if result is not None:
            out_artists.append(result)

    n_songs = sum(len(a["songs"]) for a in out_artists)
    n_tabs = sum(len(s["tabs"]) for a in out_artists for s in a["songs"])
    elapsed = time.time() - t0
    log(
        f"[{letter}] done: {len(out_artists)} artists, "
        f"{n_songs} songs, {n_tabs} tabs in {elapsed:.1f}s"
    )
    return {"artists": out_artists}


def crawl_letter_incremental(letter, existing_bucket, delay_s, user_agent, log):
    """Diff the letter's /collections/browse list against the previous catalog
    bucket and fetch only what changed.

    Cheap signals from the API: every browse entry carries `tab_count` +
    `song_count` per artist, and `/collections/collection?id=X` carries
    `tab_count` per song. If those counts match what we already have, we skip
    deeper fetches entirely. A typical no-change night ends up at ~100 requests
    (one browse pass) rather than ~15 000.

    Caveat: a tab being replaced (one removed + one added, same count) is
    invisible to this diff. The Sunday full crawl catches those.
    """
    t0 = time.time()
    log(f"[{letter}] (incremental) fetching browse list")
    browse = fetch_artists_for_letter(letter, delay_s, user_agent, log)
    browse_by_id = {a["id"]: a for a in browse}
    existing_by_id = {a["id"]: a for a in (existing_bucket or {}).get("artists", [])}

    out_artists = []
    n_unchanged = n_new = n_changed = 0
    for ba in browse:
        aid, aname = ba["id"], ba["name"]
        existing = existing_by_id.get(aid)
        if existing is None:
            log(f"[{letter}] NEW artist: {aname}")
            result = fetch_full_artist(aid, aname, delay_s, user_agent, log)
            if result is not None:
                out_artists.append(result)
                n_new += 1
            continue

        ex_song_count = len(existing.get("songs", []))
        ex_tab_count = sum(len(s.get("tabs", [])) for s in existing.get("songs", []))
        if (
            ex_song_count == ba.get("song_count", -1)
            and ex_tab_count == ba.get("tab_count", -1)
        ):
            out_artists.append(existing)
            n_unchanged += 1
            continue

        log(
            f"[{letter}] CHANGED artist: {aname} "
            f"(songs {ex_song_count}->{ba.get('song_count')}, "
            f"tabs {ex_tab_count}->{ba.get('tab_count')})"
        )
        try:
            collection = fetch_json(
                f"{BASE}/collections/collection?id={aid}&songs=1", user_agent
            )
            time.sleep(delay_s)
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            log(f"  ! artist {aid} collection fetch failed: {e}; keeping old data")
            out_artists.append(existing)
            continue

        existing_songs_by_id = {s["id"]: s for s in existing.get("songs", [])}
        api_songs = collection.get("songs") or collection.get("tabs") or []
        out_songs = []
        for api_song in api_songs:
            sid = api_song["id"]
            api_tab_count = api_song.get("tab_count", 0)
            ex_song = existing_songs_by_id.get(sid)
            if ex_song is not None and len(ex_song.get("tabs", [])) == api_tab_count:
                out_songs.append(ex_song)
                continue
            result = fetch_full_song(
                api_song,
                delay_s,
                user_agent,
                log,
                reuse_tabs=(ex_song or {}).get("tabs"),
            )
            if result is not None:
                out_songs.append(result)
            elif ex_song is not None:
                out_songs.append(ex_song)
        out_artists.append({"id": aid, "name": aname, "songs": out_songs})
        n_changed += 1

    n_dropped = len(set(existing_by_id) - set(browse_by_id))
    elapsed = time.time() - t0
    log(
        f"[{letter}] incremental done: {len(out_artists)} artists "
        f"(unchanged={n_unchanged}, new={n_new}, changed={n_changed}, "
        f"dropped={n_dropped}) in {elapsed:.1f}s"
    )
    return {"artists": out_artists}


def write_json(path, obj):
    """Deterministic JSON: sorted keys, compact separators, utf-8 unescaped."""
    text = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")


def merge_checkpoints(checkpoint_dir, out_path, log):
    """Merge ALL checkpoint files in the directory, regardless of --letters.

    A partial crawl (e.g. `--letters å,æ,ø`) must not wipe the other letters
    from the merged catalog. We always read every `*.json` checkpoint and let
    them all in.
    """
    merged = {
        "crawled_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "letters": {},
    }
    for cp in sorted(checkpoint_dir.glob("*.json")):
        letter = cp.stem
        try:
            merged["letters"][letter] = json.loads(cp.read_text(encoding="utf-8"))
        except Exception as e:
            log(f"  ! could not read checkpoint {cp}: {e}")

    # Preserve the previous crawled_at when nothing else changed. Otherwise a
    # fresh timestamp every run makes catalog.json differ on every crawl, which
    # triggers a commit + push + Netlify rebuild even with zero new tabs.
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding="utf-8"))
            if prev.get("letters") == merged["letters"]:
                merged["crawled_at"] = prev.get("crawled_at", merged["crawled_at"])
        except Exception as e:
            log(f"  ! could not read existing {out_path} for diff: {e}")

    write_json(out_path, merged)
    raw = out_path.read_bytes()
    gz = gzip.compress(raw)
    log(
        f"merged {len(merged['letters'])} letters → {out_path} "
        f"({len(raw):,} B, gzip {len(gz):,} B)"
    )


def main():
    # On Windows, sys.stderr defaults to the active code page (cp1252) and mangles
    # non-ASCII names like "Bør Børson". Force UTF-8 so logs roundtrip cleanly.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    p = argparse.ArgumentParser(description="nortabs.net catalog crawler")
    p.add_argument(
        "--letters",
        default=",".join(ALL_LETTERS),
        help="comma-separated letters to crawl (default: all a-z + 0-9)",
    )
    p.add_argument("--delay-ms", type=int, default=DEFAULT_DELAY_MS)
    p.add_argument("--user-agent", default=DEFAULT_UA)
    p.add_argument("--checkpoint-dir", default="crawler/data")
    p.add_argument("--out", default="catalog.json")
    p.add_argument(
        "--merge-only",
        action="store_true",
        help="skip crawl, just merge existing checkpoints",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="re-crawl letters that already have a checkpoint",
    )
    p.add_argument(
        "--incremental",
        action="store_true",
        help=(
            "diff /collections/browse against existing catalog.json and only "
            "fetch artists/songs/tabs whose counts have changed. Much cheaper "
            "than a full crawl when little has changed upstream."
        ),
    )
    args = p.parse_args()

    letters = [l.strip().lower() for l in args.letters.split(",") if l.strip()]
    checkpoint_dir = Path(args.checkpoint_dir)
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out)
    delay_s = args.delay_ms / 1000.0

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    if args.incremental and args.merge_only:
        log("--incremental and --merge-only are mutually exclusive")
        sys.exit(2)

    if args.incremental:
        if not out_path.exists():
            log(
                f"--incremental requires an existing {out_path}; "
                "run a full crawl first."
            )
            sys.exit(2)
        existing = json.loads(out_path.read_text(encoding="utf-8"))
        existing_letters = existing.get("letters", {})
        # Seed checkpoints so a partial run still merges into a complete catalog:
        # any letter we don't reach today keeps its existing bucket.
        for letter, bucket in existing_letters.items():
            cp = checkpoint_dir / f"{letter}.json"
            if not cp.exists():
                write_json(cp, bucket)
        for letter in letters:
            cp = checkpoint_dir / f"{letter}.json"
            existing_bucket = existing_letters.get(letter)
            try:
                result = crawl_letter_incremental(
                    letter, existing_bucket, delay_s, args.user_agent, log
                )
            except Exception as e:
                log(f"[{letter}] incremental FAILED: {e}; keeping existing bucket")
                continue
            write_json(cp, result)
            log(f"[{letter}] wrote {cp}")
    elif not args.merge_only:
        for letter in letters:
            cp = checkpoint_dir / f"{letter}.json"
            if cp.exists() and not args.force:
                log(f"[{letter}] checkpoint exists, skip (--force to re-crawl)")
                continue
            try:
                result = crawl_letter(letter, delay_s, args.user_agent, log)
            except Exception as e:
                log(f"[{letter}] FAILED: {e}")
                continue
            write_json(cp, result)
            log(f"[{letter}] wrote {cp}")

    merge_checkpoints(checkpoint_dir, out_path, log)


if __name__ == "__main__":
    main()
