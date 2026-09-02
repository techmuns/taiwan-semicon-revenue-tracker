"""Tests for the per-company MOPS adapter, against real captured responses.

Every fixture here is bytes MOPS actually returned on 2026-08-21, not a
hand-written approximation. That matters because all three of this parser's
failure modes were things no reasonable hand-written fixture would have contained:
scientific-notation precision loss, a malformed 備註 row that different HTML
parsers disagree about, and a three-column foreign-issuer form.
"""

from __future__ import annotations

import pytest

from twrev import mops_company as mc
from twrev.schema import MOPS_ROW_LABELS, SchemaDriftError

PARSERS = ("lxml", "html.parser", "html5lib")


def load(fixtures_dir, name):
    return (fixtures_dir / "mops_company" / name).read_bytes()


# --------------------------------------------------------------------- URLs --

def test_url_zero_pads_month(fixtures_dir):
    from twrev.config import load_sources
    template = load_sources().backfill.url_template
    url = mc.url_for("2330", "2026-03", template)
    assert "year=115" in url
    assert "month=03" in url, "month must be zero-padded"
    assert "yearmonth=11503" in url
    assert "co_id=2330" in url

    url_oct = mc.url_for("2330", "2026-10", template)
    assert "month=10" in url_oct and "yearmonth=11510" in url_oct


# ------------------------------------------------------- the standard form --

def test_golden_row_exact(fixtures_dir):
    """2330 / 2026-03, verified by hand against the live response."""
    out = mc.parse_from_bytes(load(fixtures_dir, "2330_11503.html"),
                              ticker="2330", month="2026-03")
    assert out.status == mc.DATA
    r = out.row
    assert r["revenue_month"] == 415191699
    # The precision bug pandas.read_html's 4.151917e+08 display would introduce.
    assert r["revenue_month"] != 415191700
    assert r["revenue_yoy_month"] == 285956830
    assert r["src_yoy_pct"] == pytest.approx(45.19)
    assert r["cum_revenue"] == 1134103440
    assert r["cum_revenue_prior"] == 839253664
    assert r["src_cum_yoy_pct"] == pytest.approx(35.13)
    assert r["market"] == "sii"
    assert r["month"] == "2026-03"
    assert r["roc_yyyymm"] == "11503"
    # This endpoint has no 上月營收 at all - the reason Dec 2025 is fetched.
    assert r["revenue_prev_month"] is None
    assert r["src_mom_pct"] is None
    # A ticker must stay a string, or every join to universe.yaml breaks.
    assert r["ticker"] == "2330" and isinstance(r["ticker"], str)


def test_no_findings_on_clean_response(fixtures_dir):
    """The self-check must be silent when the mapping is right."""
    out = mc.parse_from_bytes(load(fixtures_dir, "2330_11503.html"),
                              ticker="2330", month="2026-03")
    assert [f for f in out.findings if f[0] in ("warn", "error")] == []


@pytest.mark.parametrize("parser", PARSERS)
def test_all_parsers_agree(fixtures_dir, parser):
    """lxml drops the malformed 備註 row, html5lib keeps it. Results must match."""
    out = mc.parse(load(fixtures_dir, "2330_11503.html").decode("utf-8"),
                   ticker="2330", month="2026-03", parser=parser)
    assert out.row["revenue_month"] == 415191699
    assert out.row["cum_revenue"] == 1134103440


def test_note_extracted_despite_lxml_dropping_the_row(fixtures_dir):
    """3324 has a real 備註 the lxml row-based path would silently discard."""
    out = mc.parse_from_bytes(load(fixtures_dir, "3324_11503.html"),
                              ticker="3324", month="2026-03")
    assert out.row["note"], "the 備註 was lost"
    assert "AI" in out.row["note"]


# -------------------------------------------- the foreign-issuer (-KY) form --

def test_ky_consolidated_form_parses(fixtures_dir):
    """3661 Alchip: 合併營業收入淨額, three columns, TWD + USD, plus FX rows."""
    out = mc.parse_from_bytes(load(fixtures_dir, "3661_11503.html"),
                              ticker="3661", month="2026-03")
    assert out.status == mc.DATA
    r = out.row
    # The TWD column, exactly as filed.
    assert r["revenue_month"] == 1933218
    assert r["revenue_yoy_month"] == 3618515
    assert r["cum_revenue"] == 4186215
    assert r["cum_revenue_prior"] == 10485531
    assert r["src_yoy_pct"] == pytest.approx(-46.57)
    assert r["src_cum_yoy_pct"] == pytest.approx(-60.08)


