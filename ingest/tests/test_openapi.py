"""Tests for the ongoing-refresh feeds (_P, _L, _O) and the cross-source check.

Fixtures are real bytes captured on 2026-08-21, trimmed to the universe tickers
plus six others by `ingest/tools/make_openapi_fixtures.py`. Records are verbatim;
only the count is reduced, so `expect_min_records` is lowered per-test where the
trimming would otherwise trip RECORD_COUNT_LOW.

The single most valuable test here is
`test_no_disagreement_between_mops_and_the_feeds`: the per-company HTML page and
the JSON feed are two renderings of one filing, so identical integer levels prove
both parsers at once. Nothing else in the project can do that.
"""

from __future__ import annotations

import dataclasses
import json

import pytest

from twrev import mops_company as mc
from twrev import openapi, roc
from twrev.config import load_sources, load_universe
from twrev.schema import SchemaDriftError

MONTH = "2026-07"


# ------------------------------------------------------------------ helpers --

@pytest.fixture(scope="module")
def universe():
    return load_universe()


@pytest.fixture(scope="module")
def sources():
    return load_sources()


def feed_of(sources, source_id, **overrides):
    """A feed from config, with fields overridden for the trimmed fixtures."""
    return dataclasses.replace(sources.feed(source_id), **overrides)


def load_feed_bytes(fixtures_dir, source_id, month=MONTH):
    name = f"{source_id}_{month.replace('-', '')}.json"
    return (fixtures_dir / "openapi" / name).read_bytes()


def parse_feed(fixtures_dir, sources, universe, source_id, **overrides):
    feed = feed_of(sources, source_id, expect_min_records=0, **overrides)
    return openapi.parse(load_feed_bytes(fixtures_dir, source_id),
                         feed=feed, universe=universe)


# ------------------------------------------------------------- cache keying --

def test_cache_key_is_dated_or_latest(sources):
    feed = sources.feed("twse_openapi_l")
    assert openapi.cache_key(feed) == "twse_openapi_l/twse_openapi_l_latest.json"
    assert openapi.cache_key(feed, "2026-07") == \
        "twse_openapi_l/twse_openapi_l_202607.json"


# ------------------------------------------------------------ the golden row --

def test_golden_row_from_the_listed_feed(fixtures_dir, sources, universe):
    """2330 / 2026-07, the plan's second golden row, from the OpenAPI surface."""
    res = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    row = next(r for r in res.rows if r["ticker"] == "2330")

    assert res.month == "2026-07"
    assert row["revenue_month"] == 467580548
    assert row["revenue_yoy_month"] == 323165707
    assert row["cum_revenue"] == 2872064238
    assert row["cum_revenue_prior"] == 2096211240
    # Unlike the per-company endpoint, these feeds DO carry 上月營收.
    assert row["revenue_prev_month"] == 442679969
    assert row["market"] == "sii"
    assert row["month"] == "2026-07"
    assert row["month_idx"] is not None
    assert row["ticker"] == "2330" and isinstance(row["ticker"], str)
    # As-reported Chinese name is preserved; display_name comes from universe.yaml.
    assert row["company_name"] == "台積電"
    assert row["industry"] == "半導體業"
    assert row["report_date"] == "1150817"


def test_feed_percentages_are_full_precision_not_rounded(fixtures_dir, sources, universe):
    """The feeds report ~15 significant digits; the HTML page truncates to 2dp.

    467580548 / 323165707 - 1 = 44.68755...%. The feed says 44.68755126916978,
    the per-company page says 44.68 - i.e. MOPS TRUNCATES rather than rounds,
    while the honest 2dp value is 44.69. This is precisely why every displayed
    percentage is recomputed from the integer levels instead of copied, and why
    the reported fields are retained only as a QA cross-check.
    """
    res = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    row = next(r for r in res.rows if r["ticker"] == "2330")
    assert row["src_yoy_pct"] == pytest.approx(44.68755126916978)
    recomputed = 100.0 * (row["revenue_month"] / row["revenue_yoy_month"] - 1)
    assert round(recomputed, 2) == 44.69
    assert abs(recomputed - row["src_yoy_pct"]) < 1e-9


def test_absent_note_is_null_not_a_dash(fixtures_dir, sources, universe):
    """All three feeds write 備註 as "-" for "no note"; that must become NULL.

    Otherwise an absent note renders as a literal dash, and looks different
    depending on which source supplied the row.
    """
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    assert any(r.get("備註") == "-" for r in raw), "fixture no longer exercises this"
    res = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    assert [r["note"] for r in res.rows if r["note"] == "-"] == []


