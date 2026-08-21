"""Adapters for the brief's ongoing-refresh feeds: TWSE `_P` / `_L`, TPEx `_O`.

The brief specifies `t187ap05_P` for the monthly refresh, so it stays first in
precedence in `config/sources.yaml` and is fetched first here. A live check on
2026-08-21 found it carries 296 records, all 產業別=證券, and none of the 37
universe tickers - it is the 公開發行公司 (non-listed public issuers) dataset.
That is reported as a `SOURCE_EMPTY` finding rather than an error, and the two
declared fallbacks are then read, so "the specified feed covered nothing" is a
visible fact in the data rather than a silent gap or a broken-looking cron.

All three feeds are UTF-8 JSON, need no auth, share the same Chinese keys (hence
one `KEY_MAP`), and are **latest-month snapshots only** - every record in a given
response carries the same 資料年月. So none of them can backfill, which is
exactly the division of labour the brief describes.

Two rules this module enforces:

* **The month comes from the payload (`資料年月`), never from the clock.** Before
  the 10th the feed still shows the prior month; deriving the month from `today`
  would file that data under the wrong month and corrupt every YoY downstream.
* **Unlike the per-company endpoint, these feeds DO carry 上月營收**, so their
  rows populate `revenue_prev_month` and can support MoM on their own.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from . import roc
from .config import Feed, Universe
from .schema import (
    KEY_MAP,
    SchemaDriftError,
    assert_raw_row,
    blank_row,
    clean_int,
    clean_pct,
    clean_text,
    clean_ticker,
    row_hash,
)

# Keys that must be present for a record to be usable at all. The rest of KEY_MAP
# is allowed to be absent - a feed dropping 備註 is not a reason to reject a filing.
REQUIRED_KEYS = ("公司代號", "資料年月", "營業收入-當月營收")


@dataclass
class FeedResult:
    """One feed's contribution, plus everything needed to judge it."""
    source_id: str
    role: str
    month: str | None = None
    records: int = 0
    rows: list[dict[str, Any]] = field(default_factory=list)
    findings: list[tuple[str, str, str]] = field(default_factory=list)
    # Universe tickers this feed covered, and 資料年月 values seen.
    covered: set[str] = field(default_factory=set)
    months_seen: set[str] = field(default_factory=set)

    def emit(self, severity: str, code: str, message: str) -> None:
        self.findings.append((severity, code, message))


def validate_body(body: bytes, *, min_bytes: int = 200) -> str | None:
    """Retryable-error validator for CachedFetcher. None means "cache it".

    A truncated JSON body is the failure mode worth guarding: it parses as an
    error rather than as fewer records, so catching it here keeps a partial
    response out of the cache instead of poisoning every later offline re-parse.
    """
    if len(body) < min_bytes:
        return f"body too short ({len(body)} bytes)"
    try:
        payload = json.loads(body.decode("utf-8"))
    except UnicodeDecodeError as err:
        return f"not valid UTF-8: {err}"
    except json.JSONDecodeError as err:
        return f"not valid JSON: {err}"
    if not isinstance(payload, list):
        # A dict here is usually an error envelope, which is worth retrying.
        return f"expected a JSON array, got {type(payload).__name__}"
    if not payload:
        return "empty JSON array"
    return None


def cache_key(feed: Feed, month: str | None = None) -> str:
    """Snapshot feeds are keyed by the month they turn out to describe.

    The month is not known until the body is parsed, so callers fetch to a
    `latest` key and may re-file it once known; keeping both is deliberate, since
    the dated copy is the audit artifact and `latest` is what the cron overwrites.
    """
    suffix = month.replace("-", "") if month else "latest"
    return f"{feed.source_id}/{feed.source_id}_{suffix}.json"


