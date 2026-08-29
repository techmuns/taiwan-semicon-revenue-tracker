"""Tests for the analytics_monthly view, run against the real D1 migration.

Every case here is one the live data will not exercise for months or years - zero
denominators, interior gaps, a company that files nothing for a single month. They
are exactly the cases where a metric silently produces a plausible wrong number
instead of NULL, so they are tested on synthetic rows where the answer is known
by construction.
"""

from __future__ import annotations

import pytest

from twrev import roc, store
from twrev.config import load_universe
from twrev.schema import blank_row, row_hash


def mk(ticker, month, rev, yoy=None, cum=None, cum_prior=None,
       prev_month=None, source="mops_company"):
    row = blank_row()
    row.update(
        source_id=source, market="sii", month=month, month_idx=roc.month_idx(month),
        ticker=ticker, revenue_month=rev, revenue_yoy_month=yoy,
        cum_revenue=cum, cum_revenue_prior=cum_prior, revenue_prev_month=prev_month,
        first_seen_utc="2026-08-21T00:00:00Z", last_seen_utc="2026-08-21T00:00:00Z",
    )
    row["row_hash"] = row_hash(row)
    return row


@pytest.fixture
def conn():
    universe = load_universe()
    c = store.connect()
    store.load_universe(c, universe)
    store.upsert_rows(c, [
        # Clean contiguous series; YoY accelerates 10 -> 20 -> 25.
        mk("2330", "2026-01", 1100, 1000, 1100, 1000),
        mk("2330", "2026-02", 1200, 1000, 2300, 2000),
        mk("2330", "2026-03", 1250, 1000, 3550, 3000),
        # Interior gap: Jan then Mar, no Feb.
        mk("3443", "2026-01", 500, 400, 500, 400),
        mk("3443", "2026-03", 700, 400, 1200, 800),
        # Zero and negative prior-year bases.
        mk("3661", "2026-01", 300, 0, 300, 0),
        mk("3661", "2026-02", 300, -50, 600, -50),
        # Filed nothing in Feb, returns in Mar.
        mk("3711", "2026-01", 900, 800, 900, 800),
        mk("3711", "2026-02", None, None, None, None),
        mk("3711", "2026-03", 950, 800, 1850, 1600),
        # Only an OpenAPI row, which carries 上月營收, and no preceding month.
        mk("2449", "2026-02", 640, 500, 1200, 900,
           prev_month=600, source="twse_openapi_l"),
    ])
    yield c
    c.close()


def cell(conn, ticker, month, column):
    row = conn.execute(
        f"SELECT {column} AS v FROM analytics_monthly WHERE ticker = ? AND month = ?",
        (ticker, month),
    ).fetchone()
    assert row is not None, f"no view row for {ticker} {month}"
    return row["v"]


def test_column_contract(conn):
    """The 12 columns, in the brief's order. The CSV export depends on this."""
    store.assert_view_contract(conn)


def test_clean_series_metrics(conn):
    assert cell(conn, "2330", "2026-02", "mom_pct") == pytest.approx(9.09)
    assert cell(conn, "2330", "2026-02", "yoy_pct") == pytest.approx(20.0)
    assert cell(conn, "2330", "2026-02", "prior_month_yoy_pct") == pytest.approx(10.0)
    assert cell(conn, "2330", "2026-02", "yoy_acceleration_ppt") == pytest.approx(10.0)
    assert cell(conn, "2330", "2026-03", "yoy_acceleration_ppt") == pytest.approx(5.0)
    assert cell(conn, "2330", "2026-03", "cumulative_yoy_pct") == pytest.approx(18.33)


def test_acceleration_is_exactly_the_difference_of_displayed_columns(conn):
    """A reader subtracting the two YoY columns must get the acceleration column."""
    rows = conn.execute(
        "SELECT yoy_pct, prior_month_yoy_pct, yoy_acceleration_ppt "
        "FROM analytics_monthly WHERE yoy_acceleration_ppt IS NOT NULL"
    ).fetchall()
    assert rows, "no acceleration rows to check"
    for r in rows:
        assert r["yoy_acceleration_ppt"] == pytest.approx(
            round(r["yoy_pct"] - r["prior_month_yoy_pct"], 2)
        )


def test_first_month_has_no_prior(conn):
    assert cell(conn, "2330", "2026-01", "prior_month_yoy_pct") is None
    assert cell(conn, "2330", "2026-01", "yoy_acceleration_ppt") is None
    assert cell(conn, "2330", "2026-01", "mom_pct") is None


def test_interior_gap_nulls_month_over_month_metrics(conn):
    """Across a hole, MoM would otherwise be a two-month change mislabelled."""
    assert cell(conn, "3443", "2026-03", "mom_pct") is None
    assert cell(conn, "3443", "2026-03", "prior_month_yoy_pct") is None
    assert cell(conn, "3443", "2026-03", "yoy_acceleration_ppt") is None
    # YoY is unaffected - it needs only the row's own prior-year base.
    assert cell(conn, "3443", "2026-03", "yoy_pct") == pytest.approx(75.0)


def test_nonpositive_denominators_yield_null_not_infinity(conn):
    assert cell(conn, "3661", "2026-01", "yoy_pct") is None
    assert cell(conn, "3661", "2026-01", "cumulative_yoy_pct") is None
    assert cell(conn, "3661", "2026-02", "yoy_pct") is None
    assert cell(conn, "3661", "2026-02", "cumulative_yoy_pct") is None


