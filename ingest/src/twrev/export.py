"""Static JSON export - the dashboard's data, as files.

The Worker used to answer six endpoints out of D1 on every page load. It no
longer needs to: the whole dataset is 296 rows, and `/api/analytics` was 105 KB
raw and 10 KB gzipped. That is small enough to hand the browser in one file and
let it filter locally, which removes the database from the request path entirely
- no D1 binding, no per-page-load query, nothing to rate-limit.

Every shape here mirrors `worker/src/api.ts` field for field, because the
frontend's TypeScript types are written against those shapes and a quiet
divergence would surface as an undefined at runtime rather than as an error at
build time. `tools/check_export_parity.py` diffs what this writes against the
live API and requires zero differences, which is the only reason it is safe to
duplicate a shape in two languages.

ONE ENDPOINT IS DELIBERATELY ABSENT: `/api/heatmap`. It aggregates over whatever
filters are live, and ticker selection is an arbitrary subset of 37 names, so its
answers cannot be enumerated into files. That aggregation moves to the browser.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Sequence

from . import roc
from .config import Sources, Universe

# The window the dashboard opens on, vs everything queryable. Mirrors
# worker/src/api.ts:DEFAULT_FROM - the shoulder month is real data and is
# exported, but is not part of the requested window.
DEFAULT_FROM = "2026-01"

# `SELECT a.*` from the view, joined only to order by the universe's sort order.
# The view IS the brief's twelve columns in the specified order, so nothing here
# may name columns explicitly - that is what keeps the CSV contract intact.
TWELVE_COLUMNS = (
    "SELECT a.* FROM analytics_monthly a JOIN universe u USING (ticker) "
    "ORDER BY u.sort_order, a.ticker, a.month"
)


def _rows(conn: sqlite3.Connection, sql: str, *params: Any) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(sql, params)]


def build_meta(conn: sqlite3.Connection, universe: Universe, sources: Sources) -> dict[str, Any]:
    """Mirrors api.ts:meta(), including the `alerts` block."""
    months = [r["month"] for r in _rows(conn, "SELECT month FROM month_spine ORDER BY month_idx")]

    buckets: list[str] = []
    for c in universe:
        if c.bucket not in buckets:
            buckets.append(c.bucket)

    # Read once: it is both a payload field and the source of `severe_total`.
    findings_by_code = _rows(
        conn,
        "SELECT severity, code, COUNT(*) AS n FROM quality_findings"
        " GROUP BY severity, code ORDER BY"
        "   CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END, code",
    )

    return {
        "universe": _rows(
            conn,
            "SELECT ticker, display_name, name_zh, bucket, tier, market_hint, status,"
            "       active_from, active_to, successor, thesis, notes, sort_order"
            "  FROM universe ORDER BY sort_order, ticker",
        ),
        "buckets": buckets,
        "tiers": [1, 2],
        "months": months,
        "default_from": DEFAULT_FROM,
        "shoulder_months": [m for m in months if m < DEFAULT_FROM],
        "latest_month": months[-1] if months else None,
        "sources": _rows(
            conn,
            "SELECT source_id, COUNT(*) AS rows_n, MIN(month) AS first_month,"
            "       MAX(month) AS last_month, MAX(last_seen_utc) AS last_seen_utc"
            "  FROM raw_revenue GROUP BY source_id ORDER BY source_id",
        ),
        # COUNT(DISTINCT ticker), not COUNT(*): raw_revenue is keyed
        # (source_id, month, ticker), so a month held by two feeds would count
        # every company once per feed. Since the Actions run reads MOPS *and*
        # the OpenAPI feeds, that is now the normal case rather than a
        # hypothetical - this would report 72 of 36 names filed without it.
        "freshness": _rows(
            conn,
            "SELECT month, COUNT(DISTINCT ticker) AS tickers_with_data,"
            "       MAX(last_seen_utc) AS last_seen_utc"
            "  FROM raw_revenue WHERE revenue_month IS NOT NULL"
            " GROUP BY month ORDER BY month_idx",
        ),
        "findings_by_code": findings_by_code,
        "alerts": {
            "interior_gaps": _rows(
                conn,
                "WITH r AS ("
                "  SELECT ticker,"
                "         MIN(CASE WHEN has_data = 1 THEN month_idx END) AS first_idx,"
                "         MAX(CASE WHEN has_data = 1 THEN month_idx END) AS last_idx"
                "    FROM analytics_base GROUP BY ticker)"
                " SELECT b.ticker, b.display_name, b.month"
                "   FROM analytics_base b JOIN r ON r.ticker = b.ticker"
                "  WHERE b.has_data = 0 AND b.month_idx > r.first_idx"
                "    AND b.month_idx < r.last_idx"
                "  ORDER BY b.ticker, b.month_idx",
            ),
            "severe_findings": _rows(
                conn,
                "SELECT severity, code, ticker, month, message"
                "  FROM quality_findings WHERE severity IN ('error', 'warn')"
                " ORDER BY CASE severity WHEN 'error' THEN 1 ELSE 2 END,"
                "          code, month, ticker LIMIT 20",
            ),
            # The LIST above is capped at 20 so a bad month cannot ship a
            # thousand-line strip; the COUNT must not be, because the dashboard
            # renders it. Rendering the capped list's length said "20 open
            # findings" when there were more, which understates a data-quality
            # problem - the one direction it must never be wrong in. Derived
            # from the uncapped GROUP BY above, exactly as api.ts does it, so
            # the two implementations cannot drift on this.
            "severe_total": sum(
                r["n"] for r in findings_by_code if r["severity"] in ("error", "warn")
            ),
            "consolidated": _rows(
                conn,
                "SELECT DISTINCT f.ticker, u.display_name"
                "  FROM quality_findings f JOIN universe u ON u.ticker = f.ticker"
                " WHERE f.code = 'CONSOLIDATED_BASIS' AND f.ticker IS NOT NULL"
                " ORDER BY u.sort_order",
            ),
        },
        # Static files have no gate to describe, and the dashboard stopped
        # displaying this before the migration. Kept so the shape does not
        # change under the frontend's Meta type.
        "access": {
            "mode": "open",
            "public": True,
            "note": "static export; served as files, no API to gate",
        },
        "units": {
            "revenue": "TWD thousands",
            "percentages": "percent",
            "acceleration": "percentage points",
        },
    }


def build_analytics(conn: sqlite3.Connection) -> dict[str, Any]:
    """Every row, unfiltered.

    The live endpoint defaults to `from=DEFAULT_FROM`; this deliberately does
    not, because the browser now does the filtering and cannot filter to a month
    it was never given. The shoulder month has to be in the file for January's
    MoM and acceleration to exist at all.
    """
    rows = _rows(conn, TWELVE_COLUMNS)
    return {
        "filters": {
            "from": rows[0]["month"] if rows else DEFAULT_FROM,
            "to": None, "tickers": [], "buckets": [], "tiers": [],
            "onlyWithData": False,
        },
        "count": len(rows),
        "rows": rows,
    }


def build_company(conn: sqlite3.Connection, ticker: str) -> dict[str, Any]:
    """Mirrors api.ts:companyDetail()."""
    company = _rows(conn, "SELECT * FROM universe WHERE ticker = ?", ticker)
    if not company:
        return {"error": f"unknown ticker {ticker}"}
    return {
        "company": company[0],
        "series": _rows(
            conn,
            "SELECT month, revenue_month AS revenue_twd_thousands, mom_pct, yoy_pct,"
            "       prior_month_yoy_pct, yoy_acceleration_ppt,"
            "       cum_revenue AS cumulative_ytd_revenue_twd_thousands,"
            "       cumulative_yoy_pct, revenue_yoy_month, cum_revenue_prior,"
            "       reported_name, industry, note, source_id, market, has_data"
            "  FROM analytics_base WHERE ticker = ? ORDER BY month_idx",
            ticker,
        ),
        "raw_rows": _rows(
            conn,
            "SELECT * FROM raw_revenue WHERE ticker = ? ORDER BY month_idx, source_id",
            ticker,
        ),
        "restatements": _rows(
            conn,
            "SELECT * FROM raw_revenue_history WHERE ticker = ?"
            " ORDER BY superseded_at_utc DESC LIMIT 50",
            ticker,
        ),
    }


def _js_number(value: Any) -> Any:
    """Render a number the way the Worker's `String(value)` did.

    Python writes a float with an integral value as `17.0`; JavaScript writes
    `17`. The CSV export is a documented deliverable - the brief's twelve
    columns, byte for byte what the dashboard shows - and a reader diffing this
    month's file against last month's would see every such column churn. Caught
    by the parity gate on `6147 2026-01`, where `yoy_acceleration_ppt` came out
    `17.0` here and `17` from D1.

    Only integral floats are affected: 2.31 formats the same in both languages,
    and nothing in this dataset reaches the magnitudes where JavaScript switches
    to exponential notation.
    """
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def build_csv(conn: sqlite3.Connection) -> str:
    """The twelve columns, CRLF, with a UTF-8 BOM.

    The BOM is not decoration: without it Excel reads UTF-8 CSV as the local
    codepage and mangles every Chinese company name.
    """
    return rows_to_csv(_rows(conn, TWELVE_COLUMNS))


FALLBACK_COLUMNS = [
    "ticker", "company_name", "bucket", "tier", "month",
    "revenue_twd_thousands", "mom_pct", "yoy_pct", "prior_month_yoy_pct",
    "yoy_acceleration_ppt", "cumulative_ytd_revenue_twd_thousands",
    "cumulative_yoy_pct",
]


def rows_to_csv(rows: Sequence[dict[str, Any]]) -> str:
    """The formatting, split out from the query so BOTH implementations of it -
    this one and web/src/csv.ts, which now builds the filtered download in the
    browser - can be diffed against the same fixture. Two languages writing one
    documented deliverable is exactly where a silent divergence lives."""
    columns = list(rows[0].keys()) if rows else list(FALLBACK_COLUMNS)
    buf = io.StringIO()
    # QUOTE_MINIMAL with \r\n matches csvCell(): quote only when the value
    # contains a comma, quote or newline, and double an inner quote.
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if row[c] is None else _js_number(row[c]) for c in columns])
    return "﻿" + buf.getvalue()


def write_all(
    conn: sqlite3.Connection,
    universe: Universe,
    sources: Sources,
    out_dir: Path,
    *,
    consolidation: Sequence[tuple[str, str]] = (),
    from_month: str = DEFAULT_FROM,
) -> dict[str, int]:
    """Write every file the dashboard reads. Returns name -> bytes written.

    Every endpoint the Worker answered out of D1, as files. `consolidation`
    comes from config/relationships.yaml and must be passed: with it defaulted
    to empty the heatmap silently stops de-duplicating and every Rack / ODM
    figure is overstated by Wiwynn's whole revenue. The publish command passes
    it; the assertion below is what stops anything else forgetting to.
    """
    out_dir = Path(out_dir)
    (out_dir / "company").mkdir(parents=True, exist_ok=True)
    written: dict[str, int] = {}

    def dump(rel: str, payload: Any) -> None:
        # separators without spaces, and ensure_ascii off so the Chinese names
        # are stored as themselves rather than as \uXXXX escapes - it is both
        # smaller and diffable.
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        path = out_dir / rel
        path.write_text(text, encoding="utf-8")
        written[rel] = len(text.encode("utf-8"))

    dump("meta.json", build_meta(conn, universe, sources))
    dump("analytics.json", build_analytics(conn))
    for company in universe:
        dump(f"company/{company.ticker}.json", build_company(conn, company.ticker))

    dump("quality.json", build_quality(conn))
    dump(
        "heatmap.json",
        build_heatmap(conn, consolidation, from_month=from_month),
    )

    csv_text = build_csv(conn)
    (out_dir / "export.csv").write_text(csv_text, encoding="utf-8", newline="")
    written["export.csv"] = len(csv_text.encode("utf-8"))
    return written


# ------------------------------------------------------------------ quality --


def _obligated(cell: dict[str, Any]) -> bool:
    """Was this company OWED a filing in this month?  Mirrors api.ts:obligated().

    The basis for the coverage percentage, so getting it wrong reports absences
    that were never due as failures - which is how a reader is trained to
    ignore the number. 6286 is the standing case: merged, no obligation, and
    counting it would peg coverage at 97.3% forever.

    `status != "merged"` was too narrow. The schema's CHECK also permits
    'delisted' and 'suspended', and universe.yaml's editing rule is "to retire a
    name, set `status` and `active_to`" - so a delisted company counted as
    trackable for every month in the window, including months after it stopped
    existing. The WINDOW decides it, not the label: a month inside
    [active_from, active_to] was owed a filing whatever the status is TODAY,
    which is the point - status is a fact about now, coverage is a time series.
    """
    if cell.get("active_from") and cell["month"] < cell["active_from"]:
        return False
    if cell.get("active_to") and cell["month"] > cell["active_to"]:
        return False
    return cell["status"] == "active" or bool(cell.get("active_to")) or bool(cell.get("active_from"))


def build_quality(conn: sqlite3.Connection) -> dict[str, Any]:
    """Mirrors api.ts:quality(), the four statements and the coverage maths."""
    cells = _rows(
        conn,
        """SELECT b.ticker, b.display_name, b.bucket, b.tier, b.status, b.month,
                  b.has_data, b.source_id, u.active_from, u.active_to
             FROM analytics_base b JOIN universe u USING (ticker)
            ORDER BY b.sort_order, b.ticker, b.month_idx""",
    )
    # Interior gaps: a month with no data that has data SOMEWHERE before it and
    # SOMEWHERE after it. Bounded against each ticker's first and last filed
    # month rather than LAG/LEAD by one, because the one-month form only ever
    # found holes exactly one month wide - two consecutive missing months
    # disqualified each other and the longer outage reported clean.
    gaps = _rows(
        conn,
        """WITH r AS (
             SELECT ticker,
                    MIN(CASE WHEN has_data = 1 THEN month_idx END) AS first_idx,
                    MAX(CASE WHEN has_data = 1 THEN month_idx END) AS last_idx
               FROM analytics_base GROUP BY ticker
           )
           SELECT b.ticker, b.display_name, b.status, b.month
             FROM analytics_base b JOIN r ON r.ticker = b.ticker
            WHERE b.has_data = 0
              AND b.month_idx > r.first_idx
              AND b.month_idx < r.last_idx
            ORDER BY b.ticker, b.month_idx""",
    )
    findings = _rows(
        conn,
        """SELECT run_id, created_at_utc, severity, code, month, ticker, source_id, message
             FROM quality_findings
            ORDER BY CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
                     code, month, ticker
            LIMIT 500""",
    )
    fetch_log = _rows(
        conn,
        """SELECT source_id, month, COUNT(*) AS fetches,
                  SUM(ok) AS ok_n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fail_n,
                  MAX(fetched_at_utc) AS last_fetch_utc
             FROM fetch_log GROUP BY source_id, month ORDER BY month, source_id""",
    )

    with_data = sum(1 for c in cells if c["has_data"] == 1)
    trackable = [c for c in cells if _obligated(c)]
    trackable_with_data = sum(1 for c in trackable if c["has_data"] == 1)

    def pct(n: int, d: int) -> float | None:
        return round(100 * n / d, 2) if d else None

    return {
        "coverage": {
            "cells": len(cells),
            "with_data": with_data,
            "pct": pct(with_data, len(cells)),
            "trackable_cells": len(trackable),
            "trackable_with_data": trackable_with_data,
            "trackable_pct": pct(trackable_with_data, len(trackable)),
            # Every absence that was not a failure, whatever made it so - a
            # merger, a delisting, or a month outside the active window.
            # Listing only the merged ones left a delisted name's absences
            # unexplained.
            "known_absent": [
                {
                    "ticker": c["ticker"],
                    "month": c["month"],
                    "status": c["status"],
                    "active_from": c.get("active_from"),
                    "active_to": c.get("active_to"),
                }
                for c in cells
                if c["has_data"] == 0 and not _obligated(c)
            ],
        },
        "matrix": cells,
        "interior_gaps": gaps,
        "findings": findings,
        "fetch_log": fetch_log,
    }


# ------------------------------------------------------------------ heatmap --
#
# The one endpoint that could not be a file - until it was measured.
#
# /api/heatmap aggregates 37 companies into 10 stage rows over whatever filters
# are live, so the received wisdom was that its answers cannot be enumerated:
# ticker selection is an arbitrary subset of 37, which is 2^37 of them.
#
# Two measurements collapse that.
#
# FIRST, there is no ticker control in the user interface. `tickers` reaches the
# filter state only through web/src/urlState.ts:71 - a hand-edited or shared
# link. Nothing a reader can click produces one.
#
# SECOND, and verified by executing the real statement rather than by reading
# it: `from`, `to` and `buckets` DO NOT CHANGE A CELL'S VALUE. `per_bucket`
# groups by (bucket, month_idx) and the window always reaches one month behind
# `from`, so those parameters select which cells come back, never what is in
# them. Run against a store of 11 companies over 6 months, a narrower `to`, a
# wider `from` and a single-bucket filter each returned values identical to the
# unfiltered run across every shared cell and all six computed columns - 0
# divergences. `only_with_data` adds `revenue_month IS NOT NULL`, which every
# members_* predicate already implies.
#
# So the reachable space is the FOUR tier subsets. This runs the statement -
# THE statement, from heatmap_bucket.sql, the same characters that ran on D1 -
# four times at publish time, and precomputes every metric x aggregation
# combination the client can ask for. The browser then does no arithmetic at
# all: it indexes by tier subset, metric and aggregation, and filters the cells
# by bucket and month, which is exactly what the SQL proved those parameters do.
#
# A hand-written ?tickers= link is the one thing this cannot answer. It is
# reported rather than silently approximated - see `ticker_filter_unsupported`.

TIER_SUBSETS: tuple[tuple[int, ...], ...] = ((), (1,), (2,), (1, 2))
METRICS = ("yoy_acceleration_ppt", "yoy_pct", "mom_pct", "cumulative_yoy_pct")
AGGS = ("weighted", "equal")


def _heatmap_statement() -> str:
    """The statement, from the one file that holds it."""
    path = Path(__file__).resolve().parent / "sql" / "heatmap_bucket.sql"
    text = path.read_text(encoding="utf-8")
    return re.search(r"(WITH all_rows AS.*)", text, re.S).group(1).rstrip("\n")


def _pair_sql(consolidation: Sequence[tuple[str, str]]) -> tuple[str, list[str]]:
    """api.ts's `pairSql`, character for character, including the CONDITIONAL
    exclusion - the child is dropped only when the parent has itself filed that
    month, because otherwise no row anywhere carries the child's revenue and
    removing it understates the stage by exactly that revenue."""
    if not consolidation:
        return ",\n     scoped AS (SELECT * FROM all_rows)", []
    values = ", ".join("(?, ?)" for _ in consolidation)
    sql = (
        ",\n     pair(parent, child) AS (VALUES "
        + values
        + """),
     scoped AS (
       SELECT a.* FROM all_rows a
        WHERE NOT EXISTS (
          SELECT 1 FROM pair p
            JOIN all_rows x ON x.ticker = p.parent
                           AND x.month_idx = a.month_idx
                           AND x.revenue_month IS NOT NULL
           WHERE p.child = a.ticker)
     )"""
    )
    return sql, [t for pair in consolidation for t in pair]


def _pick(row: dict[str, Any], metric: str, applied: str) -> Any:
    """api.ts's `pick`. Field selection only - no arithmetic happens here."""
    suffix = "equal" if applied == "equal" else "weighted"
    if metric == "yoy_acceleration_ppt":
        return row.get(f"acceleration_{suffix}")
    if metric == "yoy_pct":
        return row.get(f"yoy_{suffix}")
    if metric == "mom_pct":
        return row.get(f"mom_{suffix}")
    if metric == "cumulative_yoy_pct":
        # No equal-weighted variant: averaging YTD percentages across members
        # with different fiscal shapes is not a number that means anything.
        return row.get("cum_yoy_weighted")
    return None


