#!/usr/bin/env python3
"""Measure what the consolidation de-duplication changes, against live data.

`config/relationships.yaml` removes a company from every sum across companies.
That is a correction, but it is also a subtraction from a headline number, so it
has to be measurable rather than asserted. This tool rebuilds the store from the
LIVE raw rows and runs the Worker's own bucket aggregate twice - once as
production ran it before the fix, once with the exclusion - and prints the delta.

It checks itself first. The SQL below is a transcription of
`worker/src/api.ts:heatmap()`, and the WITHOUT variant is diffed cell by cell
against the deployed `/api/heatmap`. If that comparison is not zero the
transcription has drifted from the Worker and nothing after it means anything,
so the tool exits non-zero and prints the divergences instead of a result.

    python ingest/tools/check_dedupe_impact.py

Needs the network (it reads the live API), which is why this is a tool and not a
pytest case: the suite must stay provably offline.

Result on 2026-07, the month this was written against:

    transcription check : 70 live cells, 0 divergences
    Rack / ODM revenue  : 1,873,094,715 -> 1,755,409,185   (-6.28%)
    Rack / ODM YoY      : 65.68% -> 67.81%
    universe total      : overstated by 4.55%
    cells changed       : 7 of 70   (the excluded member's stage, and only it)
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from twrev import relationships as rel_mod  # noqa: E402
from twrev import store  # noqa: E402
from twrev.config import load_universe  # noqa: E402

DEFAULT_BASE = "https://taiwan-semicon-revenue.tech-441.workers.dev"
FROM, SHOULDER = "2026-01", "2025-12"


def get(base: str, path: str):
    out = subprocess.run(
        ["curl", "-fsS", "--max-time", "60", base + path], capture_output=True, check=True
    ).stdout
    return json.loads(out)


def build(base: str, path: Path) -> sqlite3.Connection:
    """The real schema from worker/migrations, filled with the live raw rows."""
    universe = load_universe()
    conn = store.connect(path)
    store.load_universe(conn, universe)
    for c in universe:
        rows = get(base, f"/api/company/{c.ticker}")["raw_rows"]
        store.upsert_rows(conn, rows)
    store.assert_view_contract(conn)
    return conn


def statement(excluded: list[str]) -> str:
    """worker/src/api.ts:heatmap(), transcribed. Keep these in step."""
    where = f"b.month >= '{SHOULDER}'"
    if excluded:
        where += " AND b.ticker NOT IN ('" + "','".join(excluded) + "')"
    return f"""
    WITH per_bucket AS (
      SELECT b.bucket, b.month, b.month_idx,
             SUM(CASE WHEN b.revenue_month IS NOT NULL THEN 1 ELSE 0 END) AS members,
             SUM(b.revenue_month) AS revenue,
             SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                      THEN b.revenue_month END)     AS yoy_num,
             SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                      THEN b.revenue_yoy_month END) AS yoy_den,
             SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                      THEN 1 ELSE 0 END) AS members_yoy
        FROM analytics_base b
       WHERE {where}
       GROUP BY b.bucket, b.month, b.month_idx
      HAVING members > 0
    ),
    calc AS (
      SELECT p.*,
        CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
             THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END AS yoy_weighted,
        LAG(p.month_idx) OVER w AS prev_idx,
        LAG(CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
             THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END) OVER w
          AS prev_yoy_weighted
      FROM per_bucket p
      WINDOW w AS (PARTITION BY p.bucket ORDER BY p.month_idx)
    )
    SELECT bucket, month, revenue, members_yoy, yoy_weighted,
           CASE WHEN prev_idx = month_idx - 1
                THEN ROUND(yoy_weighted - prev_yoy_weighted, 2) END AS accel
      FROM calc WHERE month >= '{FROM}' ORDER BY bucket, month
    """


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()

    universe = load_universe()
    excluded = list(rel_mod.load_relationships(universe=universe).excluded_from_aggregates)
    if not excluded:
        print("nothing is excluded - config/relationships.yaml has no consolidation pairs")
        return 0
    print(f"excluded from sums: {', '.join(excluded)}")

    with tempfile.TemporaryDirectory() as tmp:
        conn = build(args.base, Path(tmp) / "live.sqlite")
        conn.row_factory = sqlite3.Row
        before = {(r["bucket"], r["month"]): dict(r) for r in conn.execute(statement([]))}
        after = {(r["bucket"], r["month"]): dict(r) for r in conn.execute(statement(excluded))}
        conn.close()

    # -- self-check: does the WITHOUT variant reproduce what production serves? --
    live = get(args.base, "/api/heatmap?metric=yoy_acceleration_ppt&group=bucket&agg=weighted")
    bad = 0
    for c in live["cells"]:
        mine = before.get((c["bucket"], c["month"]))
        if mine is None:
            print(f"  MISSING {c['bucket']} {c['month']}")
            bad += 1
            continue
        for live_key, my_key in (("value", "accel"), ("revenue", "revenue"),
                                 ("members", "members_yoy")):
            a, b = c[live_key], mine[my_key]
            if a is None and b is None:
                continue
            if a is None or b is None or abs(a - b) > 1e-6:
                print(f"  DIFF {c['bucket']} {c['month']} {live_key}: live={a} mine={b}")
                bad += 1
    print(f"transcription check : {len(live['cells'])} live cells, {bad} divergences")
    if bad:
        print("\nthe transcription no longer matches worker/src/api.ts - fix it before "
              "reading anything below", file=sys.stderr)
        return 1

    latest = max(m for _, m in before)
    print(f"\nlatest month        : {latest}\n")
    header = (f"{'stage':<38}{'revenue before':>17}{'revenue after':>17}"
              f"{'delta':>8}{'yoy before':>12}{'yoy after':>11}")
    print(header)
    print("-" * len(header))
    for (bucket, month), b in sorted(before.items()):
        if month != latest:
            continue
        a = after[(bucket, month)]
        if a["revenue"] == b["revenue"] and a["yoy_weighted"] == b["yoy_weighted"]:
            continue
        d = 100 * (a["revenue"] / b["revenue"] - 1) if b["revenue"] else 0.0
        print(f"{bucket:<38}{b['revenue']:>17,}{a['revenue']:>17,}{d:>7.2f}%"
              f"{b['yoy_weighted']:>12}{a['yoy_weighted']:>11}")

    tot_b = sum(v["revenue"] for k, v in before.items() if k[1] == latest)
    tot_a = sum(v["revenue"] for k, v in after.items() if k[1] == latest)
    print(f"\nuniverse total      : {tot_b:,} -> {tot_a:,}   "
          f"overstated by {100 * (tot_b / tot_a - 1):.2f}%")

    changed = sum(1 for k in before if before[k]["revenue"] != after[k]["revenue"])
    stages = {k[0] for k in before if before[k]["revenue"] != after[k]["revenue"]}
    print(f"cells changed       : {changed} of {len(before)}, in {len(stages)} stage(s): "
          f"{', '.join(sorted(stages))}")
    print("\nOnly a stage holding an excluded member may change. Any other stage moving "
          "here would mean the exclusion reached rows it must not touch.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