# ------------------------------------------------------ month from the payload --

def test_month_comes_from_the_payload_not_the_clock(fixtures_dir, sources, universe):
    """資料年月 = 11507 must yield 2026-07 regardless of today's date."""
    res = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    assert res.month == "2026-07"
    assert res.months_seen == {"2026-07"}
    assert all(r["month"] == "2026-07" for r in res.rows)
    assert all(r["roc_yyyymm"] == "11507" for r in res.rows)


def test_expecting_a_later_month_is_info_not_error(fixtures_dir, sources, universe):
    """Before the 10th the feed still shows the prior month. That is normal."""
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0)
    res = openapi.parse(load_feed_bytes(fixtures_dir, "twse_openapi_l"),
                        feed=feed, universe=universe, expect_month="2026-08")
    codes = {(sev, code) for sev, code, _ in res.findings}
    assert ("info", "MONTH_NOT_YET_PUBLISHED") in codes
    assert [f for f in res.findings if f[0] == "error"] == []
    # And the rows are still filed under the month the feed actually describes.
    assert res.month == "2026-07"


def test_multi_month_snapshot_is_an_error(fixtures_dir, sources, universe):
    """These feeds are documented single-month snapshots; two months voids that."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    raw[0] = {**raw[0], "資料年月": "11506"}
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0)
    res = openapi.parse(json.dumps(raw, ensure_ascii=False).encode("utf-8"),
                        feed=feed, universe=universe)
    assert ("error", "MULTI_MONTH_SNAPSHOT") in {(s, c) for s, c, _ in res.findings}
    # Nothing may be persisted from a response whose month is ambiguous.
    assert res.rows == []


# --------------------------------------------------------- coverage & _P ---

def test_specified_feed_covers_none_of_the_universe(fixtures_dir, sources, universe):
    """The brief's `_P` is the non-listed-issuer dataset. Info, not error."""
    res = parse_feed(fixtures_dir, sources, universe, "twse_openapi_p")
    assert res.covered == set()
    assert res.rows == []
    sev, code, message = next(f for f in res.findings if f[1] == "SOURCE_EMPTY")
    assert sev == "info", "an expected-empty feed must not read as a failure"
    assert "fallback chain" in message
    assert res.role == "specified", "the brief's feed stays first in precedence"


def test_p_feed_holds_six_digit_codes_the_filter_must_reject(fixtures_dir):
    """`_P` uses 6-digit issuer codes (e.g. 000104), not 4-digit tickers.

    clean_ticker would raise SchemaDriftError on those, so the universe filter
    running BEFORE row construction is load-bearing, not an optimisation.
    """
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_p").decode("utf-8"))
    codes = [r["公司代號"] for r in raw]
    assert any(len(c) != 4 for c in codes), f"fixture changed shape: {codes}"
    from twrev.schema import clean_ticker
    with pytest.raises(SchemaDriftError):
        clean_ticker(next(c for c in codes if len(c) != 4))


def test_listed_and_otc_feeds_partition_the_trackable_universe(
        fixtures_dir, sources, universe):
    """31 on TWSE + 5 on TPEx = 36 = every trackable name. 6286 is on neither."""
    listed = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    otc = parse_feed(fixtures_dir, sources, universe, "tpex_openapi_o")

    assert len(listed.covered) == 31
    assert len(otc.covered) == 5
    assert listed.covered & otc.covered == set(), "a ticker on both feeds is ambiguous"

    combined = listed.covered | otc.covered
    trackable = set(universe.trackable_tickers)
    assert combined == trackable
    assert len(combined) == 36
    assert "6286" not in combined
    assert set(universe.tickers) - combined == {"6286"}


def test_otc_feed_carries_the_expected_five(fixtures_dir, sources, universe):
    res = parse_feed(fixtures_dir, sources, universe, "tpex_openapi_o")
    assert res.covered == {"6147", "3324", "3680", "5347", "6138"}
    assert all(r["market"] == "otc" for r in res.rows)


def test_ky_names_are_on_the_listed_feed_despite_their_codes(
        fixtures_dir, sources, universe):
    """6415 and 8081 look like OTC codes but file on TWSE. universe.yaml says so."""
    listed = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    assert {"6415", "8081"} <= listed.covered


