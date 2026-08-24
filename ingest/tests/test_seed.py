"""Tests for the generated D1 seed file.

The seed is the one artifact applied to remote D1 by hand, so it gets the
strictest test in the suite: the generated SQL is *executed* against a database
built from the real migration, and the resulting analytics_monthly output is
compared against the parameterised write path row for row. That is what licenses
`upsert_batch_literal_sql` to use a different statement shape from
`store.upsert_rows` - the shapes differ, the results provably do not.
"""

from __future__ import annotations

import sqlite3

import pytest

from twrev import roc, seed, store
from twrev.backfill import Report
from twrev.config import load_universe
from twrev.schema import blank_row, row_hash

GOLDEN = {
    "revenue_month": 415191699,
    "revenue_yoy_month": 285956830,
    "cum_revenue": 1134103440,
    "cum_revenue_prior": 839253664,
}


def mk(ticker, month, rev, **over):
    row = blank_row()
    row.update(
        source_id="mops_company", market="sii", month=month,
        month_idx=roc.month_idx(month), ticker=ticker,
        roc_yyyymm=roc.month_to_roc_yyyymm(month),
        company_name="台積電", revenue_month=rev,
        revenue_yoy_month=over.pop("yoy", None),
        cum_revenue=over.pop("cum", None),
        cum_revenue_prior=over.pop("cum_prior", None),
        src_yoy_pct=over.pop("src_yoy_pct", None),
        note=over.pop("note", None),
        first_seen_utc="2026-08-21T00:00:00Z", last_seen_utc="2026-08-21T00:00:00Z",
    )
    row.update(over)
    row["row_hash"] = row_hash(row)
    return row


@pytest.fixture
def report():
    rows = [
        mk("2330", "2026-03", GOLDEN["revenue_month"],
           yoy=GOLDEN["revenue_yoy_month"], cum=GOLDEN["cum_revenue"],
           cum_prior=GOLDEN["cum_revenue_prior"], src_yoy_pct=45.19),
        mk("2330", "2026-04", 400000000, yoy=300000000,
           cum=1534103440, cum_prior=1139253664, src_yoy_pct=33.33),
        # A note containing an apostrophe and Chinese text - the literal
        # escaping path is where a seed file most plausibly breaks.
        mk("3324", "2026-03", 1234567, yoy=1000000, cum=3500000,
           cum_prior=2900000, note="成長動能來自AI 伺服器液冷散熱 O'Brien 測試"),
    ]
    rep = Report(run_id="test-run-1")
    rep.rows = rows
    rep.fetch_log = [
        {"source_id": "mops_company", "month": r["month"], "ticker": r["ticker"],
         "url": f"https://example.invalid/{r['ticker']}", "http_status": 200,
         "byte_len": 12345, "sha256": "deadbeef", "rows_parsed": 1, "ok": 1,
         "error": None, "fetched_at_utc": "2026-08-21T00:00:00Z"}
        for r in rows
    ]
    rep.findings = [
        {"run_id": "test-run-1", "created_at_utc": "2026-08-21T00:00:00Z",
         "severity": "info", "code": "NOT_AN_ISSUER", "month": "2026-03",
         "ticker": "6286", "source_id": "mops_company",
         "message": "該 6286 公開發行公司不繼續公開發行"},
    ]
    rep.counts = {"rows": 3}
    return rep


def apply_sql(sql: str) -> sqlite3.Connection:
    conn = store.connect()
    conn.executescript(sql)
    conn.commit()
    return conn


def view_dump(conn: sqlite3.Connection) -> list[tuple]:
    return [tuple(r) for r in conn.execute("SELECT * FROM analytics_monthly")]


def test_no_explicit_transaction(report):
    """D1 rejects BEGIN/COMMIT; emitting one would fail the entire apply."""
    sql = seed.build(universe=load_universe(), report=report).upper()
    assert "BEGIN TRANSACTION" not in sql
    assert "\nBEGIN" not in sql
    assert "\nCOMMIT" not in sql


def test_generated_seed_matches_parameterised_path(report):
    """The whole justification for the batched statement shape."""
    universe = load_universe()

    from_file = apply_sql(seed.build(universe=universe, report=report))

    direct = store.connect()
    store.load_universe(direct, universe)
    store.upsert_rows(direct, report.rows)

    assert view_dump(from_file) == view_dump(direct)
    assert store.assert_view_contract(from_file) is None


