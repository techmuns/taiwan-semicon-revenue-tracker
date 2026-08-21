"""The raw-layer schema and the value coercions every adapter must go through.

`RAW_COLUMNS` is the contract between the adapters, the SQL seed and the D1 table.
Adding a column means adding it here, in `worker/migrations/`, and in the seed's
INSERT - `assert_raw_row` exists so that forgetting one of those fails loudly at
ingest time rather than silently writing NULLs.

Sources are deliberately allowed to be sparse. The per-company MOPS endpoint has
no 上月營收 field at all, so `revenue_prev_month` is NULL for every one of its
rows; the OpenAPI feeds fill it. Nothing downstream may assume a column is
populated just because it exists.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

# MOPS writes this into percentage fields when the denominator is zero or the
# value overflows the field width. Treating it as a number would produce a
# 999999.99% growth row, so it is mapped to None at parse time.
PERCENT_SENTINEL = 999999.99

# Values that mean "no figure", as opposed to zero.
NULL_TOKENS = frozenset({"", "-", "--", "—", "N/A", "n/a", "NA", "nan", "None", "無"})

TICKER_RE = re.compile(r"^\d{4}[A-Z]?$")

RAW_COLUMNS: tuple[str, ...] = (
    "source_id",           # which adapter produced the row; drives view precedence
    "market",              # sii|otc|None - a fact about the row, not a config guess
    "month",               # 'YYYY-MM' canonical
    "month_idx",           # year*12 + (month-1); integer contiguity checks
    "ticker",              # TEXT always - '0050' must not become 50
    "roc_yyyymm",          # as-fetched, e.g. '11503'; kept for traceability
    "company_name",        # AS REPORTED (Chinese). Display name comes from universe.yaml
    "industry",            # 產業別 where available; not in the required output
    "report_date",         # 出表日期 where available
    "revenue_month",       # 本月 / 當月營收            (TWD thousands)
    "revenue_prev_month",  # 上月營收; NULL from mops_company
    "revenue_yoy_month",   # 去年同期 / 去年當月營收
    "src_mom_pct",         # reported; QA cross-check only, never used for output
    "src_yoy_pct",         # reported; QA cross-check only
    "cum_revenue",         # 本年累計
    "cum_revenue_prior",   # 去年累計
    "src_cum_yoy_pct",     # reported; QA cross-check only
    "note",                # 備註
    "row_hash",            # over VALUE_COLUMNS only - see row_hash()
    "first_seen_utc",
    "last_seen_utc",
)

# Columns that carry actual reported figures. The hash covers exactly these, so
# re-fetching the same filing is a no-op while a restatement is detected.
# Excluding the timestamps is the whole point; including them would make every
# fetch look like a change and fill raw_revenue_history with noise.
VALUE_COLUMNS: tuple[str, ...] = (
    "company_name", "industry", "report_date",
    "revenue_month", "revenue_prev_month", "revenue_yoy_month",
    "src_mom_pct", "src_yoy_pct",
    "cum_revenue", "cum_revenue_prior", "src_cum_yoy_pct",
    "note",
)

INT_COLUMNS = frozenset({
    "revenue_month", "revenue_prev_month", "revenue_yoy_month",
    "cum_revenue", "cum_revenue_prior", "month_idx",
})
FLOAT_COLUMNS = frozenset({"src_mom_pct", "src_yoy_pct", "src_cum_yoy_pct"})

# OpenAPI JSON key -> RAW_COLUMNS name. All three feeds (_P, _L, _O) share these
# keys exactly, which is why one map serves all of them.
KEY_MAP: dict[str, str] = {
    "公司代號": "ticker",
    "公司名稱": "company_name",
    "產業別": "industry",
    "資料年月": "roc_yyyymm",
    "出表日期": "report_date",
    "營業收入-當月營收": "revenue_month",
    "營業收入-上月營收": "revenue_prev_month",
    "營業收入-去年當月營收": "revenue_yoy_month",
    "營業收入-上月比較增減(%)": "src_mom_pct",
    "營業收入-去年同月增減(%)": "src_yoy_pct",
    "累計營業收入-當月累計營收": "cum_revenue",
    "累計營業收入-去年累計營收": "cum_revenue_prior",
    "累計營業收入-前期比較增減(%)": "src_cum_yoy_pct",
    "備註": "note",
}

# The per-company MOPS revenue table, in the order the rows appear. The labels
# 增減金額 and 增減百分比 each appear TWICE, so the parser must map by position;
# this tuple is the assertion that the positions are what we think they are.
MOPS_ROW_LABELS: tuple[str, ...] = (
    "本月", "去年同期", "增減金額", "增減百分比",
    "本年累計", "去年累計", "增減金額", "增減百分比",
)
# Position -> RAW_COLUMNS name. The two 增減金額 rows are derived values we can
# recompute, so they are dropped rather than stored (and are instead used as a
# parser self-check).
MOPS_ROW_TARGETS: tuple[str | None, ...] = (
    "revenue_month", "revenue_yoy_month", None, "src_yoy_pct",
    "cum_revenue", "cum_revenue_prior", None, "src_cum_yoy_pct",
)


class SchemaDriftError(ValueError):
    """A source's structure changed. Never persist a row after this."""


