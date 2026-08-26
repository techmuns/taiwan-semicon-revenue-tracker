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
import sqlite3
from pathlib import Path
from typing import Any

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

    return {
        "universe": _rows(
            conn,
            "SELECT ticker, display_name, name_zh, bucket, tier, market_hint, status,"
            "       successor, thesis, notes, sort_order"
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
        "findings_by_code": _rows(
            conn,
            "SELECT severity, code, COUNT(*) AS n FROM quality_findings"
            " GROUP BY severity, code ORDER BY"
            "   CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END, code",
        ),
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
    rows = _rows(conn, TWELVE_COLUMNS)
    columns = list(rows[0].keys()) if rows else [
        "ticker", "company_name", "bucket", "tier", "month",
        "revenue_twd_thousands", "mom_pct", "yoy_pct", "prior_month_yoy_pct",
        "yoy_acceleration_ppt", "cumulative_ytd_revenue_twd_thousands",
        "cumulative_yoy_pct",
    ]
    buf = io.StringIO()
    # QUOTE_MINIMAL with \r\n matches the Worker's csvCell(): quote only when
    # the value contains a comma, quote or newline, and double an inner quote.
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
) -> dict[str, int]:
    """Write every file the dashboard reads. Returns name -> bytes written."""
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

    csv_text = build_csv(conn)
    (out_dir / "export.csv").write_text(csv_text, encoding="utf-8", newline="")
    written["export.csv"] = len(csv_text.encode("utf-8"))
    return written
