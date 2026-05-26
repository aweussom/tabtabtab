#!/usr/bin/env python3
"""Local LLM enrichment for the nortabs-web catalog.

Reads `catalog.json`, diffs against `enrichment.json`, and enriches missing
artist/song entries by invoking a local LLM CLI (default: `claude -p`).
Writes incrementally so a crash never loses work. Idempotent: re-runs skip
already-enriched entries unless --force.

Designed to run as a local cron job on Tommy's machine — keeps the LLM-API
cost out of GitHub Actions and lets him use whichever local CLI subscription
he prefers (claude-code with Sonnet 4.6 or copilot-cli with Haiku).

Typical use:
    # First-time dry run to see what would be enriched:
    python crawler/enrich.py --dry-run --limit 5

    # Small real run to inspect output quality:
    python crawler/enrich.py --limit 5 --types artist

    # Full enrichment of everything missing:
    python crawler/enrich.py

    # Override the CLI command:
    python crawler/enrich.py --cli "copilot suggest"

Zero dependencies (stdlib only).
"""
import argparse
import json
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CLI = "claude -p --model sonnet"
DEFAULT_MODEL_TAG = "claude-sonnet-4-6"

ARTIST_PROMPT = """\
You are enriching a Norwegian guitar-tab catalog with search metadata for a web app.
Output ONE JSON object only — no markdown fences, no commentary, no surrounding text.

Artist name: {name}

Produce JSON with these fields (all optional except search_text):
{{
  "search_text": "flat string of lowercase keywords blending Norwegian and English: artist name(s), aliases, country, region, era (decade), genre tags, similar artists. 30-60 words.",
  "country": "norge | uk | usa | sverige | ...",
  "region": "optional city/region",
  "era": "e.g. '1990-2010', '1950-1970'",
  "genre": ["pop", "folk", "rock", ...],
  "notable": "one-line note if there is something noteworthy",
  "similar": ["artists similar in style"]
}}

Rules:
- If you do not know the artist, output minimal JSON: {{"search_text": "<artist name lowercased>"}}.
- For Norwegian artists: include both Norwegian and English mood/genre terms in search_text.
- For artists you do know, lean toward broad recall — include common misspellings and aliases.
- No markdown fences. No commentary. Just the JSON object.
"""

SONG_PROMPT = """\
You are enriching a Norwegian guitar-tab catalog with search metadata for a web app.
Output ONE JSON object only — no markdown fences, no commentary, no surrounding text.

Artist: {artist}
Song: {song}
Tab body (verbatim from the source; may contain UG legal preambles, USENET-era
email headers, tabber commentary, capo/tuning notes, and tabber signatures
alongside chord notation and actual lyrics):
---
{body}
---

Produce JSON with these fields (all optional except search_text):
{{
  "search_text": "flat lowercase keywords blending Norwegian and English: themes, mood, occasion, alt-titles, key lyric phrases. 30-80 words.",
  "language": "norsk | english | mixed | unknown",
  "themes": ["love", "heartbreak", "childhood", "faith", ...],
  "mood": ["melancholy", "joyful", "anthemic", "trist", "lystig", ...],
  "occasion": ["wedding", "christmas", "funeral", "breakup", ...],
  "alt_titles": {{"no": "...", "en": "..."}},
  "key_phrases": ["3-5 memorable lyric phrases from the body, verbatim or near-verbatim"],
  "display_suppress": [0, 1, 2]
}}

Rules:
- Focus on LYRIC content when deriving themes/mood/key_phrases. Ignore chord
  notation, fingering diagrams, legal preambles, email headers, tabber notes.
- For Norwegian songs: include English equivalents of mood/genre/themes in search_text.
- For English songs: include Norwegian equivalents.
- key_phrases must come from the body text (verbatim or very close).
- display_suppress: 0-indexed line numbers in `body.split("\\n")` that are NOT
  part of the song itself — UG `#PLEASE NOTE` legal preambles, USENET-era
  email headers (From:/To:/Subject:/Date:/Message-Id:), tabber commentary
  paragraphs, capo/tuning notes, author signatures, separator lines. Do NOT
  include chord-only lines, [tab]...[/tab] fingering diagrams, or section
  markers like [Intro]/[Verse]/[Chorus] — those ARE part of the tab. Empty
  array is correct when the body has no noise to suppress.
- No markdown fences. No commentary. Just the JSON object.
"""