def test_seed_reproduces_golden_row(report):
    conn = apply_sql(seed.build(universe=load_universe(), report=report))
    row = conn.execute(
        "SELECT * FROM raw_revenue WHERE ticker='2330' AND month='2026-03'"
    ).fetchone()
    for field, want in GOLDEN.items():
        assert row[field] == want, field
    # The precision bug pandas.read_html would have introduced.
    assert row["revenue_month"] != 415191700

    view = conn.execute(
        "SELECT * FROM analytics_monthly WHERE ticker='2330' AND month='2026-03'"
    ).fetchone()
    assert view["revenue_twd_thousands"] == 415191699
    assert view["yoy_pct"] == pytest.approx(45.19)
    assert view["cumulative_yoy_pct"] == pytest.approx(35.13)
    assert view["company_name"] == "TSMC"  # English display_name, not 台積電


def test_recomputed_matches_source_reported_pct(report):
    """Our recomputation must agree with MOPS' own figure to within 0.05pp."""
    conn = apply_sql(seed.build(universe=load_universe(), report=report))
    rows = conn.execute(
        "SELECT a.yoy_pct, r.src_yoy_pct FROM analytics_monthly a "
        "JOIN raw_revenue r ON r.ticker = a.ticker AND r.month = a.month "
        "WHERE r.src_yoy_pct IS NOT NULL"
    ).fetchall()
    assert rows
    for r in rows:
        assert abs(r["yoy_pct"] - r["src_yoy_pct"]) <= 0.05


def test_reapplying_seed_is_idempotent(report):
    """Row counts unchanged, and no restatement history from a second apply."""
    sql = seed.build(universe=load_universe(), report=report)
    conn = apply_sql(sql)
    before = {
        t: conn.execute(f"SELECT count(*) AS c FROM {t}").fetchone()["c"]
        for t in ("universe", "raw_revenue", "fetch_log", "quality_findings")
    }
    dump_before = view_dump(conn)

    conn.executescript(sql)
    conn.commit()

    after = {
        t: conn.execute(f"SELECT count(*) AS c FROM {t}").fetchone()["c"]
        for t in ("universe", "raw_revenue", "fetch_log", "quality_findings")
    }
    assert after == before, f"not idempotent: {before} -> {after}"
    assert view_dump(conn) == dump_before
    assert conn.execute(
        "SELECT count(*) AS c FROM raw_revenue_history"
    ).fetchone()["c"] == 0, "an unchanged re-apply wrote restatement history"


def test_regenerated_seed_does_not_duplicate_findings(report):
    """The repair path REGENERATES the seed, so the run_id differs each time.

    The findings DELETE used to be scoped to the seed's own run_id, which is
    minted fresh per run - so it matched nothing and every regenerate-and-apply
    appended a second full copy of the finding set. Worse than the duplication:
    a problem FIXED by the newer backfill kept its original finding sitting in
    the Quality tab, because nothing ever deleted it.
    """
    conn = apply_sql(seed.build(universe=load_universe(), report=report))
    first = conn.execute("SELECT count(*) AS c FROM quality_findings").fetchone()["c"]
    assert first, "fixture should produce at least one finding"

    # Same window, same content, a new run - exactly what `backfill` then `seed`
    # produces on the documented repair path.
    report.run_id = "test-run-regenerated"
    for f in report.findings:
        f["run_id"] = "test-run-regenerated"
    conn.executescript(seed.build(universe=load_universe(), report=report))
    conn.commit()

    after = conn.execute("SELECT count(*) AS c FROM quality_findings").fetchone()["c"]
    assert after == first, f"regenerated seed duplicated findings: {first} -> {after}"


def test_seed_does_not_delete_the_crons_findings(report):
    """The two writers must not clear each other's verdicts.

    The cron scopes its own DELETE to run_id LIKE 'cron-%'; the seed scopes to
    the months it speaks for and excludes exactly that prefix. A seed that wiped
    the cron's findings would silently blank the Quality tab for the newest
    month, which is the month anyone is actually reading.
    """
    conn = apply_sql(seed.build(universe=load_universe(), report=report))
    conn.execute(
        "INSERT INTO quality_findings "
        "(run_id, created_at_utc, severity, code, month, ticker, source_id, message) "
        "VALUES ('cron-2026-08-11T01:00:00Z', '2026-08-11T01:00:00Z', 'warn', "
        "'MOM_OUTLIER', '2026-03', '3661', 'twse_openapi_l', 'MoM 108%')"
    )
    conn.commit()

    conn.executescript(seed.build(universe=load_universe(), report=report))
    conn.commit()

    survived = conn.execute(
        "SELECT count(*) AS c FROM quality_findings WHERE run_id LIKE 'cron-%'"
    ).fetchone()["c"]
    assert survived == 1, "the seed deleted a finding the cron owns"