def test_ky_form_takes_twd_not_functional_currency(fixtures_dir):
    """The whole risk of the three-column form in one assertion.

    3661/2026-03 reports 1,933,218 TWD thousands and 60,678.53 USD thousands.
    Reading the wrong column would make the level ~30x too small with no other
    visible symptom, and every percentage would still look plausible.
    """
    out = mc.parse_from_bytes(load(fixtures_dir, "3661_11503.html"),
                              ticker="3661", month="2026-03")
    assert out.row["revenue_month"] == 1933218
    assert out.row["revenue_month"] != 60678
    # The USD-column percentage (-44.68) must not be what we stored (-46.57).
    assert out.row["src_yoy_pct"] == pytest.approx(-46.57)
    assert out.row["src_yoy_pct"] != pytest.approx(-44.68)


def test_ky_form_flags_consolidated_basis(fixtures_dir):
    out = mc.parse_from_bytes(load(fixtures_dir, "3661_11503.html"),
                              ticker="3661", month="2026-03")
    codes = {f[1] for f in out.findings}
    assert "CONSOLIDATED_BASIS" in codes
    msg = next(f[2] for f in out.findings if f[1] == "CONSOLIDATED_BASIS")
    assert "美金" in msg or "USD" in msg
    # Informational only - a different reporting basis is not a data defect.
    assert [f for f in out.findings if f[0] == "error"] == []


@pytest.mark.parametrize("parser", PARSERS)
def test_ky_form_parser_independent(fixtures_dir, parser):
    out = mc.parse(load(fixtures_dir, "3661_11503.html").decode("utf-8"),
                   ticker="3661", month="2026-03", parser=parser)
    assert out.row["revenue_month"] == 1933218


def test_second_ky_company(fixtures_dir):
    """6415 Silergy, a different month - confirms the form, not one response."""
    out = mc.parse_from_bytes(load(fixtures_dir, "6415_11507.html"),
                              ticker="6415", month="2026-07")
    assert out.status == mc.DATA
    assert out.row["revenue_month"] > 0
    assert "CONSOLIDATED_BASIS" in {f[1] for f in out.findings}
    assert [f for f in out.findings if f[0] == "error"] == []


@pytest.mark.parametrize(
    "name,ticker,month,fragment",
    [
        ("3661_11503.html", "3661", "2026-03", "量產產品減少"),
        ("6415_11507.html", "6415", "2026-07", "需求增加"),
    ],
)
def test_ky_form_note_is_not_dropped(fixtures_dir, name, ticker, month, fragment):
    """The -KY form labels the note cell plain 備註, not 營收變化原因說明.

    Only the second label was matched, so the issuer's mandatory explanation of
    the revenue swing was silently discarded for exactly the two filers whose
    LEVELS already carry a comparability caveat - the sentence a reader most
    wants when they cannot compare the level. `note` is inside row_hash, so a
    parser that drops it hashes the filing differently and the next run reads as
    a restatement that never happened.
    """
    out = mc.parse_from_bytes(load(fixtures_dir, name), ticker=ticker, month=month)
    assert out.row["note"], "the -KY 備註 was lost"
    assert fragment in out.row["note"]
    # The label must not leak into the value.
    assert not out.row["note"].startswith("備註")


# The currency sub-header exactly as it appears in the fixture.
SUBHEADER_TWD_FIRST = (
    "<TD align='center' class='tblHead'>新台幣</TD>"
    "<TD align='center' class='tblHead'>功能性貨幣(美金)</TD>"
)
SUBHEADER_SWAPPED = (
    "<TD align='center' class='tblHead'>功能性貨幣(美金)</TD>"
    "<TD align='center' class='tblHead'>新台幣</TD>"
)


def test_ky_swapped_currency_columns_are_rejected(fixtures_dir):
    """The scenario the sub-header assertion exists for.

    If MOPS ever put the functional currency in column 1, taking cells[1] would
    silently ingest USD as TWD thousands - a ~30x error with no other symptom,
    and every recomputed percentage would still look plausible because the levels
    are internally consistent. So the parser must refuse rather than guess.
    """
    html = load(fixtures_dir, "3661_11503.html").decode("utf-8")
    assert SUBHEADER_TWD_FIRST in html, "fixture markup changed"
    broken = html.replace(SUBHEADER_TWD_FIRST, SUBHEADER_SWAPPED)
    with pytest.raises(SchemaDriftError, match="column is TWD"):
        mc.parse(broken, ticker="3661", month="2026-03")