# Optional lenient JSON parser. Local-enrichment-only dependency; not used
# by the shipped web app or the GitHub Action crawler.
try:
    import json5 as _json5
except ImportError:
    _json5 = None


def _first_balanced_json_block(text):
    """Return the substring of `text` from the first balanced top-level
    `{...}` block, or None if no balanced block exists.

    String-aware: braces inside double-quoted JSON strings (with backslash
    escapes) don't shift the brace count. This is what stops "Extra data"
    errors when an LLM emits a clean object followed by trailing prose
    that happens to contain stray braces.
    """
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if escape:
            escape = False
            continue
        if in_str:
            if ch == '\\':
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}' and depth > 0:
            depth -= 1
            if depth == 0 and start != -1:
                return text[start:i + 1]
    return None


def reconfigure_streams():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def call_llm(cli_cmd, prompt, timeout=120):
    """Run cli_cmd with prompt appended as a final argv. Returns stdout."""
    cmd = list(cli_cmd) + [prompt]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8"
    )
    if result.returncode != 0:
        snippet = (result.stderr or result.stdout or "")[:500]
        raise RuntimeError(f"CLI failed (rc={result.returncode}): {snippet}")
    return result.stdout


def extract_json(text):
    """Best-effort JSON extraction tolerant of LLM glitches.

    Strategy:
      1. Strip code fences if present.
      2. Try strict `json.loads` on the full text (happy path — covers
         the case where the LLM followed instructions perfectly).
      3. Fall back to a string-aware balanced `{...}` finder so trailing
         commentary or a second emitted object doesn't poison the parse
         ("Extra data" errors).
      4. Parse the extracted block with strict json first; if that still
         fails, retry with `json5` if installed (handles unquoted keys,
         single quotes, trailing commas, comments).
    """
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    block = _first_balanced_json_block(text)
    if block is None:
        raise ValueError(f"No JSON object in LLM output: {text[:200]}")
    try:
        return json.loads(block)
    except json.JSONDecodeError as strict_err:
        if _json5 is None:
            raise ValueError(
                f"Strict JSON parse failed and json5 is not installed "
                f"(`pip install json5`). Block: {block[:200]} — {strict_err}"
            )
        return _json5.loads(block)


