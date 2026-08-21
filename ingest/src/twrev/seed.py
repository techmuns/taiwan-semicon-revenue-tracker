"""Render a backfill Report as D1 seed SQL.

Applied with:

    npx wrangler d1 execute taiwan-semicon-revenue --remote --file=ingest/out/seed.sql

Three properties the generated file must have, in order of importance:

1. **Idempotent.** Re-applying it converges to identical state - the same row
   counts, an empty `raw_revenue_history`, and byte-identical `analytics_monthly`
   output. `raw_revenue` gets that from the hash-gated upsert; `universe` from
   DELETE + re-INSERT; `fetch_log` and `quality_findings` from a scoped DELETE
   ahead of their inserts, since they are append-only tables with no natural key.

2. **No explicit transaction.** D1 rejects `BEGIN`/`COMMIT` - it wraps a
   `--file` batch in its own transaction, so the statements here are already
   atomic as a group. Emitting BEGIN would fail the whole apply. The local
   harness gets the same atomicity from `with conn:`.

3. **Auditable.** The header records what produced the file and what it contains,
   so a diff between two seeds is readable and a stale file is obvious.
"""

from __future__ import annotations

import json
from typing import Any

from . import roc
from .backfill import Report
from .config import Sources, Universe
from .http import utc_now_iso
from .schema import RAW_COLUMNS
from .sqlgen import (
    SOURCE_FEED_COLUMNS,
    UNIVERSE_COLUMNS,
    insert_batch_values_sql,
    insert_values_sql,
    upsert_batch_literal_sql,
)

FETCH_LOG_COLUMNS = (
    "source_id", "month", "ticker", "url", "http_status", "byte_len",
    "sha256", "rows_parsed", "ok", "error", "fetched_at_utc",
)

FINDING_COLUMNS = (
    "run_id", "created_at_utc", "severity", "code", "month", "ticker",
    "source_id", "message",
)


def _universe_rows(universe: Universe) -> list[dict[str, Any]]:
    return [
        {
            "ticker": c.ticker, "display_name": c.display_name, "name_zh": c.name_zh,
            "bucket": c.bucket, "tier": c.tier, "market_hint": c.market_hint,
            "status": c.status, "active_from": c.active_from, "active_to": c.active_to,
            "successor": c.successor, "thesis": c.thesis, "notes": c.notes,
            "sort_order": c.sort_order,
        }
        for c in universe
    ]


def _source_feed_rows(sources: Sources) -> list[dict[str, Any]]:
    """The refresh feeds, in YAML order, for the Worker cron to read at runtime.

    `precedence` is the list index, and index 0 must be the brief's feed - the
    same guarantee `load_sources` enforces on the YAML. It is restated here
    because this is the value the Worker acts on: if the ordering were ever
    inverted between this table and analytics_monthly's source-precedence CASE,
    the cron and the view would disagree about which row is authoritative, and
    nothing else would signal it.
    """
    if sources.feeds[0].role != "specified":
        raise ValueError(
            "refresh.feeds[0] must have role 'specified'; refusing to seed a "
            "precedence that demotes the brief's endpoint"
        )
    return [
        {
            "source_id": f.source_id,
            "role": f.role,
            "url": f.url,
            "market": f.market,
            "expect_min_records": f.expect_min_records,
            "expect_target_coverage": f.expect_target_coverage,
            "anchor_tickers": json.dumps(list(f.anchor_tickers), ensure_ascii=False),
            "notes": f.notes,
            "precedence": i,
        }
        for i, f in enumerate(sources.feeds)
    ]


def _month_list(report: Report) -> list[str]:
    """Months this seed speaks for - taken from the rows AND the fetch log.

    The fetch log matters: a month where every company returned "not published"
    produces no rows but was still covered, and the scoped DELETE must include it
    or a re-seed would leave that month's stale log entries behind.
    """
    months = {r["month"] for r in report.rows}
    months |= {e["month"] for e in report.fetch_log if e.get("month")}
    return sorted(months)


