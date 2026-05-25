#!/usr/bin/env python3
"""Benchmark multiple Ollama Cloud LLMs against the UG-tab enrichment task.

Runs the same prompts as enrich-private.py against several candidate
models via OpenAI-compatible /chat/completions on the local Ollama
daemon (which transparently proxies `:cloud` models to Ollama Cloud
via the user's $20/month subscription).

Outputs:
  - `crawler/bench/runs/<model>__<tab>.json` per (model, tab) pair
  - `crawler/bench/COMPARE.md`              summary table
  - `crawler/bench/inputs.json`             the chosen test inputs

Patterns mirror C:/devel/aweussom/python/evaluator (battle-tested
Ollama integration): temperature 0.7, 600 s timeout, 3-attempt
exponential backoff with jitter, <think>/<reflection> stripping
before JSON parsing.

Typical use:
    # First run (writes all 4 × 5 = 20 results):
    python crawler/enrich-bench.py

    # Resume after Ctrl+C (skips already-cached runs):
    python crawler/enrich-bench.py

    # Re-run specific model:
    python crawler/enrich-bench.py --models deepseek-v4-pro:cloud --force

    # Regenerate the COMPARE.md from existing run files (no LLM calls):
    python crawler/enrich-bench.py --compare-only
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("ABORT: pip install requests", file=sys.stderr)
    sys.exit(1)

# Reuse prompt + parsing helpers from the production pipeline so the
# bench measures the SAME prompt discipline the proxy + CLI path use.
sys.path.insert(0, str(Path(__file__).parent))
from enrich import SONG_PROMPT, extract_json, reconfigure_streams

# enrich-private has a hyphen — import via importlib
import importlib.util
_ep_spec = importlib.util.spec_from_file_location(
    "enrich_private", Path(__file__).parent / "enrich-private.py"
)
_ep = importlib.util.module_from_spec(_ep_spec)
_ep_spec.loader.exec_module(_ep)
STRICT_SUFFIX = _ep.STRICT_SUFFIX
salvage_truncated_json = _ep.salvage_truncated_json
slugify = _ep.slugify

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_MODELS = [
    "deepseek-v4-flash:cloud",
    "deepseek-v4-pro:cloud",
    "nemotron-3-super:cloud",
    "qwen3.5:cloud",
]

# Test tabs: 5 English songs picking different difficulty axes. Lyrics
# bodies are read from the actual UG import so hallucination scoring
# (key_phrases ∈ body) measures real signal.
TEST_TAB_KEYS = [
    "Jolene",            # famous, classic country — expected easy
    "Tecumseh Valley",   # obscure, has a "John Prine vs Townes Van Zandt" attribution trap
    "Let Her Go",        # modern pop (Passenger, 2012)
    "Hallelujah",        # famous cover (Buckley) — tests cover-vs-original conflation
    "Lady In Black",     # older obscure rock (Uriah Heep, 1971)
]

OLLAMA_BASE = "http://localhost:11434/v1"

TEMPERATURE = 0.7
TIMEOUT_S = 600
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_BASE_S = 5
RETRY_BACKOFF_MAX_S = 60

SYSTEM_MSG = (
    "You enrich a guitar-tab catalog with search metadata for a web app. "
    "Output ONE JSON object only — no markdown fences, no commentary, no "
    "surrounding text."
)

# ---------------------------------------------------------------------------
# LLM call (mirrors evaluator's patterns: retry/backoff + think-strip)
# ---------------------------------------------------------------------------

_THINK_RE = re.compile(r"(?:<think>)?[\s\S]*?</think>\s*", re.IGNORECASE)
_REFLECT_RE = re.compile(r"<reflection>[\s\S]*?</reflection>\s*", re.IGNORECASE)
_FENCE_OPEN_RE = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)
_FENCE_CLOSE_RE = re.compile(r"\s*```\s*$")


def strip_reasoning(text):
    """Remove <think>/<reflection> blocks from LLM output before JSON parse."""
    text = _THINK_RE.sub("", text or "")
    text = _REFLECT_RE.sub("", text)
    return text.strip()


def strip_fences(text):
    """Remove ```json ... ``` wrapping if the model added it despite the prompt."""
    text = _FENCE_OPEN_RE.sub("", text)
    text = _FENCE_CLOSE_RE.sub("", text)
    return text.strip()


def call_ollama(model, system_msg, user_msg, temperature=TEMPERATURE,
                timeout=TIMEOUT_S):
    """OpenAI-compat /chat/completions against local Ollama. Returns dict:
        {content, raw, latency_ms, tokens_in, tokens_out, error}
    On final failure (after retries), `content` is None and `error` is set.
    """
    url = f"{OLLAMA_BASE}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "temperature": temperature,
    }
    last_err = None
    t0 = time.time()
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            resp = requests.post(url, json=payload, timeout=timeout)
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            latency_ms = int((time.time() - t0) * 1000)
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            usage = data.get("usage") or {}
            return {
                "content": content,
                "raw": data,
                "latency_ms": latency_ms,
                "tokens_in": usage.get("prompt_tokens"),
                "tokens_out": usage.get("completion_tokens"),
                "error": None,
            }
        except Exception as err:
            last_err = err
            if attempt >= RETRY_ATTEMPTS:
                break
            delay = min(RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1)),
                        RETRY_BACKOFF_MAX_S)
            jitter = delay * 0.1
            wait_s = delay + (jitter * (time.time() % 1))
            print(f"    attempt {attempt}/{RETRY_ATTEMPTS} failed: {err} — "
                  f"retrying in {wait_s:.1f}s", file=sys.stderr)
            time.sleep(wait_s)
    return {
        "content": None,
        "raw": None,
        "latency_ms": int((time.time() - t0) * 1000),
        "tokens_in": None,
        "tokens_out": None,
        "error": str(last_err),
    }


# ---------------------------------------------------------------------------
# Hallucination scoring
# ---------------------------------------------------------------------------

def _fold(s):
    """Loose token-equality fold: lowercase, strip diacritics + punctuation."""
    s = (s or "").lower()
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def key_phrases_in_body(phrases, body):
    """Fraction of key_phrases that appear (verbatim or token-folded) in body.
    Returns (hits, total, fraction)."""
    if not phrases:
        return 0, 0, 1.0  # no claim = no hallucination
    body_folded = _fold(body)
    hits = 0
    for p in phrases:
        p_folded = _fold(str(p))
        if not p_folded:
            continue
        if p_folded in body_folded:
            hits += 1
    return hits, len(phrases), (hits / len(phrases)) if phrases else 1.0


# ---------------------------------------------------------------------------
# Run orchestration
# ---------------------------------------------------------------------------

def pick_test_tabs(import_path, keys):
    """Find the named tabs in the UG import; return [{artist, song, body, id}]."""
    data = json.loads(Path(import_path).read_text(encoding="utf-8"))
    tabs = data.get("tabs") or []
    picks = {}
    for t in tabs:
        song = t.get("song") or ""
        for k in keys:
            if k in song and k not in picks:
                picks[k] = {
                    "key": k,
                    "artist": t.get("artist", ""),
                    "song": song,
                    "body": (t.get("body") or "")[:1200],  # match enrich-private.py truncation
                    "id": f"{slugify(t.get('artist', ''))}__{slugify(song)}",
                }
                break
    missing = [k for k in keys if k not in picks]
    if missing:
        print(f"WARN: didn't find these test tabs in import: {missing}",
              file=sys.stderr)
    return [picks[k] for k in keys if k in picks]


def run_one(model, tab):
    """Run a single (model, tab) pair. Returns the full per-run dict."""
    user_msg = SONG_PROMPT.format(
        artist=tab["artist"], song=tab["song"], body=tab["body"]
    ) + STRICT_SUFFIX

    llm = call_ollama(model, SYSTEM_MSG, user_msg)
    parsed = None
    parse_ok = False
    parse_path = None  # "strict" | "salvaged" | "failed"

    if llm["content"]:
        cleaned = strip_fences(strip_reasoning(llm["content"]))
        try:
            parsed = extract_json(cleaned)
            parse_ok = parsed is not None
            parse_path = "strict" if parse_ok else None
        except Exception:
            parsed = None
            parse_ok = False
        if not parse_ok:
            salvaged = salvage_truncated_json(cleaned)
            if salvaged is not None:
                parsed = salvaged
                parse_ok = True
                parse_path = "salvaged"
        if not parse_ok:
            parse_path = "failed"

    key_phrases = (parsed or {}).get("key_phrases") or []
    hits, total, frac = key_phrases_in_body(key_phrases, tab["body"])

    return {
        "model": model,
        "tab_key": tab["key"],
        "tab_id": tab["id"],
        "artist": tab["artist"],
        "song": tab["song"],
        "latency_ms": llm["latency_ms"],
        "tokens_in": llm["tokens_in"],
        "tokens_out": llm["tokens_out"],
        "error": llm["error"],
        "raw_content": llm["content"],
        "parse_ok": parse_ok,
        "parse_path": parse_path,
        "enrichment": parsed,
        "key_phrases_hit": hits,
        "key_phrases_total": total,
        "key_phrases_fraction": round(frac, 3),
    }


def run_key(model, tab_id):
    """Filesystem-safe key for `crawler/bench/runs/<model>__<tab>.json`."""
    safe_model = model.replace(":", "_").replace("/", "_")
    return f"{safe_model}__{tab_id}"


# ---------------------------------------------------------------------------
# Compare-table renderer
# ---------------------------------------------------------------------------

def render_compare_md(runs_dir, models, tabs):
    """Build COMPARE.md from existing run files."""
    by_model = {m: {} for m in models}
    for f in sorted(runs_dir.glob("*.json")):
        try:
            run = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        m = run["model"]
        tid = run["tab_id"]
        if m in by_model:
            by_model[m][tid] = run

    out = []
    out.append("# Enrichment Bench — Ollama Cloud comparison")
    out.append("")
    out.append(f"Models tested: {', '.join(f'`{m}`' for m in models)}")
    out.append("")
    out.append(f"Tabs tested ({len(tabs)}):")
    for tab in tabs:
        out.append(f"- **{tab['key']}** — {tab['artist']} — {tab['song']}  "
                   f"(id `{tab['id']}`)")
    out.append("")

    # Per-tab tables
    out.append("## Per-tab results")
    out.append("")
    for tab in tabs:
        out.append(f"### {tab['key']} — {tab['artist']}")
        out.append("")
        out.append("| Model | parse | latency | tokens (in/out) | kp hit/total | "
                   "language | themes | key_phrases (first 2) |")
        out.append("|---|---|---|---|---|---|---|---|")
        for m in models:
            run = by_model.get(m, {}).get(tab["id"])
            if not run:
                out.append(f"| `{m}` | — | — | — | — | — | — | _(no run)_ |")
                continue
            parse = "✓" if run["parse_ok"] else "✗"
            if run["parse_path"] == "salvaged":
                parse = "✓ (salvaged)"
            lat = f"{run['latency_ms']/1000:.1f}s"
            ti, to = run["tokens_in"], run["tokens_out"]
            toks = f"{ti}/{to}" if ti is not None and to is not None else "—"
            kp = f"{run['key_phrases_hit']}/{run['key_phrases_total']}"
            enrich = run["enrichment"] or {}
            lang = enrich.get("language", "—")
            themes = ", ".join((enrich.get("themes") or [])[:3]) or "—"
            phrases = (enrich.get("key_phrases") or [])[:2]
            phrases_str = " / ".join(f"_{p}_" for p in phrases) or "—"
            err_note = f" ⚠ {run['error']}" if run["error"] else ""
            out.append(f"| `{m}` | {parse}{err_note} | {lat} | {toks} | "
                       f"{kp} | {lang} | {themes} | {phrases_str} |")
        out.append("")

    # Aggregate stats
    out.append("## Aggregate (across all tabs)")
    out.append("")
    out.append("| Model | parse rate | mean latency | mean tokens out | "
               "mean kp hit-rate |")
    out.append("|---|---|---|---|---|")
    for m in models:
        runs = list(by_model.get(m, {}).values())
        if not runs:
            out.append(f"| `{m}` | — | — | — | — |")
            continue
        n = len(runs)
        parse_n = sum(1 for r in runs if r["parse_ok"])
        lat_avg_s = sum(r["latency_ms"] for r in runs) / n / 1000
        toks_out = [r["tokens_out"] for r in runs if r["tokens_out"]]
        toks_avg = (sum(toks_out) / len(toks_out)) if toks_out else None
        kp_fracs = [r["key_phrases_fraction"] for r in runs if r["parse_ok"]]
        kp_avg = (sum(kp_fracs) / len(kp_fracs)) if kp_fracs else None

        parse_cell = f"{parse_n}/{n} ({100*parse_n/n:.0f}%)"
        lat_cell = f"{lat_avg_s:.1f}s"
        toks_cell = f"{toks_avg:.0f}" if toks_avg is not None else "—"
        kp_cell = f"{kp_avg*100:.0f}%" if kp_avg is not None else "—"
        out.append(f"| `{m}` | {parse_cell} | {lat_cell} | {toks_cell} | {kp_cell} |")
    out.append("")
    out.append("**Read this table as**: parse-rate is the "
               "first quality gate (must be ~100%); key_phrases hit-rate is "
               "the hallucination signal (lower = more invented quotes); "
               "latency matters most for batch enrichment of large UG imports.")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="crawler/private/ug-import.json")
    p.add_argument("--out-dir", default="crawler/bench")
    p.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    p.add_argument("--force", action="store_true",
                   help="Re-run runs even if a cached file exists")
    p.add_argument("--compare-only", action="store_true",
                   help="Skip LLM calls, just regenerate COMPARE.md")
    return p.parse_args()


def main():
    reconfigure_streams()
    args = parse_args()
    out_dir = Path(args.out_dir)
    runs_dir = out_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)

    tabs = pick_test_tabs(args.input, TEST_TAB_KEYS)
    if not tabs:
        print(f"ABORT: no test tabs found in {args.input}", file=sys.stderr)
        return 1

    # Persist the inputs so a reader can see exactly what was tested
    (out_dir / "inputs.json").write_text(
        json.dumps(tabs, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    if args.compare_only:
        md = render_compare_md(runs_dir, args.models, tabs)
        (out_dir / "COMPARE.md").write_text(md, encoding="utf-8")
        print(f"Wrote {out_dir / 'COMPARE.md'} (compare-only).")
        return 0

    total = len(args.models) * len(tabs)
    done = 0
    print(f"Running {total} (model × tab) combinations against {OLLAMA_BASE}")
    for model in args.models:
        for tab in tabs:
            done += 1
            key = run_key(model, tab["id"])
            run_path = runs_dir / f"{key}.json"
            if run_path.exists() and not args.force:
                print(f"[{done:2}/{total}] cached: {model} × {tab['key']}")
                continue
            print(f"[{done:2}/{total}] {model} × {tab['key']} ...", flush=True)
            result = run_one(model, tab)
            run_path.write_text(
                json.dumps(result, indent=2, ensure_ascii=False),
                encoding="utf-8"
            )
            status = "OK" if result["parse_ok"] else "FAIL"
            if result["error"]:
                status = f"ERROR ({result['error'][:60]})"
            kp = f"{result['key_phrases_hit']}/{result['key_phrases_total']}"
            print(f"    → {status} | {result['latency_ms']/1000:.1f}s | "
                  f"kp {kp}")

    md = render_compare_md(runs_dir, args.models, tabs)
    (out_dir / "COMPARE.md").write_text(md, encoding="utf-8")
    print(f"\nDone. See {out_dir / 'COMPARE.md'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
