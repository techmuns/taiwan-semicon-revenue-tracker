"""The heatmap, published to a file instead of queried from a database.

This is the endpoint that was supposed to be impossible to export. It
aggregates 37 companies into 10 stage rows over whatever filters are live, and
ticker selection is an arbitrary subset of 37, so its answers "cannot be
enumerated". Two measurements collapse that claim, and both are asserted here
rather than believed:

  1. `from`, `to` and `buckets` DO NOT CHANGE A CELL'S VALUE. per_bucket groups
     by (bucket, month_idx) and the window always reaches one month behind
     `from`, so those parameters choose which cells come back, never what is in
     them. If that ever stops being true, the published file is wrong for every
     window except the one it was built with - hence
     test_window_and_bucket_filters_do_not_change_a_cell.

  2. There is no ticker control in the UI (web/src/urlState.ts:71 is the only
     way `tickers` enters the filter state), so the reachable space is the four
     tier subsets.

The export therefore runs THE statement - the same characters that ran on D1,
from ingest/src/twrev/sql/heatmap_bucket.sql - four times at publish time. The
tests below diff its output against that statement executed directly.
"""

from __future__ import annotations

import pytest

from twrev import export, store
from twrev.config import load_universe
from test_heatmap_sql import heatmap_sql, mk, run

WISTRON_WIWYNN = [("3231", "6669")]

SPREAD = [("2330", 400000), ("3443", 5000), ("3661", 7000), ("3711", 90000),
          ("2449", 20000), ("3017", 30000), ("3324", 12000), ("2382", 300000),
          ("3231", 280000), ("6669", 110000), ("2345", 40000), ("6138", 8000)]


@pytest.fixture
def conn():
    c = store.connect()
    store.load_universe(c, load_universe())
    yield c
    c.close()


def seed(c, pairs, months=("2025-12", "2026-01", "2026-02", "2026-03")):
    rows = []
    for ticker, rev in pairs:
        for i, m in enumerate(months):
            rows.append(mk(ticker, m, rev + i * 1000, rev - 2000))
    store.upsert_rows(c, rows)
    c.commit()


def test_export_matches_the_statement_it_publishes(repo_root, conn):
    """The published cells must equal the SQL's own answers, field for field."""
    seed(conn, SPREAD)
    out = export.build_heatmap(conn, WISTRON_WIWYNN, from_month="2026-01")
    cells = {(c["bucket"], c["month"]): c
             for c in out["tier_subsets"][""]["yoy_acceleration_ppt|weighted"]["cells"]}
    truth = run(conn, heatmap_sql(repo_root, exclude=(("3231", "6669"),)))
    assert truth, "the ground-truth run produced nothing - the fixture is wrong"
    for key, t in truth.items():
        c = cells.get(key)
        assert c is not None, f"{key} missing from the published file"
        assert c["value"] == t["acceleration_weighted"]
        assert c["members"] == t["members_yoy"]
        assert c["members_with_revenue"] == t["members"]
        assert c["revenue"] == t["revenue"]


def test_window_and_bucket_filters_do_not_change_a_cell(repo_root, conn):
    """The measurement the whole export rests on.

    If a narrower `to`, a wider `from` or a bucket filter ever changes a cell's
    VALUE rather than merely selecting which cells appear, four tier subsets no
    longer cover the reachable space and the published file is silently wrong
    for every window it was not built with.
    """
    seed(conn, SPREAD, months=("2025-12", "2026-01", "2026-02", "2026-03", "2026-04"))

    def variant(where, lag):
        sql = heatmap_sql(repo_root).replace("b.month >= '2026-01'", where)
        return run(conn, sql.replace("WHERE month >= '2026-02'", f"WHERE month >= '{lag}'"))

    base = variant("b.month >= '2026-01'", "2026-02")
    cols = ("revenue", "yoy_weighted", "mom_weighted", "members_yoy",
            "members_mom", "acceleration_weighted", "cum_yoy_weighted")
    for name, other in [
        ("narrower to", variant("b.month >= '2026-01' AND b.month <= '2026-03'", "2026-02")),
        ("wider from", variant("b.month >= '2025-12'", "2026-01")),
        ("single bucket", variant("b.month >= '2026-01' AND b.bucket = 'AI Silicon'", "2026-02")),
    ]:
        shared = set(base) & set(other)
        assert shared, f"{name}: no overlapping cells to compare"
        for k in shared:
            for col in cols:
                assert base[k][col] == other[k][col], (
                    f"{name} changed {k} {col}: {base[k][col]!r} -> {other[k][col]!r}. "
                    "The published heatmap can no longer be enumerated by tier alone."
                )


def test_the_conditional_de_duplication_survives_the_export(conn):
    """Wiwynn's revenue is inside Wistron's, so it must leave the stage sum -
    and leave the basis reported beside it, or the page shows a total over one
    set described by a count over another."""
    seed(conn, [("2382", 300000), ("3231", 280000), ("6669", 110000)],
         months=("2025-12", "2026-01", "2026-02"))

    def rack(consolidation):
        out = export.build_heatmap(conn, consolidation, from_month="2026-01")
        return next(c for c in out["tier_subsets"][""]["yoy_pct|weighted"]["cells"]
                    if c["bucket"] == "Rack / ODM" and c["month"] == "2026-02")

    without, deduped = rack([]), rack(WISTRON_WIWYNN)
    assert deduped["revenue"] == without["revenue"] - 112_000, (
        "the child's own revenue must leave the sum, exactly"
    )
    assert deduped["members_with_revenue"] == without["members_with_revenue"] - 1


def test_cumulative_yoy_has_no_equal_weighted_form(conn):
    """The defect that labelled 70 of 70 cells "equal-weighted, one company one
    vote" over a revenue-weighted number. The file reports what it computed."""
    seed(conn, SPREAD)
    out = export.build_heatmap(conn, WISTRON_WIWYNN, from_month="2026-01")
    combo = out["tier_subsets"][""]["cumulative_yoy_pct|equal"]
    assert combo["agg"] == "weighted", "there is no equal-weighted cumulative YoY"
    assert combo["agg_requested"] == "equal", "and the request must still be reported"
    weighted = out["tier_subsets"][""]["cumulative_yoy_pct|weighted"]
    assert [c["value"] for c in combo["cells"]] == [c["value"] for c in weighted["cells"]]


def test_every_tier_subset_a_reader_can_reach_is_published(conn):
    seed(conn, SPREAD)
    out = export.build_heatmap(conn, WISTRON_WIWYNN, from_month="2026-01")
    assert set(out["tier_subsets"]) == {"", "1", "2", "1,2"}
    for key, combos in out["tier_subsets"].items():
        assert set(combos) == {f"{m}|{a}" for m in export.METRICS for a in export.AGGS}, (
            f"tier subset {key!r} is missing a metric x aggregation combination"
        )


def test_a_ticker_filter_is_reported_not_silently_answered(conn):
    """A hand-written ?tickers= link changes a stage aggregate and cannot be
    enumerated. Answering it with the unfiltered value would be a wrong number
    presented as a filtered one."""
    seed(conn, SPREAD)
    out = export.build_heatmap(conn, WISTRON_WIWYNN, from_month="2026-01")
    assert out["ticker_filter_unsupported"]