def test_coverage_drop_is_a_warning_with_the_missing_names(
        fixtures_dir, sources, universe):
    """Losing a ticker must name it, or the alert is unactionable."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    kept = [r for r in raw if r.get("公司代號") != "2382"]
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0,
                   expect_target_coverage=31)
    res = openapi.parse(json.dumps(kept, ensure_ascii=False).encode("utf-8"),
                        feed=feed, universe=universe)
    sev, code, message = next(f for f in res.findings if f[1] == "COVERAGE_DROPPED")
    assert sev == "warn"
    assert "2382" in message


def test_missing_anchor_is_an_error(fixtures_dir, sources, universe):
    """Anchors are the cheap proof we are reading the dataset we think we are."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    anchors = sources.feed("twse_openapi_l").anchor_tickers
    assert anchors, "the listed feed must declare at least one anchor"
    kept = [r for r in raw if r.get("公司代號") not in anchors]
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0,
                   expect_target_coverage=0)
    res = openapi.parse(json.dumps(kept, ensure_ascii=False).encode("utf-8"),
                        feed=feed, universe=universe)
    sev, code, message = next(f for f in res.findings if f[1] == "ANCHOR_MISSING")
    assert sev == "error"
    assert anchors[0] in message


def test_low_record_count_warns(fixtures_dir, sources, universe):
    """The real feed has 1085 records; a partial publication must be visible."""
    feed = sources.feed("twse_openapi_l")   # real expect_min_records
    assert feed.expect_min_records > 100
    res = openapi.parse(load_feed_bytes(fixtures_dir, "twse_openapi_l"),
                        feed=feed, universe=universe)
    sev, code, message = next(f for f in res.findings if f[1] == "RECORD_COUNT_LOW")
    assert sev == "warn"
    assert str(feed.expect_min_records) in message


# --------------------------------------------------------------- drift ---

def test_missing_required_key_is_fatal(fixtures_dir, sources, universe):
    """A feed that drops 營業收入-當月營收 must raise, not yield null revenue."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    stripped = [{k: v for k, v in r.items() if k != "營業收入-當月營收"} for r in raw]
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0)
    with pytest.raises(SchemaDriftError, match="營業收入-當月營收"):
        openapi.parse(json.dumps(stripped, ensure_ascii=False).encode("utf-8"),
                      feed=feed, universe=universe)


def test_optional_key_may_disappear(fixtures_dir, sources, universe):
    """Dropping 備註 is not a reason to reject a filing."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    stripped = [{k: v for k, v in r.items() if k != "備註"} for r in raw]
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0)
    res = openapi.parse(json.dumps(stripped, ensure_ascii=False).encode("utf-8"),
                        feed=feed, universe=universe)
    assert len(res.rows) == 31
    assert all(r["note"] is None for r in res.rows)


def test_percent_sentinel_becomes_null(fixtures_dir, sources, universe):
    """999999.99 means "no denominator", not 999999.99% growth."""
    raw = json.loads(load_feed_bytes(fixtures_dir, "twse_openapi_l").decode("utf-8"))
    patched = [
        {**r, "營業收入-去年同月增減(%)": "999999.99"} if r.get("公司代號") == "2330" else r
        for r in raw
    ]
    feed = feed_of(sources, "twse_openapi_l", expect_min_records=0)
    res = openapi.parse(json.dumps(patched, ensure_ascii=False).encode("utf-8"),
                        feed=feed, universe=universe)
    row = next(r for r in res.rows if r["ticker"] == "2330")
    assert row["src_yoy_pct"] is None
    # The integer levels are untouched, so the recomputed YoY still works.
    assert row["revenue_month"] == 467580548


# --------------------------------------------------- validate_body (caching) --

def test_validate_body_accepts_the_real_feeds(fixtures_dir):
    for source_id in ("twse_openapi_p", "twse_openapi_l", "tpex_openapi_o"):
        assert openapi.validate_body(load_feed_bytes(fixtures_dir, source_id)) is None


@pytest.mark.parametrize("body,expect", [
    (b"", "too short"),
    (b"x" * 300, "not valid JSON"),
    (b"[]" + b" " * 300, None),          # long enough, but empty
    (b'{"error":"nope"}' + b" " * 300, "expected a JSON array"),
])
def test_validate_body_rejects_bad_bodies(body, expect):
    reason = openapi.validate_body(body)
    assert reason is not None
    if expect:
        assert expect in reason