def build(
    *,
    universe: Universe,
    report: Report,
    sources: Sources | None = None,
    source_id: str = "mops_company",
    include_log: bool = True,
) -> str:
    months = _month_list(report)
    rows = sorted(report.rows, key=lambda r: (r["ticker"], r["month_idx"]))
    run_id = report.run_id or f"seed-{utc_now_iso()}"

    out: list[str] = []
    w = out.append

    # ------------------------------------------------------------ provenance --
    w("-- Taiwan semiconductor revenue tracker - D1 seed")
    w(f"-- generated_at_utc : {utc_now_iso()}")
    w(f"-- run_id           : {run_id}")
    w(f"-- source_id        : {source_id}")
    w(f"-- months           : {months[0] if months else '-'}"
      f"..{months[-1] if months else '-'} ({len(months)})")
    w(f"-- universe         : {len(universe)} companies "
      f"({len(universe.trackable_tickers)} trackable)")
    w(f"-- revenue rows     : {len(rows)}")
    w(f"-- findings         : {len(report.findings)}")
    w(f"-- counts           : {report.summary()}")
    w("--")
    w("-- Idempotent: re-applying converges to identical state.")
    w("-- No BEGIN/COMMIT - D1 wraps a --file batch in its own transaction.")
    w("")

    # -------------------------------------------------------------- universe --
    # Rewritten wholesale so config/universe.yaml is always authoritative and
    # an edit there cannot leave a stale bucket or tier behind in D1.
    w("-- ============================================================ universe ==")
    w("DELETE FROM universe;")
    out.extend(insert_values_sql("universe", UNIVERSE_COLUMNS, _universe_rows(universe)))
    w("")

    # ----------------------------------------------------------- source_feed --
    # The refresh feed list and precedence, so the Worker cron reads them from D1
    # rather than carrying a second copy of config/sources.yaml in TypeScript.
    if sources is not None:
        w("-- ========================================================= source_feed ==")
        w("DELETE FROM source_feed;")
        out.extend(insert_values_sql(
            "source_feed", SOURCE_FEED_COLUMNS, _source_feed_rows(sources)
        ))
        w("DELETE FROM source_config;")
        out.extend(insert_values_sql("source_config", ("key", "value"), [
            {"key": "month_field", "value": sources.month_field},
            {"key": "percent_sentinel", "value": repr(sources.percent_sentinel)},
            {"key": "revenue_unit", "value": sources.revenue_unit},
            {"key": "backfill_url_template", "value": sources.backfill.url_template},
            {"key": "backfill_source_id", "value": sources.backfill.source_id},
            {"key": "backfill_body_anchor", "value": sources.backfill.body_anchor},
        ]))
        w("")

    # ----------------------------------------------------------- raw_revenue --
    w("-- ========================================================= raw_revenue ==")
    w(f"-- {len(rows)} company-months, as reported. Percentages in src_*_pct are")
    w("-- the source's own and are kept for cross-checking only; every metric in")
    w("-- analytics_monthly is recomputed from the integer levels below.")
    if rows:
        out.extend(upsert_batch_literal_sql(rows))
    else:
        w("-- (no rows in this report)")
    w("")

    if include_log:
        # ------------------------------------------------------- fetch_log --
        # Scoped DELETE keeps a re-apply idempotent: fetch_log is append-only
        # with an autoincrement key, so without this a second apply would double
        # every entry and corrupt the freshness read.
        w("-- =========================================================== fetch_log ==")
        if months:
            month_in = ", ".join(f"'{m}'" for m in months)
            w(f"DELETE FROM fetch_log WHERE source_id = '{source_id}' "
              f"AND month IN ({month_in});")
        if report.fetch_log:
            out.extend(insert_batch_values_sql(
                "fetch_log", FETCH_LOG_COLUMNS, report.fetch_log
            ))
        w("")

        # ------------------------------------------------- quality_findings --
        w("-- ==================================================== quality_findings ==")
        w(f"DELETE FROM quality_findings WHERE run_id = '{run_id}';")
        if report.findings:
            out.extend(insert_batch_values_sql(
                "quality_findings", FINDING_COLUMNS, report.findings
            ))
        w("")

    # ----------------------------------------------------------- read-backs --
    # Commented so the file stays pure DDL/DML, but ready to paste. These are the
    # golden numbers - if they do not reproduce in D1, the seed did not land.
    w("-- Verify after applying:")
    w("--   SELECT count(*) FROM raw_revenue;")
    w("--   SELECT * FROM analytics_monthly WHERE ticker='2330' ORDER BY month;")
    w("--   -- 2330 2026-03 must read revenue_twd_thousands = 415191699 (not ...700)")
    w("--   SELECT count(*) FROM raw_revenue_history;  -- 0 on a first apply")
    return "\n".join(out) + "\n"


def golden_checks(rows: list[dict[str, Any]]) -> list[str]:
    """Assertions on the seeded rows that must hold before the file is trusted.

    Returns a list of failure messages; empty means the seed is safe to apply.
    These are the checks that catch a units change or a silent precision loss -
    the two failure modes that would otherwise look like plausible data.
    """
    problems: list[str] = []
    by_key = {(r["ticker"], r["month"]): r for r in rows}

    golden = by_key.get(("2330", "2026-03"))
    if golden is None:
        problems.append("golden row 2330/2026-03 absent from the seed")
    else:
        expect = {
            "revenue_month": 415191699,
            "revenue_yoy_month": 285956830,
            "cum_revenue": 1134103440,
            "cum_revenue_prior": 839253664,
        }
        for field_name, want in expect.items():
            got = golden.get(field_name)
            if got != want:
                problems.append(
                    f"2330/2026-03 {field_name}: expected {want:,}, got "
                    f"{got if got is None else format(got, ',')}"
                )

    # Units sanity across the whole set: TSMC monthly revenue in TWD thousands is
    # 1e8-1e9. A 1000x units change anywhere upstream fails here first.
    for (ticker, month), row in sorted(by_key.items()):
        if ticker != "2330":
            continue
        value = row.get("revenue_month")
        if value is not None and not (1e8 <= value <= 1e9):
            problems.append(
                f"2330/{month} revenue_month={value:,} outside 1e8..1e9 "
                f"TWD thousands - units may have changed"
            )

    # Tickers must be strings. An integer here silently breaks every join.
    for row in rows:
        if not isinstance(row.get("ticker"), str):
            problems.append(f"non-string ticker {row.get('ticker')!r}")
            break

    # Every row must carry the full column set, or the batched VALUES tuples
    # would silently shift a value into the wrong column.
    for row in rows:
        missing = [c for c in RAW_COLUMNS if c not in row]
        if missing:
            problems.append(
                f"{row.get('ticker')}/{row.get('month')} missing columns: {missing}"
            )
            break

    # month_idx must agree with month, since contiguity gating depends on it.
    for row in rows:
        if row.get("month") and row.get("month_idx") != roc.month_idx(row["month"]):
            problems.append(
                f"{row['ticker']}/{row['month']} month_idx={row.get('month_idx')} "
                f"disagrees with month"
            )
            break

    return problems