def parse(
    body: bytes,
    *,
    feed: Feed,
    universe: Universe,
    expect_month: str | None = None,
) -> FeedResult:
    """Normalise one feed response into raw_revenue rows for universe tickers."""
    result = FeedResult(source_id=feed.source_id, role=feed.role)

    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, list):
        raise SchemaDriftError(
            f"{feed.source_id}: expected a JSON array, got {type(payload).__name__}"
        )
    result.records = len(payload)

    if payload:
        first = payload[0]
        if not isinstance(first, dict):
            raise SchemaDriftError(
                f"{feed.source_id}: records are {type(first).__name__}, not objects"
            )
        missing = [k for k in REQUIRED_KEYS if k not in first]
        if missing:
            raise SchemaDriftError(
                f"{feed.source_id}: record is missing required keys {missing}; "
                f"got {sorted(first)[:12]}"
            )

    if result.records < feed.expect_min_records:
        result.emit(
            "warn", "RECORD_COUNT_LOW",
            f"{feed.source_id}: {result.records} records, expected at least "
            f"{feed.expect_min_records} - the feed may be partially published",
        )

    wanted = set(universe.tickers)
    seen_tickers: set[str] = set()

    for record in payload:
        raw_ticker = str(record.get("公司代號", "")).strip()
        roc_yyyymm = str(record.get("資料年月", "")).strip()
        if roc_yyyymm:
            try:
                result.months_seen.add(roc.roc_yyyymm_to_month(roc_yyyymm))
            except (ValueError, KeyError):
                result.emit("warn", "BAD_MONTH_FIELD",
                            f"{feed.source_id}: unparseable 資料年月 {roc_yyyymm!r} "
                            f"on {raw_ticker}")
        if raw_ticker not in wanted:
            continue
        seen_tickers.add(raw_ticker)

    # A snapshot must describe exactly one month. More than one means the feed's
    # shape changed and every assumption about "latest month" is void.
    if len(result.months_seen) > 1:
        result.emit(
            "error", "MULTI_MONTH_SNAPSHOT",
            f"{feed.source_id}: response spans {sorted(result.months_seen)} - "
            f"these feeds are documented as single-month snapshots",
        )
        return result
    result.month = next(iter(result.months_seen), None)
    if result.month is None:
        result.emit("error", "NO_MONTH", f"{feed.source_id}: no usable 資料年月 found")
        return result

    if expect_month and result.month != expect_month:
        # Not an error: before the 10th, the prior month is the correct answer.
        result.emit(
            "info", "MONTH_NOT_YET_PUBLISHED",
            f"{feed.source_id}: latest published month is {result.month}, "
            f"not {expect_month} - expected before the filing deadline",
        )

    for record in payload:
        raw_ticker = str(record.get("公司代號", "")).strip()
        if raw_ticker not in wanted:
            continue
        try:
            row = _row_from_record(record, feed=feed, month=result.month)
        except SchemaDriftError as err:
            result.emit("error", "PARSE_FAILED", f"{feed.source_id} {raw_ticker}: {err}")
            continue
        result.rows.append(row)
        result.covered.add(row["ticker"])

    # The observation that motivated the fallback chain, asserted every run so a
    # change in _P's contents is noticed rather than assumed.
    if not result.covered:
        severity = "info" if feed.expect_target_coverage == 0 else "error"
        result.emit(
            severity, "SOURCE_EMPTY",
            f"{feed.source_id} ({feed.role}) covered 0 of {len(wanted)} universe "
            f"tickers across {result.records} records"
            + (" - as observed on 2026-08-21, hence the fallback chain"
               if feed.expect_target_coverage == 0 else ""),
        )
    elif len(result.covered) < feed.expect_target_coverage:
        result.emit(
            "warn", "COVERAGE_DROPPED",
            f"{feed.source_id}: covered {len(result.covered)} tickers, expected "
            f"{feed.expect_target_coverage} - missing "
            f"{sorted(set(_expected_of(feed, universe)) - result.covered)[:10]}",
        )

    # Anchors are the cheap proof that we are reading the feed we think we are.
    absent = [t for t in feed.anchor_tickers if t not in result.covered]
    if absent:
        result.emit(
            "error", "ANCHOR_MISSING",
            f"{feed.source_id}: anchor tickers {absent} absent - this feed may "
            f"no longer be the {feed.market or 'expected'} dataset",
        )

    return result


