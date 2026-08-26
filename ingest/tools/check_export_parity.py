#!/usr/bin/env python3
"""Diff the static export against the live D1-backed API. Zero is the only pass.

Two languages now build the same JSON shapes: `worker/src/api.ts` from D1 and
`twrev/export.py` from SQLite. Duplicating a shape is only safe if something
proves the copies agree, and this is that something.

It has already earned its place once. On the first run it caught the CSV
export writing `17.0` where the Worker wrote `17` - Python renders an integral
float with a trailing `.0` and JavaScript's `String()` does not - which would
have made every month's CSV churn against the last for a reader diffing them.

    python ingest/tools/check_export_parity.py --data web/public/data

Requires the Worker still to be serving D1. Once the API is retired this becomes
a historical record rather than a runnable gate, which is why it is a tool and
not a pytest case: the suite must stay offline and this cannot.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterator

DEFAULT_BASE = "https://taiwan-semicon-revenue.tech-441.workers.dev"

# `alerts` postdates the deployed Worker, and `access` describes a gate a static
# export does not have. Both are expected to differ; everything else is not.
META_SKIP = {"alerts", "access"}

# Enough companies to cover the shapes that differ from one another: a plain
# filer, the two consolidated ones, the merged name with no filing obligation,
# and one with a long note.
SAMPLE = ("2330", "3231", "3661", "6415", "6286", "3324", "8046")


def fetch(base: str, path: str) -> Any:
    out = subprocess.run(
        ["curl", "-s", "--max-time", "60", base + path], capture_output=True, check=True
    ).stdout
    return json.loads(out)


def diffs(mine: Any, live: Any, path: str = "") -> Iterator[tuple[str, Any, Any]]:
    """Every leaf that differs. Floats compare with a tolerance; nothing else does."""
    if isinstance(mine, dict) and isinstance(live, dict):
        for key in sorted(set(mine) | set(live)):
            if key not in mine:
                yield (f"{path}.{key}", "<missing>", live[key])
            elif key not in live:
                yield (f"{path}.{key}", mine[key], "<missing>")
            else:
                yield from diffs(mine[key], live[key], f"{path}.{key}")
    elif isinstance(mine, list) and isinstance(live, list):
        if len(mine) != len(live):
            yield (f"{path}[]", f"len {len(mine)}", f"len {len(live)}")
            return
        for i, (a, b) in enumerate(zip(mine, live)):
            yield from diffs(a, b, f"{path}[{i}]")
    elif isinstance(mine, float) or isinstance(live, float):
        if mine is None or live is None:
            if not (mine is None and live is None):
                yield (path, mine, live)
        elif abs(mine - live) > 1e-9:
            yield (path, mine, live)
    elif mine != live:
        yield (path, mine, live)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default="web/public/data", help="exported directory")
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    data = Path(args.data)

    total = 0

    def report(label: str, found: list[tuple[str, Any, Any]]) -> None:
        nonlocal total
        total += len(found)
        print(f"  {label:34} diffs={len(found)}")
        for d in found[:5]:
            print(f"      {d[0]}\n        mine: {str(d[1])[:100]}\n        live: {str(d[2])[:100]}")

    print(f"parity: {data} vs {args.base}")

    # analytics - the live default drops the shoulder month, the export keeps it
    # because the browser cannot filter to a month it was never handed.
    mine = json.loads((data / "analytics.json").read_text(encoding="utf-8"))
    live = fetch(args.base, "/api/analytics?from=2025-12")
    report("analytics.json", list(diffs(
        {k: mine[k] for k in ("count", "rows")},
        {k: live[k] for k in ("count", "rows")},
    )))

    # meta, minus the two keys that are meant to differ
    mine = json.loads((data / "meta.json").read_text(encoding="utf-8"))
    live = fetch(args.base, "/api/meta")
    report("meta.json", list(diffs(
        {k: v for k, v in mine.items() if k not in META_SKIP},
        {k: v for k, v in live.items() if k not in META_SKIP},
    )))

    for ticker in SAMPLE:
        path = data / "company" / f"{ticker}.json"
        if not path.exists():
            continue
        report(f"company/{ticker}.json", list(diffs(
            json.loads(path.read_text(encoding="utf-8")),
            fetch(args.base, f"/api/company/{ticker}"),
        )))

    # The CSV is compared byte for byte. It is a deliverable someone downloads
    # and diffs month to month, so formatting is part of the contract.
    # newline="" or Python's universal-newline translation silently rewrites
    # CRLF to LF on the way in and the comparison fails on 297 invisible bytes.
    with (data / "export.csv").open(encoding="utf-8", newline="") as fh:
        csv_mine = fh.read()
    csv_live = subprocess.run(
        ["curl", "-s", "--max-time", "60", args.base + "/api/export.csv?from=2025-12"],
        capture_output=True, check=True,
    ).stdout.decode("utf-8")
    if csv_mine == csv_live:
        print(f"  {'export.csv':34} identical ({len(csv_mine):,} bytes)")
    else:
        total += 1
        print(f"  {'export.csv':34} DIFFERS  mine={len(csv_mine)} live={len(csv_live)}")
        for i, (a, b) in enumerate(zip(csv_mine.splitlines(), csv_live.splitlines())):
            if a != b:
                print(f"      first at line {i}\n        mine: {a[:110]}\n        live: {b[:110]}")
                break

    print(f"\nTOTAL DIVERGENCES: {total}")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