def test_reseed_preserves_first_seen_and_records_restatement(report):
    universe = load_universe()
    conn = apply_sql(seed.build(universe=universe, report=report))

    restated = mk("2330", "2026-03", 415191700,  # a genuine correction
                  yoy=GOLDEN["revenue_yoy_month"], cum=GOLDEN["cum_revenue"],
                  cum_prior=GOLDEN["cum_revenue_prior"], src_yoy_pct=45.19)
    restated["first_seen_utc"] = "2026-09-01T00:00:00Z"
    restated["last_seen_utc"] = "2026-09-01T00:00:00Z"
    rep2 = Report(run_id="test-run-2")
    rep2.rows = [restated]
    conn.executescript(seed.build(universe=universe, report=rep2))
    conn.commit()

    row = conn.execute(
        "SELECT * FROM raw_revenue WHERE ticker='2330' AND month='2026-03'"
    ).fetchone()
    assert row["revenue_month"] == 415191700
    assert row["first_seen_utc"] == "2026-08-21T00:00:00Z", "first_seen_utc lost"
    assert row["last_seen_utc"] == "2026-09-01T00:00:00Z"
    hist = conn.execute("SELECT * FROM raw_revenue_history").fetchall()
    assert len(hist) == 1
    assert '"revenue_month":415191699' in hist[0]["payload_json"].replace(" ", "")


def test_universe_edit_propagates(report):
    """A YAML edit must not leave a stale bucket behind - hence DELETE + INSERT."""
    universe = load_universe()
    conn = apply_sql(seed.build(universe=universe, report=report))
    conn.execute("UPDATE universe SET bucket = 'WRONG' WHERE ticker = '2330'")
    conn.commit()
    conn.executescript(seed.build(universe=universe, report=report))
    conn.commit()
    assert conn.execute(
        "SELECT bucket AS b FROM universe WHERE ticker='2330'"
    ).fetchone()["b"] != "WRONG"


def test_quotes_and_chinese_survive_literal_escaping(report):
    conn = apply_sql(seed.build(universe=load_universe(), report=report))
    note = conn.execute(
        "SELECT note AS n FROM raw_revenue WHERE ticker='3324' AND month='2026-03'"
    ).fetchone()["n"]
    assert note == "成長動能來自AI 伺服器液冷散熱 O'Brien 測試"


def test_sql_injection_via_note_is_inert():
    """A hostile 備註 must not be able to close the literal and run DDL."""
    hostile = "'); DROP TABLE raw_revenue; --"
    rep = Report(run_id="t")
    rep.rows = [mk("2330", "2026-03", 1000, yoy=900, note=hostile)]
    conn = apply_sql(seed.build(universe=load_universe(), report=rep))
    assert conn.execute(
        "SELECT note AS n FROM raw_revenue WHERE ticker='2330'"
    ).fetchone()["n"] == hostile
    assert conn.execute(
        "SELECT count(*) AS c FROM raw_revenue"
    ).fetchone()["c"] == 1


def test_golden_checks_catch_precision_regression():
    rep_rows = [mk("2330", "2026-03", 415191700,  # the ...700 bug
                   yoy=GOLDEN["revenue_yoy_month"], cum=GOLDEN["cum_revenue"],
                   cum_prior=GOLDEN["cum_revenue_prior"])]
    problems = seed.golden_checks(rep_rows)
    assert any("revenue_month" in p for p in problems)


def test_golden_checks_catch_units_change():
    rows = [
        mk("2330", "2026-03", GOLDEN["revenue_month"],
           yoy=GOLDEN["revenue_yoy_month"], cum=GOLDEN["cum_revenue"],
           cum_prior=GOLDEN["cum_revenue_prior"]),
        mk("2330", "2026-04", 415191699000),  # 1000x - units changed
    ]
    problems = seed.golden_checks(rows)
    assert any("units may have changed" in p for p in problems)


def test_golden_checks_catch_month_idx_disagreement():
    row = mk("2330", "2026-03", GOLDEN["revenue_month"],
             yoy=GOLDEN["revenue_yoy_month"], cum=GOLDEN["cum_revenue"],
             cum_prior=GOLDEN["cum_revenue_prior"])
    row["month_idx"] = row["month_idx"] + 1
    problems = seed.golden_checks([row])
    assert any("month_idx" in p for p in problems)


def test_golden_checks_pass_on_good_rows(report):
    assert seed.golden_checks(report.rows) == []


def test_fetch_log_months_include_data_free_months():
    """A month where nothing was published must still be scoped by the DELETE."""
    rep = Report(run_id="t")
    rep.rows = [mk("2330", "2026-03", 1000, yoy=900)]
    rep.fetch_log = [
        {"source_id": "mops_company", "month": "2026-08", "ticker": "2330",
         "url": "u", "http_status": 200, "byte_len": 1, "sha256": "x",
         "rows_parsed": 0, "ok": 1, "error": None,
         "fetched_at_utc": "2026-08-21T00:00:00Z"},
    ]
    sql = seed.build(universe=load_universe(), report=rep)
    assert "'2026-08'" in sql, "an all-empty month was left out of the scoped DELETE"
