"""ROC (Minguo) calendar conversion and month arithmetic.

Taiwan filings use the ROC calendar: ROC year = Gregorian year - 1911.
Passing a Gregorian year to MOPS silently returns nothing useful, so every
conversion goes through here and is unit-tested.

Canonical month representation throughout the project is the string "YYYY-MM".
`month_idx` (year*12 + month) is carried alongside it so contiguity checks are
integer comparisons rather than string parsing.
"""

from __future__ import annotations

import re
from datetime import date

ROC_OFFSET = 1911
MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")
ROC_YYYYMM_RE = re.compile(r"^(\d{3,4})(\d{2})$")


class InvalidMonth(ValueError):
    """Raised when a month string is not canonical 'YYYY-MM'."""


def parse_month(month: str) -> tuple[int, int]:
    """'2026-07' -> (2026, 7). Raises InvalidMonth on anything else."""
    m = MONTH_RE.match(month)
    if not m:
        raise InvalidMonth(f"expected 'YYYY-MM', got {month!r}")
    year, mm = int(m.group(1)), int(m.group(2))
    if not 1 <= mm <= 12:
        raise InvalidMonth(f"month out of range in {month!r}")
    return year, mm


def to_roc_year(year: int) -> int:
    """2026 -> 115."""
    return year - ROC_OFFSET


def from_roc_year(roc_year: int) -> int:
    """115 -> 2026."""
    return roc_year + ROC_OFFSET


def month_to_roc_parts(month: str) -> tuple[int, int]:
    """'2026-07' -> (115, 7). Note the month is NOT zero-padded here."""
    year, mm = parse_month(month)
    return to_roc_year(year), mm


def month_to_roc_yyyymm(month: str) -> str:
    """'2026-07' -> '11507'. Month IS zero-padded in this form."""
    roc_year, mm = month_to_roc_parts(month)
    return f"{roc_year}{mm:02d}"


def roc_yyyymm_to_month(value: str) -> str:
    """'11507' -> '2026-07'. Accepts the OpenAPI 資料年月 field verbatim."""
    m = ROC_YYYYMM_RE.match(str(value).strip())
    if not m:
        raise InvalidMonth(f"expected ROC yyyymm, got {value!r}")
    roc_year, mm = int(m.group(1)), int(m.group(2))
    if not 1 <= mm <= 12:
        raise InvalidMonth(f"month out of range in {value!r}")
    return f"{from_roc_year(roc_year)}-{mm:02d}"


def month_idx(month: str) -> int:
    """'2026-07' -> 24319. Monotonic integer for contiguity checks."""
    year, mm = parse_month(month)
    return year * 12 + (mm - 1)


def month_from_idx(idx: int) -> str:
    year, mm = divmod(idx, 12)
    return f"{year:04d}-{mm + 1:02d}"


def add_months(month: str, delta: int) -> str:
    """'2026-01' + -1 -> '2025-12'."""
    return month_from_idx(month_idx(month) + delta)


def month_range(start: str, end: str) -> list[str]:
    """Inclusive list of months from start to end. Empty if end < start."""
    a, b = month_idx(start), month_idx(end)
    return [month_from_idx(i) for i in range(a, b + 1)]


def latest_expected_month(today: date | None = None, filing_day: int = 10) -> str:
    """Most recent month whose revenue should already be published.

    Taiwan requires monthly revenue disclosure by the 10th of the following
    month. On 2026-08-21 that means 2026-07 is available; on 2026-08-05 it
    means 2026-06, because July's filings are not all in yet.
    """
    today = today or date.today()
    idx = month_idx(f"{today.year:04d}-{today.month:02d}")
    # Current month is never available; step back one, and one more before the deadline.
    idx -= 1 if today.day > filing_day else 2
    return month_from_idx(idx)