def test_truncated_json_is_rejected_before_caching(fixtures_dir):
    """The worst failure mode: a partial body cached as if it were complete.

    It would parse as *fewer records* rather than as an error on some inputs, so
    the guard has to be at the cache boundary.
    """
    body = load_feed_bytes(fixtures_dir, "twse_openapi_l")
    assert openapi.validate_body(body[: len(body) // 2]) is not None


# ------------------------------------------------- the cross-source check ---

def test_no_disagreement_between_mops_and_the_feeds(
        fixtures_dir, sources, universe):
    """Two independent renderings of one filing must agree on every integer.

    The MOPS side is parsed from HTML fixtures, the feed side from JSON fixtures.
    If either parser mapped a column wrongly, this fails - which makes it the
    only test that can prove both at once.
    """
    listed = parse_feed(fixtures_dir, sources, universe, "twse_openapi_l")
    otc = parse_feed(fixtures_dir, sources, universe, "tpex_openapi_o")
    feed_rows = listed.rows + otc.rows

    # The MOPS fixtures on disk cover a handful of ticker-months, not all 36.
    # 6415 is included deliberately: it is a -KY consolidated filer, so this also
    # proves the three-column form's TWD column matches the feed's figure.
    mops_rows = []
    for ticker, month in (("2330", "2026-07"), ("6415", "2026-07")):
        path = (fixtures_dir / "mops_company"
                / f"{ticker}_{roc.month_to_roc_yyyymm(month)}.html")
        if not path.is_file():
            continue
        out = mc.parse_from_bytes(path.read_bytes(), ticker=ticker, month=month)
        if out.row:
            mops_rows.append(out.row)

    assert mops_rows, "no MOPS fixture overlaps the feed month - proves nothing"
    findings = openapi.compare(mops_rows, feed_rows)
    disagreements = [f for f in findings if f[1] == "SOURCE_DISAGREEMENT"]
    assert disagreements == [], disagreements
    assert [f for f in findings if f[0] == "error"] == []


def test_compare_reports_a_level_mismatch_as_an_error():
    """A one-thousand difference is the units bug this is meant to catch."""
    a = {"ticker": "2330", "month": "2026-07", "source_id": "mops_company",
         "revenue_month": 467580548, "revenue_yoy_month": 323165707,
         "cum_revenue": None, "cum_revenue_prior": None, "company_name": "台積電"}
    b = {**a, "source_id": "twse_openapi_l", "revenue_month": 467580}
    findings = openapi.compare([a], [b])
    sev, code, message = next(f for f in findings if f[1] == "SOURCE_DISAGREEMENT")
    assert sev == "error"
    assert "revenue_month" in message and "467,580,548" in message


def test_compare_ignores_percentages():
    """Both surfaces round independently, so a 2dp delta is arithmetic not drift."""
    a = {"ticker": "2330", "month": "2026-07", "source_id": "mops_company",
         "revenue_month": 467580548, "revenue_yoy_month": 323165707,
         "cum_revenue": None, "cum_revenue_prior": None,
         "src_yoy_pct": 44.68, "company_name": None}
    b = {**a, "source_id": "twse_openapi_l", "src_yoy_pct": 44.68755126916978}
    assert openapi.compare([a], [b]) == []


def test_compare_treats_a_rename_as_info(fixtures_dir):
    a = {"ticker": "2330", "month": "2026-07", "source_id": "mops_company",
         "revenue_month": 1, "revenue_yoy_month": None, "cum_revenue": None,
         "cum_revenue_prior": None, "company_name": "台積電"}
    b = {**a, "source_id": "twse_openapi_l", "company_name": "台灣積體電路"}
    sev, code, message = next(f for f in openapi.compare([a], [b])
                              if f[1] == "NAME_CHANGED")
    assert sev == "info", "a rename must not break a ticker-keyed series"


def test_compare_warns_when_nothing_overlaps():
    """Silence must never be mistaken for agreement."""
    a = {"ticker": "2330", "month": "2026-07", "source_id": "mops_company",
         "revenue_month": 1, "revenue_yoy_month": None, "cum_revenue": None,
         "cum_revenue_prior": None, "company_name": None}
    b = {**a, "ticker": "3443", "source_id": "twse_openapi_l"}
    sev, code, message = next(f for f in openapi.compare([a], [b])
                              if f[1] == "NO_OVERLAP")
    assert sev == "warn"
    assert "proved nothing" in message


def test_compare_skips_nulls_rather_than_calling_them_a_mismatch():
    """mops_company has no 上月營收; that is sparseness, not disagreement."""
    a = {"ticker": "2330", "month": "2026-07", "source_id": "mops_company",
         "revenue_month": 467580548, "revenue_yoy_month": None,
         "cum_revenue": None, "cum_revenue_prior": None, "company_name": None}
    b = {**a, "source_id": "twse_openapi_l", "revenue_yoy_month": 323165707}
    assert openapi.compare([a], [b]) == []
