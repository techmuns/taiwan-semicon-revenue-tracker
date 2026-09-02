"""The bucket heatmap's SQL, executed - not paraphrased.

This is the one query in the repo that no other test could reach: it lives in
TypeScript, it runs inside a Worker against D1, and it is the most intricate SQL
here. It has already shipped three defects - a sign inversion from an unpaired
MoM predicate, a member count that described the wrong set, and a
"membership changed vs prior month" flag that compared counts against a month
that was not the prior one.

So the statement is EXTRACTED FROM worker/src/api.ts AND RUN, against the real
schema built from worker/migrations/*.sql. A test that retyped the SQL would
pass forever while the shipped copy drifted; this one cannot, because there is
only one copy.

If the extraction fails, that is a real signal and not a broken test: somebody
restructured the statement, and these invariants need re-checking by hand before
the regex is adjusted.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from twrev import roc, store
from twrev.config import load_universe
from twrev.schema import blank_row, row_hash

def heatmap_sql(repo_root: Path, *, exclude: tuple[tuple[str, str], ...] = ()) -> str:
    """The shipped statement, with its two interpolations resolved.

    Read from ingest/src/twrev/sql/heatmap_bucket.sql, which is THE copy - the
    Worker's is gone along with D1. It used to be scraped out of api.ts by a
    regex, and that regex was the most fragile thing in this suite: a
    restructure of the TypeScript would have silently orphaned the only
    executable test of the most defect-prone code in the repository. A file
    cannot be orphaned that way.
    """
    text = (repo_root / "ingest" / "src" / "twrev" / "sql" / "heatmap_bucket.sql").read_text(
        encoding="utf-8"
    )
    m = re.search(r"(WITH all_rows AS.*)", text, re.S)
    assert m, "heatmap_bucket.sql does not contain the statement"
    pairs = (
        ",\n     pair(parent, child) AS (VALUES "
        + ", ".join(f"('{p}', '{c}')" for p, c in exclude)
        + """),
     scoped AS (
       SELECT a.* FROM all_rows a
        WHERE NOT EXISTS (
          SELECT 1 FROM pair p
            JOIN all_rows x ON x.ticker = p.parent
                           AND x.month_idx = a.month_idx
                           AND x.revenue_month IS NOT NULL
           WHERE p.child = a.ticker)
     )"""
        if exclude
        else ",\n     scoped AS (SELECT * FROM all_rows)"
    )
    return (
        m.group(1)
        .rstrip("\n")
        .replace("${sql}", "b.month >= '2026-01'")
        .replace("${pairSql}", pairs)
        .replace("WHERE month >= ?", "WHERE month >= '2026-02'")
    )


def mk(ticker, month, rev, yoy=None, prev_month=None, source="mops_company"):
    row = blank_row()
    row.update(
        source_id=source, market="sii", month=month, month_idx=roc.month_idx(month),
        ticker=ticker, revenue_month=rev, revenue_yoy_month=yoy,
        cum_revenue=rev, cum_revenue_prior=yoy, revenue_prev_month=prev_month,
        first_seen_utc="2026-08-21T00:00:00Z", last_seen_utc="2026-08-21T00:00:00Z",
    )
    row["row_hash"] = row_hash(row)
    return row


def run(conn: sqlite3.Connection, sql: str) -> dict[tuple[str, str], dict]:
    conn.row_factory = sqlite3.Row
    return {(r["bucket"], r["month"]): dict(r) for r in conn.execute(sql)}


@pytest.fixture
def conn():
    c = store.connect()
    store.load_universe(c, load_universe())
    yield c
    c.close()


# 4919, 6138, 8081 and 6415 are the Analog Cycle names; 6286 is the fifth, which
# is `merged` and normally files nothing. 2345 is the ONLY Networking member,
# which is what lets a whole stage go dark.
ANALOG = ["4919", "6138", "8081"]


def test_statement_is_extractable(repo_root):
    assert "WITH all_rows AS" in heatmap_sql(repo_root)


def test_membership_change_is_identity_not_count(repo_root, conn):
    """A 1-for-1 swap changes the member SET without changing its size.

    The flag says "membership changed vs prior month", and an acceleration
    computed across a swap is a difference between two different sets. Comparing
    LAG(members_yoy) - a count - never noticed.
    """
    rows = []
    for t in ANALOG:
        rows += [mk(t, "2026-01", 1000, 900), mk(t, "2026-02", 1100, 900)]
    # 8081 files in January and then stops; 6286 does the reverse. Count stays 3.
    rows += [mk("8081", "2026-02", None, None), mk("6286", "2026-02", 500, 400)]
    store.upsert_rows(conn, rows)

    out = run(conn, heatmap_sql(repo_root))
    cell = out[("Analog Cycle", "2026-02")]
    assert cell["members_yoy"] == 3, "the swap must leave the COUNT unchanged"
    assert cell["members_churned"] == 2, "one left and one joined - the SET changed"


def test_membership_flag_is_null_when_the_prior_month_is_not_adjacent(repo_root, conn):
    """A stage where nobody filed produces no row at all (HAVING members > 0), so
    a LAG-based comparison silently reached back two months while the tooltip
    still said "vs prior month". Joining on month_idx - 1 makes that impossible."""
    store.upsert_rows(conn, [
        mk("2345", "2026-01", 1000, 900),
        # nothing at all for 2026-02
        mk("2345", "2026-03", 1200, 900),
    ])
    sql = heatmap_sql(repo_root).replace("WHERE month >= '2026-02'", "WHERE month >= '2026-03'")
    out = run(conn, sql)
    cell = out[("Networking", "2026-03")]
    assert cell["members_churned"] is None, "no adjacent prior month, so no comparison"
    assert cell["acceleration_weighted"] is None, "and no acceleration either"


def test_mom_has_a_separate_equal_weighted_basis(repo_root, conn):
    """AVG(mom_pct) covers a larger set than the weighted ratio, because mom_pct
    falls back to the source's own 上月營收 when there is no preceding month."""
    store.upsert_rows(conn, [
        mk("4919", "2026-01", 1000, 900), mk("4919", "2026-02", 1100, 900),
        # An OpenAPI-shaped row with 上月營收 and no January row of its own.
        mk("6138", "2026-02", 640, 500, prev_month=600, source="twse_openapi_l"),
    ])
    out = run(conn, heatmap_sql(repo_root))
    cell = out[("Analog Cycle", "2026-02")]
    assert cell["members_mom"] == 1, "only 4919 has a preceding month to divide by"
    assert cell["members_mom_equal"] == 2, "but both have a mom_pct in the average"
    assert cell["members_mom"] != cell["members_mom_equal"]


