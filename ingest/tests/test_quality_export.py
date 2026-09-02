"""Coverage, exported. The number that trains a reader to trust or ignore the page.

`_obligated` decides whether an absent cell was a FAILURE or was simply never
owed. Wrong in the generous direction and coverage reads 100% while filings are
missing; wrong in the strict direction and it reads 97.3% forever because of one
merged company, at which point nobody looks at it again.

The rule is the WINDOW, not the label: a month inside [active_from, active_to]
was owed a filing whatever the company's status is today - status is a fact
about now, coverage is a time series.
"""

from __future__ import annotations

import pytest

from twrev import export, store
from twrev.config import load_universe
from test_heatmap_sql import mk

MONTHS = ("2026-01", "2026-02", "2026-03")


@pytest.fixture
def conn():
    c = store.connect()
    store.load_universe(c, load_universe())
    yield c
    c.close()


def test_a_merged_company_is_not_counted_against_coverage(conn):
    """6286 merged into MediaTek and files nothing. Counting its absences would
    peg coverage below 100% permanently, for no defect at all."""
    rows = [mk(c.ticker, m, 10_000, 9_000)
            for c in load_universe().companies if c.ticker != "6286"
            for m in MONTHS]
    store.upsert_rows(conn, rows)
    conn.commit()

    cov = export.build_quality(conn)["coverage"]
    assert cov["trackable_pct"] == 100.0, (
        "every company that owed a filing filed one - coverage must say so"
    )
    assert cov["cells"] > cov["trackable_cells"], "6286's cells are not trackable"
    absent = {a["ticker"] for a in cov["known_absent"]}
    assert absent == {"6286"}, f"only the merged name should be excused, got {absent}"
    assert all(a["status"] == "merged" for a in cov["known_absent"])


def test_a_real_missing_filing_still_counts_against_coverage(conn):
    """The failure the excuse list must never swallow."""
    rows = [mk(c.ticker, m, 10_000, 9_000)
            for c in load_universe().companies if c.ticker != "6286"
            for m in MONTHS
            # TSMC does not file in February. A defect, not an exemption.
            if not (c.ticker == "2330" and m == "2026-02")]
    store.upsert_rows(conn, rows)
    conn.commit()

    q = export.build_quality(conn)
    assert q["coverage"]["trackable_pct"] < 100.0, (
        "an active company's missing month must reduce coverage"
    )
    assert not any(a["ticker"] == "2330" for a in q["coverage"]["known_absent"]), (
        "an active company's absence is never 'known absent'"
    )


def test_obligated_is_decided_by_the_window_not_the_label():
    """A delisted name owed filings up to active_to and none after it."""
    def cell(month):
        return {"month": month, "status": "delisted",
                "active_from": "2026-01", "active_to": "2026-02"}
    assert export._obligated(cell("2026-01")) is True
    assert export._obligated(cell("2026-02")) is True
    assert export._obligated(cell("2026-03")) is False, "after active_to nothing is owed"
    assert export._obligated(cell("2025-12")) is False, "before active_from nothing is owed"


def test_a_non_active_company_with_no_window_owes_nothing():
    """It cannot be placed in time, so it is treated exactly as `merged` was -
    the alternative is charging it for months it may never have existed in."""
    assert export._obligated(
        {"month": "2026-01", "status": "merged", "active_from": None, "active_to": None}
    ) is False


def test_interior_gaps_find_an_outage_longer_than_one_month(conn):
    """The LAG/LEAD form only ever found holes exactly one month wide: two
    consecutive missing months disqualified each other, so the worse failure
    reported clean."""
    months = ("2026-01", "2026-02", "2026-03", "2026-04")
    rows = [mk(c.ticker, m, 10_000, 9_000)
            for c in load_universe().companies if c.ticker != "6286"
            for m in months
            # A TWO-month outage in the middle of Accton's series.
            if not (c.ticker == "2345" and m in ("2026-02", "2026-03"))]
    store.upsert_rows(conn, rows)
    conn.commit()

    gaps = {(g["ticker"], g["month"]) for g in export.build_quality(conn)["interior_gaps"]}
    assert ("2345", "2026-02") in gaps and ("2345", "2026-03") in gaps, (
        f"both months of the outage must be reported, got {sorted(gaps)}"
    )