def _expected_of(feed: Feed, universe: Universe) -> list[str]:
    """Universe tickers whose market_hint matches this feed, for the diff message."""
    if not feed.market:
        return []
    return [c.ticker for c in universe if c.market_hint == feed.market]


def _row_from_record(record: dict[str, Any], *, feed: Feed, month: str) -> dict[str, Any]:
    row = blank_row()
    row["source_id"] = feed.source_id
    row["market"] = feed.market
    row["month"] = month
    row["month_idx"] = roc.month_idx(month)

    for key, column in KEY_MAP.items():
        if key not in record:
            continue
        value = record[key]
        if column == "ticker":
            row["ticker"] = clean_ticker(value)
        elif column in ("revenue_month", "revenue_prev_month", "revenue_yoy_month",
                        "cum_revenue", "cum_revenue_prior"):
            row[column] = clean_int(value)
        elif column in ("src_mom_pct", "src_yoy_pct", "src_cum_yoy_pct"):
            row[column] = clean_pct(value)
        else:
            row[column] = clean_text(value)

    if row["ticker"] is None:
        raise SchemaDriftError("record has no usable 公司代號")
    if row["roc_yyyymm"] is None:
        row["roc_yyyymm"] = roc.month_to_roc_yyyymm(month)

    row["row_hash"] = row_hash(row)
    return assert_raw_row(row)


# --------------------------------------------------------------------------
# Cross-source verification
# --------------------------------------------------------------------------

# Levels that must agree exactly between surfaces. Percentages are excluded: both
# sides round to 2dp, so a 0.01pp difference there is arithmetic, not disagreement.
COMPARE_LEVELS = (
    "revenue_month", "revenue_yoy_month", "cum_revenue", "cum_revenue_prior",
)


def compare(
    mops_rows: Iterable[dict[str, Any]],
    feed_rows: Iterable[dict[str, Any]],
) -> list[tuple[str, str, str]]:
    """Same filing on two surfaces must report identical integer levels.

    Any difference is an error, not a tolerance: the per-company MOPS page and
    the OpenAPI feed are two renderings of one filing. A mismatch means one of
    the two parsers is wrong, and this is the only check that can tell us which
    without a human reading the source.

    Returns findings as (severity, code, message).
    """
    left = {(r["ticker"], r["month"]): r for r in mops_rows}
    right: dict[tuple[str, str], dict[str, Any]] = {}
    for r in feed_rows:
        right.setdefault((r["ticker"], r["month"]), r)

    findings: list[tuple[str, str, str]] = []
    shared = sorted(set(left) & set(right))
    for key in shared:
        a, b = left[key], right[key]
        for column in COMPARE_LEVELS:
            av, bv = a.get(column), b.get(column)
            if av is None or bv is None:
                continue
            if av != bv:
                findings.append((
                    "error", "SOURCE_DISAGREEMENT",
                    f"{key[0]} {key[1]} {column}: {a['source_id']}={av:,} vs "
                    f"{b['source_id']}={bv:,} (delta {bv - av:+,})",
                ))
        # A rename is worth knowing about but must not break the series, which is
        # keyed on ticker and carries display_name from universe.yaml.
        if a.get("company_name") and b.get("company_name") and \
                a["company_name"] != b["company_name"]:
            findings.append((
                "info", "NAME_CHANGED",
                f"{key[0]}: {a['source_id']} reports {a['company_name']!r}, "
                f"{b['source_id']} reports {b['company_name']!r}",
            ))
    if not shared:
        findings.append((
            "warn", "NO_OVERLAP",
            "no (ticker, month) pairs shared between the two sources - "
            "cross-source verification proved nothing",
        ))
    return findings