def test_paired_predicates_hold_for_a_late_filer(repo_root, conn):
    """The sign-inversion case. A member that filed last month but not this one
    must not land in a denominator whose numerator excludes it."""
    store.upsert_rows(conn, [
        mk("4919", "2026-01", 1000000, 900000), mk("4919", "2026-02", 1100000, 900000),
        mk("6138", "2026-01", 500000, 450000), mk("6138", "2026-02", None, None),
    ])
    out = run(conn, heatmap_sql(repo_root))
    cell = out[("Analog Cycle", "2026-02")]
    assert cell["mom_weighted"] == pytest.approx(10.0), (
        "10% growth for the one comparable member, not a negative number "
        f"manufactured by the absent one - got {cell['mom_weighted']}"
    )
    assert cell["members_mom"] == 1


def test_excluded_ticker_never_reaches_an_aggregate(repo_root, conn):
    """The de-duplication. Wiwynn's revenue is inside Wistron's, so it must be
    absent from the stage sum and from every members_* count."""
    store.upsert_rows(conn, [
        mk("3231", "2026-01", 300000, 200000), mk("3231", "2026-02", 310000, 200000),
        mk("6669", "2026-01", 100000, 80000), mk("6669", "2026-02", 110000, 80000),
    ])
    with_child = run(conn, heatmap_sql(repo_root))[("Rack / ODM", "2026-02")]
    without = run(conn, heatmap_sql(repo_root, exclude=(("3231", "6669"),)))[("Rack / ODM", "2026-02")]
    assert with_child["revenue"] == 420000 and with_child["members_yoy"] == 2
    assert without["revenue"] == 310000, "the child's revenue must leave the sum"
    assert without["members_yoy"] == 1, "and leave the basis reported beside it"


def test_child_is_kept_when_the_parent_has_not_filed(repo_root, conn):
    """The exclusion is conditional, and this is why.

    If Wistron has not filed and Wiwynn has - the ordinary state between the
    11th and 14th refresh passes - then no row on the page contains Wiwynn's
    revenue. Dropping it would remove a real filing rather than a duplicate one,
    understating the stage by exactly the child's own revenue while `members_*`
    described the smaller set as though the omission were a de-duplication.
    """
    store.upsert_rows(conn, [
        # January is the shoulder month the statement drops after using it as
        # the LAG, so both visible cases live in February and March.
        mk("3231", "2026-01", 290000, 200000),
        mk("6669", "2026-01", 95000, 80000),
        mk("3231", "2026-02", 300000, 200000),
        mk("6669", "2026-02", 100000, 80000),
        # March: the child filed, the parent has not yet.
        mk("3231", "2026-03", None, None),
        mk("6669", "2026-03", 110000, 80000),
    ])
    out = run(conn, heatmap_sql(repo_root, exclude=(("3231", "6669"),)))

    feb = out[("Rack / ODM", "2026-02")]
    assert feb["revenue"] == 300000, "both filed, so the child is inside the parent"
    assert feb["members_yoy"] == 1

    mar = out[("Rack / ODM", "2026-03")]
    assert mar["revenue"] == 110000, (
        "the parent did not file, so the child's revenue is the only figure there "
        f"is - got {mar['revenue']}"
    )
    assert mar["members_yoy"] == 1, "and it is counted in the basis"