def load_enrichment(path):
    """Legacy single-file loader (kept for backward compat / migrate script)."""
    if not path.exists():
        return {"version": 1, "enriched_at": None, "model": None, "artists": {}, "songs": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("artists", {})
    data.setdefault("songs", {})
    return data


def write_enrichment(path, data, model_tag):
    """Legacy single-file writer (kept for backward compat / migrate script)."""
    data["enriched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data["model"] = model_tag
    data.setdefault("version", 1)
    text = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")


def clear_all_letter_locks(out_dir):
    """Delete every <letter>.lock file under out_dir. Use after a crash or
    Ctrl+C left stale locks behind."""
    if not out_dir.exists():
        return 0
    n = 0
    for f in out_dir.glob("*.lock"):
        try:
            f.unlink()
            n += 1
        except FileNotFoundError:
            pass
    return n


def try_acquire_letter_lock(out_dir, letter, stale_sec=3600):
    """Atomic-create `<out_dir>/<letter>.lock`. Returns True if we own the lock.

    If an existing lock file is older than `stale_sec`, it's deleted and we
    try again — handles processes that crashed without releasing.
    """
    import os
    lock_path = out_dir / f"{letter}.lock"
    out_dir.mkdir(parents=True, exist_ok=True)
    if lock_path.exists():
        try:
            age = time.time() - lock_path.stat().st_mtime
            if age > stale_sec:
                lock_path.unlink()
        except FileNotFoundError:
            pass
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(
                f"{os.getpid()}\n"
                f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
            )
        return True
    except FileExistsError:
        return False


def release_letter_lock(out_dir, letter):
    lock_path = out_dir / f"{letter}.lock"
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


def load_letter(out_dir, letter):
    p = out_dir / f"{letter}.json"
    if not p.exists():
        return {"version": 1, "letter": letter, "artists": {}, "songs": {}}
    data = json.loads(p.read_text(encoding="utf-8"))
    data.setdefault("artists", {})
    data.setdefault("songs", {})
    return data


def save_letter(out_dir, letter, data, model_tag):
    data["enriched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data["model"] = model_tag
    data.setdefault("version", 1)
    data.setdefault("letter", letter)
    p = out_dir / f"{letter}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    p.write_text(text, encoding="utf-8")


def iter_entries(catalog, letters_filter=None, reverse=False):
    """Yields ('artist'|'song', id, payload, letter) tuples in catalog order.

    `letters_filter`: optional iterable of letter codes ('a','b','å',...) to
    restrict iteration to. None = all letters.
    `reverse`: True = iterate letters in reverse (useful when running two
    enrichers in parallel from opposite ends so they meet in the middle).
    """
    all_letters = catalog.get("letters") or {}
    wanted = None if letters_filter is None else set(letters_filter)
    items = list(all_letters.items())
    if reverse:
        items = list(reversed(items))
    for letter, bucket in items:
        if wanted is not None and letter not in wanted:
            continue
        for artist in bucket.get("artists", []):
            yield ("artist", artist["id"], artist, letter)
            for song in artist.get("songs", []):
                yield ("song", song["id"], {"artist_name": artist["name"], "song": song}, letter)


QUOTA_CACHE_PATH = Path.home() / ".claude" / "quota-data.json"


def _parse_resets_in(s):
    """Parse claude-code-quota's 'resets_in' strings like '1 hr 12 min', '47 min',
    '2 hr' into seconds. Returns 3600 (1 hr) as a safe default if unparseable."""
    if not s:
        return 3600
    total = 0
    found_any = False
    m = re.search(r"(\d+)\s*hr", s)
    if m:
        total += int(m.group(1)) * 3600
        found_any = True
    m = re.search(r"(\d+)\s*min", s)
    if m:
        total += int(m.group(1)) * 60
        found_any = True
    return total if found_any and total > 0 else 3600


def read_quota():
    """Read ~/.claude/quota-data.json. Returns dict with keys
    `pct` (5h usage %, int or None), `resets_in` (str or None), `stale` (bool),
    or None if the file is missing/unreadable.

    Cache is maintained by claude-code-quota; freshness depends on the user
    having a Claude Code session running (statusline refreshes drive updates).
    """
    if not QUOTA_CACHE_PATH.exists():
        return None
    try:
        data = json.loads(QUOTA_CACHE_PATH.read_text(encoding="utf-8"))
        return {
            "pct": data.get("quota_used_pct"),
            "resets_in": data.get("resets_in"),
            "stale": bool(data.get("stale")),
        }
    except Exception:
        return None


def main():
    reconfigure_streams()
    p = argparse.ArgumentParser(description="LLM enrichment for nortabs catalog")
    p.add_argument("--catalog", default="catalog.json")
    p.add_argument("--out-dir", default="enrichment",
                   help="Per-letter checkpoint directory (default: enrichment/). "
                        "Each letter X gets its own enrichment/X.json. Run "
                        "crawler/merge-enrichment.py to produce the combined "
                        "enrichment.json that the web app loads.")
    # Legacy single-file --out kept for the migrate script + occasional needs.
    p.add_argument("--out", default="",
                   help="DEPRECATED: writes a single enrichment.json instead "
                        "of per-letter files. Prefer --out-dir.")
    p.add_argument("--cli", default=DEFAULT_CLI,
                   help='Shell command to invoke the LLM (default: "claude -p"). '
                        "The prompt is appended as a final argv.")
    p.add_argument("--model-tag", default=DEFAULT_MODEL_TAG,
                   help="Label written to enrichment.json's 'model' field.")
    p.add_argument("--types", default="artist,song",
                   help="Comma-separated types to enrich: artist, song.")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop after enriching N entries (0 = no limit).")
    p.add_argument("--delay-ms", type=int, default=200,
                   help="Sleep between LLM calls (default 200ms).")
    p.add_argument("--ids", default="",
                   help="DEPRECATED: matches both artist AND song IDs without "
                        "disambiguation. Prefer --artist-ids / --song-ids.")
    p.add_argument("--artist-ids", default="",
                   help="Comma-separated artist IDs to enrich.")
    p.add_argument("--song-ids", default="",
                   help="Comma-separated song IDs to enrich.")
    p.add_argument("--force", action="store_true",
                   help="Re-enrich entries that already have data.")
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would be enriched without calling the LLM.")
    p.add_argument("--letter", default="",
                   help="Restrict to one or more catalog letters (comma-separated, "
                        "e.g. 'a' or 'å,æ,ø'). Default: all letters.")
    p.add_argument("--reverse", action="store_true",
                   help="Iterate letters in reverse order. Useful when running "
                        "this and enrich-gpt.py in parallel from opposite ends "
                        "so they meet in the middle.")
    p.add_argument("--cross-check", default="",
                   help="Path to another enrichment file (e.g. enrichment-gpt.json). "
                        "Entries present there are also skipped, so two parallel "
                        "enrichers don't duplicate work.")
    p.add_argument("--quota-threshold-pct", type=int, default=90,
                   help="Stop when claude-code-quota cache reports 5h usage >= "
                        "this %% (default 90). 0 disables quota check.")
    p.add_argument("--on-quota-limit", choices=("exit", "wait"), default="exit",
                   help="What to do when quota threshold is hit: 'exit' (default, "
                        "clean stop — rerun manually after reset) or 'wait' "
                        "(sleep until resets_in elapsed).")
    p.add_argument("--max-consecutive-failures", type=int, default=3,
                   help="Bail out after N CLI failures in a row (default 3). "
                        "Safety net for when the quota cache is stale.")
    p.add_argument("--clear-locks", action="store_true",
                   help="Delete all stale enrichment/<letter>.lock files and exit. "
                        "Use after a Ctrl+C / crash that left locks behind.")
    args = p.parse_args()

    catalog_path = Path(args.catalog)
    out_dir = Path(args.out_dir)

    if args.clear_locks:
        n = clear_all_letter_locks(out_dir)
        print(f"removed {n} lock file(s) from {out_dir}", file=sys.stderr)
        return

    legacy_out_path = Path(args.out) if args.out else None
    cli_cmd = args.cli.split()
    types = {t.strip() for t in args.types.split(",") if t.strip()}
    explicit_any_ids = (
        {int(x) for x in args.ids.split(",") if x.strip()} if args.ids else None
    )
    explicit_artist_ids = (
        {int(x) for x in args.artist_ids.split(",") if x.strip()}
        if args.artist_ids else None
    )
    explicit_song_ids = (
        {int(x) for x in args.song_ids.split(",") if x.strip()}
        if args.song_ids else None
    )

    def id_filter_allows(kind, ident):
        # Type-specific filter authoritative when either is set.
        if explicit_artist_ids is not None or explicit_song_ids is not None:
            if kind == "artist":
                return explicit_artist_ids is not None and ident in explicit_artist_ids
            if kind == "song":
                return explicit_song_ids is not None and ident in explicit_song_ids
        if explicit_any_ids is not None:
            return ident in explicit_any_ids
        return True

    # Accept both "a,b,c" and concatenated "abc".
    letters_filter = None
    if args.letter:
        letters_filter = set()
        for piece in args.letter.split(","):
            piece = piece.strip().lower()
            if not piece:
                continue
            if len(piece) == 1:
                letters_filter.add(piece)
            else:
                for c in piece:
                    letters_filter.add(c)
    delay_s = args.delay_ms / 1000.0

    if not catalog_path.exists():
        print(f"catalog not found: {catalog_path}", file=sys.stderr)
        sys.exit(1)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))

    # Legacy single-file mode: still supported for one-off / migrate flows.
    legacy_enrichment = load_enrichment(legacy_out_path) if legacy_out_path else None

    # Per-letter cache: load on demand, write back after each enriched entry.
    letter_cache = {}

    def get_letter_data(letter):
        if legacy_enrichment is not None:
            return legacy_enrichment
        if letter not in letter_cache:
            letter_cache[letter] = load_letter(out_dir, letter)
        return letter_cache[letter]

    def persist(letter):
        if legacy_enrichment is not None:
            write_enrichment(legacy_out_path, legacy_enrichment, args.model_tag)
        else:
            save_letter(out_dir, letter, letter_cache[letter], args.model_tag)

    def is_already_done(kind, ident, letter):
        data = get_letter_data(letter)
        bucket = data["artists"] if kind == "artist" else data["songs"]
        return str(ident) in bucket

    def log(msg):
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] {msg}", file=sys.stderr, flush=True)

    def quota_check():
        """Returns (ok, message). ok=False means we should stop."""
        if args.quota_threshold_pct <= 0:
            return True, None
        q = read_quota()
        if q is None or q["pct"] is None:
            return True, None  # no quota data, proceed silently
        if q["pct"] >= args.quota_threshold_pct:
            stale_note = " (cache stale)" if q["stale"] else ""
            return False, f"5h quota at {q['pct']}%{stale_note}, resets in {q['resets_in']}"
        return True, None

    def handle_quota_limit(msg):
        if args.on_quota_limit == "wait":
            # Parse "X hr Y min" / "Y min" loosely → seconds, sleep, then continue.
            secs = _parse_resets_in(read_quota().get("resets_in") if read_quota() else None)
            log(f"{msg} — waiting {secs}s ({secs // 60} min) then resuming")
            time.sleep(max(60, secs) + 30)  # extra 30s buffer
        else:
            log(f"{msg} — exiting (re-run after reset; idempotent diff will skip done entries)")
            sys.exit(0)

    enriched = 0
    skipped = 0
    failed = 0
    consec_fail = 0
    t0 = time.time()

    # Lock tracking: we hold at most one letter lock at a time.
    # When the iterator moves to a new letter, release the old, try acquire the new.
    current_locked_letter = None
    use_locks = legacy_enrichment is None  # locking only meaningful in per-letter mode

    def acquire_for(letter):
        nonlocal current_locked_letter
        if not use_locks:
            return True
        if current_locked_letter == letter:
            return True
        if current_locked_letter is not None:
            release_letter_lock(out_dir, current_locked_letter)
            current_locked_letter = None
        if try_acquire_letter_lock(out_dir, letter):
            current_locked_letter = letter
            return True
        return False

    # Graceful Ctrl+C: release any held lock before exiting.
    def _sigint(signum, frame):
        if current_locked_letter is not None:
            release_letter_lock(out_dir, current_locked_letter)
        print("\ninterrupted; lock released", file=sys.stderr, flush=True)
        sys.exit(130)
    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint) if hasattr(signal, 'SIGTERM') else None

    # Pre-flight quota check
    ok, msg = quota_check()
    if not ok:
        handle_quota_limit(msg)

    skipped_letters_locked = set()
    for kind, ident, payload, letter in iter_entries(catalog, letters_filter, reverse=args.reverse):
        if kind not in types:
            continue
        if not id_filter_allows(kind, ident):
            continue
        # Acquire lock for this letter (skip whole letter if locked by peer).
        if not acquire_for(letter):
            if letter not in skipped_letters_locked:
                log(f"letter '{letter}' locked by another process, skipping its entries")
                skipped_letters_locked.add(letter)
            skipped += 1
            continue
        if not args.force and is_already_done(kind, ident, letter):
            skipped += 1
            continue

        if kind == "artist":
            prompt = ARTIST_PROMPT.format(name=payload["name"])
            label = f"artist #{ident} [{letter}] '{payload['name']}'"
        else:
            tabs = payload["song"].get("tabs", [])
            body_excerpt = tabs[0].get("body", "")[:800] if tabs else "(no tab body)"
            prompt = SONG_PROMPT.format(
                artist=payload["artist_name"],
                song=payload["song"]["name"],
                body=body_excerpt,
            )
            label = f"song #{ident} [{letter}] '{payload['artist_name']}' - '{payload['song']['name']}'"

        if args.dry_run:
            log(f"[dry] would enrich {label} ({len(prompt)} char prompt)")
            enriched += 1
        else:
            # Periodic quota re-check (every 10 successful enrichments)
            if enriched > 0 and enriched % 10 == 0:
                ok, msg = quota_check()
                if not ok:
                    handle_quota_limit(msg)

            log(f"enriching {label}…")
            try:
                output = call_llm(cli_cmd, prompt)
                data = extract_json(output)
            except Exception as e:
                log(f"  ! failed: {e}")
                failed += 1
                consec_fail += 1
                if consec_fail >= args.max_consecutive_failures:
                    log(f"  ! {consec_fail} consecutive failures — likely quota or "
                        f"network issue. Exiting. Re-run after reset.")
                    sys.exit(2)
                time.sleep(delay_s)
                continue
            ld = get_letter_data(letter)
            bucket = ld["artists"] if kind == "artist" else ld["songs"]
            bucket[str(ident)] = data
            persist(letter)
            enriched += 1
            consec_fail = 0
            time.sleep(delay_s)

        if args.limit and enriched >= args.limit:
            log(f"reached --limit {args.limit}, stopping.")
            break

    # Release any held lock on clean exit.
    if current_locked_letter is not None:
        release_letter_lock(out_dir, current_locked_letter)

    elapsed = time.time() - t0
    log(f"done. enriched={enriched} skipped={skipped} failed={failed} in {elapsed:.1f}s.")
    if not args.dry_run:
        log(f"out: {legacy_out_path if legacy_out_path else out_dir}")


if __name__ == "__main__":
    main()
