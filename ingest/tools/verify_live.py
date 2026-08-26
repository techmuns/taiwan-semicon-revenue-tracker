#!/usr/bin/env python3
"""Post-apply check: does the DASHBOARD show what we just wrote?

Run after a seed reaches D1. It deliberately reads through the public API rather
than querying the database, because that is the reader's own path - it proves
what someone opening the dashboard will actually see, not merely that rows
landed in a table.

Three assertions, cheap and specific:

  * the golden cell still reads 415,191,699 - a units change or a precision loss
    that survived every gate upstream shows up here
  * the expected month is present and carries a revenue figure
  * coverage for that month is plausible, so a seed that wrote three rows
    instead of thirty-six cannot pass quietly

    python ingest/tools/verify_live.py --month 2026-07
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

DEFAULT_BASE = "https://taiwan-semicon-revenue.tech-441.workers.dev"

# The same reference cell twrev.seed.GOLDEN_KEY anchors on, restated here so
# this tool stands alone on a runner with no package import path set up.
GOLDEN_TICKER, GOLDEN_MONTH, GOLDEN_REVENUE = "2330", "2026-03", 415191699

# 36 of the 37 are trackable; 6286 is a merged name with no filing obligation.
# Below this, something wrote a fraction of the month and called it success.
MIN_FILED = 30


def get(base: str, path: str) -> object:
    out = subprocess.run(
        ["curl", "-fsS", "--max-time", "60", base + path],
        capture_output=True, check=True,
    ).stdout
    return json.loads(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--month", default=None, help="month the refresh wrote (YYYY-MM)")
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()

    failures: list[str] = []

    meta = get(args.base, "/api/meta")
    latest = meta.get("latest_month")
    print(f"latest_month     : {latest}")

    golden = get(
        args.base,
        f"/api/analytics?from={GOLDEN_MONTH}&to={GOLDEN_MONTH}&tickers={GOLDEN_TICKER}",
    )["rows"]
    got = golden[0]["revenue_twd_thousands"] if golden else None
    print(f"{GOLDEN_TICKER} {GOLDEN_MONTH} revenue : {got:,}" if got else
          f"{GOLDEN_TICKER} {GOLDEN_MONTH} revenue : MISSING")
    if got != GOLDEN_REVENUE:
        failures.append(
            f"golden cell {GOLDEN_TICKER}/{GOLDEN_MONTH} is {got}, expected {GOLDEN_REVENUE}"
        )

    month = args.month or latest
    if month:
        rows = get(args.base, f"/api/analytics?from={month}&to={month}")["rows"]
        filed = sum(1 for r in rows if r["revenue_twd_thousands"] is not None)
        print(f"{month} filed      : {filed} of {len(rows)} rows")
        if filed < MIN_FILED:
            failures.append(
                f"{month} has only {filed} filed rows, expected at least {MIN_FILED}"
            )
    else:
        failures.append("no month to check and /api/meta reports no latest_month")

    if failures:
        print("\nFAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("\nall live checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