def test_ky_unrecognised_currency_subheader_is_rejected(fixtures_dir):
    """An unfamiliar sub-header must fail loudly, by whichever guard sees it first."""
    html = load(fixtures_dir, "3661_11503.html").decode("utf-8")
    broken = html.replace(SUBHEADER_TWD_FIRST, SUBHEADER_TWD_FIRST.replace("新台幣", "某種貨幣"))
    with pytest.raises(SchemaDriftError):
        mc.parse(broken, ticker="3661", month="2026-03")


# ----------------------------------------------- non-data responses & drift --

def test_not_an_issuer(fixtures_dir):
    out = mc.parse_from_bytes(load(fixtures_dir, "6286_11503.html"),
                              ticker="6286", month="2026-03")
    assert out.status == mc.NOT_AN_ISSUER
    assert out.row is None
    assert {f[1] for f in out.findings} == {"NOT_AN_ISSUER"}


def test_no_data_month(fixtures_dir):
    """2330 / ROC 115-08: not published as of 2026-08-21."""
    out = mc.parse_from_bytes(load(fixtures_dir, "2330_11508.html"),
                              ticker="2330", month="2026-08")
    assert out.status == mc.NO_DATA
    assert out.row is None


def test_ticker_mismatch_is_fatal(fixtures_dir):
    """The most dangerous bug possible: one company's revenue under another's ticker."""
    with pytest.raises(mc.TickerMismatch):
        mc.parse_from_bytes(load(fixtures_dir, "2330_11503.html"),
                            ticker="2317", month="2026-03")


def test_month_mismatch_is_fatal(fixtures_dir):
    with pytest.raises(mc.MonthMismatch):
        mc.parse_from_bytes(load(fixtures_dir, "2330_11503.html"),
                            ticker="2330", month="2026-04")


def test_unit_change_is_fatal(fixtures_dir):
    """If MOPS ever reports in 元 rather than 仟元, figures are 1000x off."""
    html = load(fixtures_dir, "2330_11503.html").decode("utf-8")
    with pytest.raises(mc.UnitChanged):
        mc.parse(html.replace(mc.UNIT_ANCHOR, "單位：新台幣元"),
                 ticker="2330", month="2026-03")


def test_label_drift_is_fatal(fixtures_dir):
    """Reordering two labels must raise, not silently transpose two figures."""
    html = load(fixtures_dir, "2330_11503.html").decode("utf-8")
    broken = html.replace("本年累計", "去年累計", 1)
    with pytest.raises(SchemaDriftError, match="labels changed"):
        mc.parse(broken, ticker="2330", month="2026-03")


def test_expected_label_sequence_has_repeats():
    """The reason values are mapped by position rather than by label."""
    assert MOPS_ROW_LABELS.count("增減金額") == 2
    assert MOPS_ROW_LABELS.count("增減百分比") == 2


def test_self_check_catches_transposed_levels(fixtures_dir):
    """Swapping 本月 and 去年同期 must produce loud findings, not quiet data.

    This is the check that caught the original positional-mapping bug, so it is
    worth proving it still fires.
    """
    html = load(fixtures_dir, "2330_11503.html").decode("utf-8")
    swapped = html.replace("415,191,699", "@@A@@").replace("285,956,830", "415,191,699")
    swapped = swapped.replace("@@A@@", "285,956,830")
    out = mc.parse(swapped, ticker="2330", month="2026-03")
    codes = {f[1] for f in out.findings if f[0] == "error"}
    assert codes & {"DELTA_MISMATCH", "PCT_MISMATCH"}, out.findings


def test_validate_body_accepts_known_empty_responses(fixtures_dir):
    """A 'no data' response is a valid answer; retrying it 5 times finds nothing."""
    assert mc.validate_body(load(fixtures_dir, "6286_11503.html"), min_bytes=1500) is None
    assert mc.validate_body(load(fixtures_dir, "2330_11508.html"), min_bytes=1500) is None


def test_validate_body_rejects_truncation(fixtures_dir):
    body = load(fixtures_dir, "2330_11503.html")
    assert mc.validate_body(body[:400], min_bytes=1500) is not None