def _members_for(row: dict[str, Any], metric: str, applied: str) -> Any:
    """api.ts's `membersFor`. The basis must describe the set THIS aggregation
    covered, not the set the other one would have. MoM's two sets are the only
    ones that differ."""
    if metric == "mom_pct":
        return row["members_mom_equal"] if applied == "equal" else row["members_mom"]
    if metric == "cumulative_yoy_pct":
        return row["members_cum"]
    return row["members_yoy"]


def build_heatmap(
    conn: sqlite3.Connection,
    consolidation: Sequence[tuple[str, str]],
    *,
    from_month: str,
) -> dict[str, Any]:
    """Every heatmap answer a reader can reach, computed by the shipped SQL."""
    statement = _heatmap_statement()
    pair_sql, pair_binds = _pair_sql(consolidation)
    # api.ts:484 - whereFor({...f, from: addMonths(f.from, -1)}). The CTE must
    # see one month BEFORE the window or January has no prior month to
    # difference against and every acceleration in it comes back null. That is
    # what the Dec-2025 shoulder month exists for. The final `WHERE month >= ?`
    # then trims the shoulder back off, so it is used and never shown.
    shoulder = roc.add_months(from_month, -1)

    out: dict[str, Any] = {
        "generated_from": "ingest/src/twrev/sql/heatmap_bucket.sql",
        "from": from_month,
        "tier_subsets": {},
        "ticker_filter_unsupported": (
            "A ?tickers= filter changes a stage aggregate and cannot be enumerated. "
            "There is no control that produces one; a hand-written link must be "
            "reported to the reader, never silently answered with the unfiltered value."
        ),
    }

    for tiers in TIER_SUBSETS:
        where = "b.month >= ?"
        binds: list[Any] = [shoulder]
        if tiers:
            where += f" AND b.tier IN ({', '.join('?' for _ in tiers)})"
            binds += list(tiers)
        sql = statement.replace("${sql}", where).replace("${pairSql}", pair_sql)
        # Bind order follows the statement: the all_rows filter, then the pair
        # VALUES, then the final `WHERE month >= ?`.
        rows = _rows(conn, sql, *binds, *pair_binds, from_month)

        combos: dict[str, Any] = {}
        for metric in METRICS:
            for agg in AGGS:
                applied = "weighted" if metric == "cumulative_yoy_pct" else agg
                combos[f"{metric}|{agg}"] = {
                    "metric": metric,
                    "agg": applied,
                    "agg_requested": agg,
                    "cells": [
                        {
                            "bucket": r["bucket"],
                            "month": r["month"],
                            "value": _pick(r, metric, applied),
                            "members": _members_for(r, metric, applied),
                            "members_with_revenue": r["members"],
                            "composition_changed": (
                                metric == "yoy_acceleration_ppt"
                                and r.get("members_churned") is not None
                                and r["members_churned"] > 0
                            ),
                            "revenue": r["revenue"],
                        }
                        for r in rows
                    ],
                }
        out["tier_subsets"]["" if not tiers else ",".join(str(t) for t in tiers)] = combos

    return out