def clean_int(value: Any) -> int | None:
    """'415,191,699' -> 415191699. Returns None for null tokens.

    Parses the comma-separated string directly and never routes through float:
    float(4.151917e+08) round-trips to 415191700, which is off by one from the
    filed 415191699. Percentages derived from a wrong level are wrong quietly.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise SchemaDriftError(f"bool where a revenue figure was expected: {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # Only reachable via JSON; assert it is integral before narrowing.
        if value != int(value):
            raise SchemaDriftError(f"non-integral revenue figure: {value!r}")
        return int(value)
    text = str(value).strip().replace(",", "").replace("　", "")
    if text in NULL_TOKENS:
        return None
    # Parenthesised negatives appear occasionally in accounting-style tables.
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    try:
        parsed = int(text)
    except ValueError:
        raise SchemaDriftError(f"cannot parse integer from {value!r}") from None
    return -parsed if negative else parsed


def clean_pct(value: Any) -> float | None:
    """'45.19' -> 45.19. Maps the 999999.99 sentinel and null tokens to None."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
    else:
        text = str(value).strip().replace(",", "").replace("%", "")
        if text in NULL_TOKENS:
            return None
        try:
            parsed = float(text)
        except ValueError:
            raise SchemaDriftError(f"cannot parse percent from {value!r}") from None
    if abs(parsed) >= PERCENT_SENTINEL - 0.005:
        return None
    return parsed


def clean_ticker(value: Any) -> str:
    """Normalise to a 4-digit string. Rejects anything else.

    Tickers are TEXT everywhere. An int ticker silently breaks the join to
    universe.yaml and, worse, drops any leading zero.
    """
    text = str(value).strip()
    if not TICKER_RE.match(text):
        raise SchemaDriftError(f"not a valid ticker: {value!r}")
    return text


def clean_text(value: Any) -> str | None:
    """Normalise whitespace; map null tokens to None.

    The NULL_TOKENS check matters: all three OpenAPI feeds write 備註 as "-" when
    there is no note. Storing that literal "-" would put a meaningless dash in
    front of the reader in the Company tab, and would make an absent note look
    different depending on which source supplied the row - the per-company page
    yields None for the same condition. "No value" must have one representation.
    """
    if value is None:
        return None
    text = str(value).strip().replace("　", " ")
    text = re.sub(r"\s+", " ", text)
    if text in NULL_TOKENS:
        return None
    return text or None


def row_hash(row: dict[str, Any]) -> str:
    """Stable hash over VALUE_COLUMNS only.

    Sorted keys and a canonical separator so the hash does not depend on dict
    insertion order. Timestamps are excluded so an unchanged re-fetch is a no-op.
    """
    payload = {k: row.get(k) for k in VALUE_COLUMNS}
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def blank_row() -> dict[str, Any]:
    """A row with every RAW_COLUMNS key present and None.

    Adapters start here so a sparse source produces explicit NULLs rather than
    missing keys, which would fail at SQL-generation time far from the cause.
    """
    return dict.fromkeys(RAW_COLUMNS)


def assert_raw_row(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-narrow a finished adapter row. Raises on drift."""
    extra = set(row) - set(RAW_COLUMNS)
    if extra:
        raise SchemaDriftError(f"unknown columns {sorted(extra)}")
    missing = set(RAW_COLUMNS) - set(row)
    if missing:
        raise SchemaDriftError(f"missing columns {sorted(missing)}")

    for key in ("source_id", "month", "ticker"):
        if not row.get(key):
            raise SchemaDriftError(f"{key} is required, got {row.get(key)!r}")
    if row["market"] not in (None, "sii", "otc"):
        raise SchemaDriftError(f"bad market {row['market']!r}")

    for key in INT_COLUMNS:
        if row[key] is not None and not isinstance(row[key], int):
            raise SchemaDriftError(f"{key} must be int, got {type(row[key]).__name__}")
    for key in FLOAT_COLUMNS:
        if row[key] is not None and not isinstance(row[key], (int, float)):
            raise SchemaDriftError(f"{key} must be numeric, got {type(row[key]).__name__}")
    return row