def test_missing_month_is_null_not_zero(conn):
    assert cell(conn, "3711", "2026-02", "revenue_twd_thousands") is None
    assert cell(conn, "3711", "2026-02", "mom_pct") is None
    # March's own preceding row exists in the spine but has NULL revenue.
    assert cell(conn, "3711", "2026-03", "mom_pct") is None


def test_openapi_prev_month_fallback(conn):
    """When a feed supplies 上月營收 and we have no preceding row, use it."""
    assert cell(conn, "2449", "2026-02", "mom_pct") == pytest.approx(6.67)


def test_mom_has_two_member_sets_and_they_can_differ(conn):
    """The asymmetry the bucket heatmap's `members_mom_equal` exists to report.

    `mom_pct` is non-null on either of two branches: our own preceding month, or
    the source's 上月營收 when there is no preceding month. The REVENUE-WEIGHTED
    MoM can only use the first, because the second supplies no denominator to
    sum. So the equal-weighted mean covers a strictly larger set than the
    weighted ratio, and the member count shown beside each figure has to be the
    one that describes IT.

    2449 is the case: an OpenAPI row with 上月營收 and no preceding month. It has
    a mom_pct, so it is in the average - and it is absent from the weighted set.
    Reporting one count for both said "3 companies" over a mean of four on the
    live store, which is the normal state between the 11th and 14th refresh runs.
    """
    weighted, equal = conn.execute(
        """SELECT
             SUM(CASE WHEN revenue_month IS NOT NULL
                       AND prev_month_idx = month_idx - 1 AND prev_revenue > 0
                      THEN 1 ELSE 0 END) AS members_mom,
             COUNT(mom_pct)              AS members_mom_equal
           FROM analytics_base
          WHERE bucket = 'Advanced Packaging / Test' AND month = '2026-02'"""
    ).fetchone()
    assert equal == 1, "2449's fallback MoM must be in the equal-weighted average"
    assert weighted == 0, "and absent from the revenue-weighted ratio"
    assert weighted != equal, "the two bases are genuinely different sets"


def test_universe_x_months_grid(conn):
    """Gaps are rows with NULLs, not absences - the agreed 6286 treatment."""
    universe = load_universe()
    months = conn.execute("SELECT count(*) AS c FROM month_spine").fetchone()["c"]
    rows = conn.execute("SELECT count(*) AS c FROM analytics_monthly").fetchone()["c"]
    assert rows == months * len(universe)


def test_richtek_present_with_no_data(conn):
    """6286 must appear with explicit NULLs rather than disappearing."""
    rows = conn.execute(
        "SELECT * FROM analytics_monthly WHERE ticker = '6286'"
    ).fetchall()
    assert rows, "6286 vanished from the view"
    assert all(r["revenue_twd_thousands"] is None for r in rows)
    assert all(r["bucket"] == "Analog Cycle" for r in rows)
    assert all(r["tier"] == 1 for r in rows)


def test_source_precedence_deduplicates(conn):
    """The same filing on two surfaces must yield ONE row, from mops_company."""
    store.upsert_rows(conn, [
        mk("2330", "2026-03", 9999, 1000, 3550, 3000, source="twse_openapi_l"),
    ])
    rows = conn.execute(
        "SELECT * FROM analytics_monthly WHERE ticker = '2330' AND month = '2026-03'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["revenue_twd_thousands"] == 1250, "precedence did not prefer mops_company"


def test_restatement_writes_history_and_unchanged_refetch_does_not(conn):
    before = conn.execute("SELECT count(*) AS c FROM raw_revenue_history").fetchone()["c"]

    # Re-upsert an identical row: touches last_seen_utc, must write no history.
    same = mk("2330", "2026-01", 1100, 1000, 1100, 1000)
    same["last_seen_utc"] = "2026-09-01T00:00:00Z"
    store.upsert_rows(conn, [same])
    mid = conn.execute("SELECT count(*) AS c FROM raw_revenue_history").fetchone()["c"]
    assert mid == before, "an unchanged re-fetch created history noise"
    assert conn.execute(
        "SELECT first_seen_utc AS v FROM raw_revenue WHERE ticker='2330' AND month='2026-01'"
    ).fetchone()["v"] == "2026-08-21T00:00:00Z", "first_seen_utc was overwritten"

    # Now a genuine restatement.
    restated = mk("2330", "2026-01", 1150, 1000, 1150, 1000)
    restated["last_seen_utc"] = "2026-09-02T00:00:00Z"
    store.upsert_rows(conn, [restated])
    after = conn.execute("SELECT count(*) AS c FROM raw_revenue_history").fetchone()["c"]
    assert after == before + 1, "restatement was not recorded"
    hist = conn.execute(
        "SELECT * FROM raw_revenue_history ORDER BY history_id DESC LIMIT 1"
    ).fetchone()
    assert '"revenue_month":1100' in hist["payload_json"].replace(" ", "")
    assert cell(conn, "2330", "2026-01", "revenue_twd_thousands") == 1150


def test_seed_is_idempotent(conn):
    """Re-running the same rows must not change the row count."""
    rows = [mk("2330", "2026-01", 1100, 1000, 1100, 1000)]
    n_before = conn.execute("SELECT count(*) AS c FROM raw_revenue").fetchone()["c"]
    store.upsert_rows(conn, rows)
    store.upsert_rows(conn, rows)
    n_after = conn.execute("SELECT count(*) AS c FROM raw_revenue").fetchone()["c"]
    assert n_before == n_after
