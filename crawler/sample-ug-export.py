#!/usr/bin/env python3
"""Random small UG-export sample for fast on-device import-flow tests.

Full 253-tab on-device enrichment runs ~40 min per test cycle. A 12-20-tab
random sample drops it to ~2-3 min and beats first-N sampling (which
biases toward the Tampermonkey export order, usually alphabetical).

    python crawler/sample-ug-export.py            # 15 tabs, default paths
    python crawler/sample-ug-export.py -n 12      # 12 tabs
    python crawler/sample-ug-export.py --seed 42  # reproducible pick

Source defaults to `ug/ug-export-2026-05-16-tommyl.json`; output defaults
to `ug/ug-export-sample-{N}.json` (gitignored).
"""
import argparse
import json
import random
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO / "ug" / "ug-export-2026-05-16-tommyl.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    ap.add_argument("-n", "--count", type=int, default=15)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    data = json.loads(args.source.read_text(encoding="utf-8"))
    tabs = data.get("tabs", [])
    if args.count > len(tabs):
        raise SystemExit(f"asked for {args.count}, source only has {len(tabs)}")

    if args.seed is not None:
        random.seed(args.seed)
    picked = random.sample(tabs, args.count)

    out_data = {**data, "tabs": picked, "ok_count": len(picked), "failed_count": 0,
                "sampled_from": args.source.name, "sampled_count": len(picked)}
    out_path = args.out or REPO / "ug" / f"ug-export-sample-{args.count}.json"
    out_path.write_text(json.dumps(out_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(picked)} tabs -> {out_path.relative_to(REPO)}")


if __name__ == "__main__":
    main()
