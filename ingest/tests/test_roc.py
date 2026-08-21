"""ROC calendar conversion tests.

These look trivial and are not. A Gregorian year sent to MOPS returns a valid-
looking empty response rather than an error, and an unpadded month (`month=3`
instead of `month=03`) does the same. Both failures are silent, so the
conversions are pinned here before anything depends on them.
"""

from __future__ import annotations

from datetime import date

import pytest

from twrev import roc
from twrev.roc import InvalidMonth


# ------------------------------------------------------------ the conversion --

@pytest.mark.parametrize("month,expected", [
    ("2026-07", "11507"),
    ("2026-03", "11503"),
    ("2026-10", "11510"),   # two-digit month must not gain a third digit
    ("2026-01", "11501"),
    ("2026-12", "11512"),
    ("2025-12", "11412"),   # the shoulder month, and a year boundary
    ("2012-01", "10101"),   # ROC year rolls to three digits
])
def test_month_to_roc_yyyymm(month, expected):
    assert roc.month_to_roc_yyyymm(month) == expected


@pytest.mark.parametrize("value,expected", [
    ("11507", "2026-07"),
    ("11510", "2026-10"),
    ("11412", "2025-12"),
    ("10101", "2012-01"),
    (" 11507 ", "2026-07"),   # the feed's 資料年月 arrives as-is; tolerate whitespace
    (11507, "2026-07"),       # and as an int, if a feed ever stops quoting it
])
def test_roc_yyyymm_to_month(value, expected):
    assert roc.roc_yyyymm_to_month(value) == expected


def test_round_trip_over_a_decade():
    """Every month 2015-01..2030-12 must survive both directions unchanged."""
    for idx in range(roc.month_idx("2015-01"), roc.month_idx("2030-12") + 1):
        month = roc.month_from_idx(idx)
        assert roc.roc_yyyymm_to_month(roc.month_to_roc_yyyymm(month)) == month


def test_roc_parts_are_not_padded():
    """month_to_roc_parts returns an int; url_for is what pads it.

    Keeping the padding in one place (url_for) means there is exactly one
    opportunity to get `month=3` wrong, and it is unit-tested there.
    """
    assert roc.month_to_roc_parts("2026-03") == (115, 3)
    assert roc.month_to_roc_parts("2026-10") == (115, 10)


# -------------------------------------------------------------- month_idx ---

def test_month_idx_is_contiguous_across_a_year_boundary():
    """The property the whole gap-detection scheme rests on."""
    assert roc.month_idx("2026-01") - roc.month_idx("2025-12") == 1
    assert roc.month_idx("2026-03") - roc.month_idx("2026-02") == 1
    # And non-adjacent months differ by more than 1, which is how an interior
    # gap is detected in the analytics view.
    assert roc.month_idx("2026-03") - roc.month_idx("2026-01") == 2


def test_month_idx_round_trips():
    for month in ("2025-12", "2026-01", "2026-07", "2026-12"):
        assert roc.month_from_idx(roc.month_idx(month)) == month


def test_add_months_crosses_year_boundaries_both_ways():
    assert roc.add_months("2026-01", -1) == "2025-12"
    assert roc.add_months("2025-12", 1) == "2026-01"
    assert roc.add_months("2026-01", -12) == "2025-01"
    assert roc.add_months("2026-07", 0) == "2026-07"


def test_month_range_is_inclusive():
    months = roc.month_range("2025-12", "2026-07")
    assert months[0] == "2025-12" and months[-1] == "2026-07"
    # The exact backfill window: 8 months, which is 37 * 8 = 296 requests.
    assert len(months) == 8
    assert "2026-01" in months and "2026-03" in months


def test_month_range_is_empty_when_reversed():
    """The CLI turns this into a clear error rather than fetching nothing."""
    assert roc.month_range("2026-07", "2026-01") == []


# ------------------------------------------------------- the filing deadline --

def test_latest_expected_month_after_the_deadline():
    """2026-08-21: July's filings were due by the 10th, so 2026-07 is available."""
    assert roc.latest_expected_month(date(2026, 8, 21)) == "2026-07"


def test_latest_expected_month_before_the_deadline():
    """2026-08-05: July is not fully filed yet, so June is the latest complete month.

    This is why the cron derives the month from the payload's 資料年月 rather than
    from the clock - but when a human asks "what should exist by now?", this is
    the honest answer.
    """
    assert roc.latest_expected_month(date(2026, 8, 5)) == "2026-06"


def test_latest_expected_month_on_the_deadline_day_is_conservative():
    """On the 10th itself, filings are still arriving. Do not claim the month."""
    assert roc.latest_expected_month(date(2026, 8, 10)) == "2026-06"
    assert roc.latest_expected_month(date(2026, 8, 11)) == "2026-07"


def test_latest_expected_month_crosses_the_year_boundary():
    assert roc.latest_expected_month(date(2026, 1, 21)) == "2025-12"
    assert roc.latest_expected_month(date(2026, 1, 5)) == "2025-11"


# ---------------------------------------------------------------- rejection --

@pytest.mark.parametrize("bad", [
    "2026-7",      # unpadded - the exact shape that silently breaks the URL
    "202607",
    "2026/07",
    "2026-13",     # out of range
    "2026-00",
    "11507",       # an ROC value passed where a Gregorian one belongs
    "",
    "abcd-ef",
])
def test_parse_month_rejects_non_canonical(bad):
    with pytest.raises(InvalidMonth):
        roc.parse_month(bad)


@pytest.mark.parametrize("bad", ["1150", "11", "11513", "11500", "abcde", ""])
def test_roc_yyyymm_to_month_rejects_malformed(bad):
    with pytest.raises(InvalidMonth):
        roc.roc_yyyymm_to_month(bad)
