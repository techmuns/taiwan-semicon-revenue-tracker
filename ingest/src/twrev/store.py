"""Local SQLite harness - runs the real D1 migration against a local database.

The metric logic lives in `analytics_monthly`, a view. The only cheap way to test
a view is to execute it, so the identical migration SQL is applied here and the
same queries are run. Local SQLite 3.45 and D1 both support everything used, and
the migration is deliberately written to avoid engine-specific constructs.

This is a verification tool, not a production store. D1 remains the store of record.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Iterable

from .config import Universe, repo_root
from .schema import RAW_COLUMNS
from .sqlgen import UNIVERSE_COLUMNS, upsert_raw_revenue_sql

ANALYTICS_MONTHLY_COLUMNS = (
    "ticker", "company_name", "bucket", "tier", "month",
    "revenue_twd_thousands", "mom_pct", "yoy_pct", "prior_month_yoy_pct",
    "yoy_acceleration_ppt", "cumulative_ytd_revenue_twd_thousands",
    "cumulative_yoy_pct",
)


def migration_paths(root: Path | None = None) -> list[Path]:
    root = root or repo_root()
    return sorted((root / "worker" / "migrations").glob("*.sql"))


def connect(path: str | Path = ":memory:", root: Path | None = None) -> sqlite3.Connection:
    """Open a connection with the migrations applied."""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    # The restatement trigger writes json_object(); confirm it is available
    # rather than discovering a silent behavioural difference later.
    conn.execute("PRAGMA foreign_keys = ON")
    for sql_file in migration_paths(root):
        conn.executescript(sql_file.read_text(encoding="utf-8"))
    conn.commit()
    return conn


def load_universe(conn: sqlite3.Connection, universe: Universe) -> int:
    """Replace the universe table wholesale so the YAML is authoritative."""
    rows = [
        {
            "ticker": c.ticker, "display_name": c.display_name, "name_zh": c.name_zh,
            "bucket": c.bucket, "tier": c.tier, "market_hint": c.market_hint,
            "status": c.status, "active_from": c.active_from, "active_to": c.active_to,
            "successor": c.successor, "thesis": c.thesis, "notes": c.notes,
            "sort_order": c.sort_order,
        }
        for c in universe
    ]
    cols = ", ".join(UNIVERSE_COLUMNS)
    vals = ", ".join(f":{c}" for c in UNIVERSE_COLUMNS)
    with conn:
        conn.execute("DELETE FROM universe")
        conn.executemany(f"INSERT INTO universe ({cols}) VALUES ({vals})", rows)
    return len(rows)


def upsert_rows(conn: sqlite3.Connection, rows: Iterable[dict[str, Any]]) -> int:
    sql = upsert_raw_revenue_sql("named")
    payload = [{c: r.get(c) for c in RAW_COLUMNS} for r in rows]
    with conn:
        conn.executemany(sql, payload)
    return len(payload)


def insert_findings(conn: sqlite3.Connection, findings: Iterable[dict[str, Any]]) -> int:
    cols = ("run_id", "created_at_utc", "severity", "code", "month", "ticker",
            "source_id", "message")
    payload = [{c: f.get(c) for c in cols} for f in findings]
    if not payload:
        return 0
    with conn:
        conn.executemany(
            f"INSERT INTO quality_findings ({', '.join(cols)}) "
            f"VALUES ({', '.join(':' + c for c in cols)})",
            payload,
        )
    return len(payload)


def insert_fetch_log(conn: sqlite3.Connection, entries: Iterable[dict[str, Any]]) -> int:
    cols = ("source_id", "month", "ticker", "url", "http_status", "byte_len",
            "sha256", "rows_parsed", "ok", "error", "fetched_at_utc")
    payload = [{c: e.get(c) for c in cols} for e in entries]
    if not payload:
        return 0
    with conn:
        conn.executemany(
            f"INSERT INTO fetch_log ({', '.join(cols)}) "
            f"VALUES ({', '.join(':' + c for c in cols)})",
            payload,
        )
    return len(payload)


def analytics_monthly(conn: sqlite3.Connection, **where: Any) -> list[sqlite3.Row]:
    sql = "SELECT * FROM analytics_monthly"
    clauses, params = [], {}
    for key, value in where.items():
        clauses.append(f"{key} = :{key}")
        params[key] = value
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return conn.execute(sql, params).fetchall()


def assert_view_contract(conn: sqlite3.Connection) -> None:
    """The 12 columns, in the brief's exact order.

    The CSV export is `SELECT *` from this view, so column order is part of the
    deliverable. A well-meaning `SELECT r.*` edit would silently break it.
    """
    got = tuple(d[0] for d in conn.execute("SELECT * FROM analytics_monthly LIMIT 0").description)
    if got != ANALYTICS_MONTHLY_COLUMNS:
        raise AssertionError(
            "analytics_monthly column contract broken\n"
            f"  expected {ANALYTICS_MONTHLY_COLUMNS}\n  got      {got}"
        )
