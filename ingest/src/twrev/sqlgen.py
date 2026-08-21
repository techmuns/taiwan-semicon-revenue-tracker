"""SQL statement generation, shared by the local harness and the D1 seed.

Both paths must issue byte-identical statements, otherwise the local test proves
nothing about what D1 will do. So the statements are built here once: `store.py`
executes them against local SQLite with bound parameters, and `seed.py` renders
the same statements with inlined literals for `wrangler d1 execute --file`.
"""

from __future__ import annotations

from typing import Any, Iterable

from .schema import RAW_COLUMNS

# Mirrors the universe table in 0001_init.sql. Lives here rather than in store.py
# so the seed generator does not have to import the local test harness.
UNIVERSE_COLUMNS = (
    "ticker", "display_name", "name_zh", "bucket", "tier", "market_hint",
    "status", "active_from", "active_to", "successor", "thesis", "notes",
    "sort_order",
)

# Mirrors source_feed in 0002_source_feed.sql. The Worker cron reads the refresh
# feed list and its precedence from D1, so this table is how config/sources.yaml
# reaches the Worker without a second copy of it existing in TypeScript.
SOURCE_FEED_COLUMNS = (
    "source_id", "role", "url", "market", "expect_min_records",
    "expect_target_coverage", "anchor_tickers", "notes", "precedence",
)

# Columns updated when a row already exists. first_seen_utc is deliberately
# excluded so the original sighting date survives a restatement.
_UPSERT_SET = tuple(c for c in RAW_COLUMNS if c != "first_seen_utc")


def upsert_raw_revenue_sql(placeholder: str = "named") -> str:
    """The idempotent upsert. `placeholder` is 'named' (:col) or 'qmark' (?).

    last_seen_utc is updated on EVERY sighting, including unchanged ones, so
    freshness is accurate. That is safe because the restatement trigger is gated
    on row_hash, not on whether an UPDATE ran - an unchanged re-fetch therefore
    touches the timestamp and writes no history.
    """
    cols = ", ".join(RAW_COLUMNS)
    if placeholder == "named":
        vals = ", ".join(f":{c}" for c in RAW_COLUMNS)
    elif placeholder == "qmark":
        vals = ", ".join("?" for _ in RAW_COLUMNS)
    else:
        raise ValueError(f"unknown placeholder style {placeholder!r}")
    sets = ",\n    ".join(f"{c} = excluded.{c}" for c in _UPSERT_SET)
    return (
        f"INSERT INTO raw_revenue ({cols})\nVALUES ({vals})\n"
        f"ON CONFLICT (source_id, month, ticker) DO UPDATE SET\n    {sets}"
    )


def sql_literal(value: Any) -> str:
    """Render a Python value as a SQL literal, quoting safely.

    Used only for generating the seed file, never for query construction from
    untrusted input - the Worker binds parameters instead.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # repr keeps full precision; SQLite parses it back exactly.
        return repr(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def insert_values_sql(table: str, columns: Iterable[str], rows: Iterable[dict[str, Any]]) -> list[str]:
    """One INSERT statement per row, with literals inlined."""
    columns = tuple(columns)
    col_sql = ", ".join(columns)
    out = []
    for row in rows:
        vals = ", ".join(sql_literal(row.get(c)) for c in columns)
        out.append(f"INSERT INTO {table} ({col_sql}) VALUES ({vals});")
    return out


def upsert_literal_sql(row: dict[str, Any]) -> str:
    """The upsert with this row's values inlined, for the seed file."""
    cols = ", ".join(RAW_COLUMNS)
    vals = ", ".join(sql_literal(row.get(c)) for c in RAW_COLUMNS)
    sets = ",\n    ".join(f"{c} = excluded.{c}" for c in _UPSERT_SET)
    return (
        f"INSERT INTO raw_revenue ({cols})\nVALUES ({vals})\n"
        f"ON CONFLICT (source_id, month, ticker) DO UPDATE SET\n    {sets};"
    )


def upsert_batch_literal_sql(
    rows: Iterable[dict[str, Any]], chunk: int = 50
) -> list[str]:
    """The same upsert, but with many VALUES tuples per statement.

    Per-row statements would repeat the 20-column ON CONFLICT SET clause 296
    times and produce a ~325KB file; grouping cuts that to ~60KB and gives D1
    far fewer statements to execute. SQLite applies a multi-row upsert row by
    row, so the semantics are identical - and our rows are unique on the
    conflict key by construction, so no two tuples in a batch can collide with
    each other.

    This IS a different statement shape from the one `store.upsert_rows`
    executes, which would otherwise weaken the local test. That is covered by
    executing the generated file itself and comparing the resulting
    analytics_monthly against the parameterised path (see
    tests/test_seed.py::test_generated_seed_matches_parameterised_path).
    """
    rows = list(rows)
    cols = ", ".join(RAW_COLUMNS)
    sets = ",\n    ".join(f"{c} = excluded.{c}" for c in _UPSERT_SET)
    out: list[str] = []
    for start in range(0, len(rows), chunk):
        tuples = ",\n  ".join(
            "(" + ", ".join(sql_literal(r.get(c)) for c in RAW_COLUMNS) + ")"
            for r in rows[start:start + chunk]
        )
        out.append(
            f"INSERT INTO raw_revenue ({cols})\nVALUES\n  {tuples}\n"
            f"ON CONFLICT (source_id, month, ticker) DO UPDATE SET\n    {sets};"
        )
    return out


def insert_batch_values_sql(
    table: str, columns: Iterable[str], rows: Iterable[dict[str, Any]], chunk: int = 100
) -> list[str]:
    """Plain multi-row INSERT, chunked. For fetch_log and quality_findings."""
    columns = tuple(columns)
    rows = list(rows)
    col_sql = ", ".join(columns)
    out: list[str] = []
    for start in range(0, len(rows), chunk):
        tuples = ",\n  ".join(
            "(" + ", ".join(sql_literal(r.get(c)) for c in columns) + ")"
            for r in rows[start:start + chunk]
        )
        out.append(f"INSERT INTO {table} ({col_sql}) VALUES\n  {tuples};")
    return out
