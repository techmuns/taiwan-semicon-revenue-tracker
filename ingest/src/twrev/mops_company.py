"""Adapter for the brief's backfill endpoint: MOPS per-company monthly revenue.

    ajax_t05st10_ifrs?firstin=true&off=1&step=0
        &co_id={CODE}&year={ROC}&month={MM}&yearmonth={ROC}{MM}

Response shape, verified live against 2330 and 3324 for ROC 115-03:

  * UTF-8 (zero replacement chars) - no big5 handling needed anywhere.
  * A hidden form echoes the request back:
        compID / Q1V = '2330'      the ticker the server actually answered for
        Q2V          = '11503'     the month the server actually answered for
        Market       = 'sii '      authoritative market (note the trailing space)
    This echo is the single most useful thing in the document: it turns
    "did my URL do what I intended?" from an assumption into an assertion.
  * A banner: 本資料由　(上市公司)台積電　公司提供
  * 民國115年03月 and 單位：新台幣仟元   <- the unit, asserted rather than assumed
  * The revenue table, label/value, whose two 增減金額 and two 增減百分比 labels
    REPEAT - so values are mapped by position, not by label.

Three parser traps this module is built around:

1. `pandas.read_html` renders 415,191,699 as 4.151917e+08, which round-trips to
   415191700 - off by one from the filed figure. Values are therefore parsed from
   the comma-separated strings directly (see schema.clean_int).

2. The 備註 row's markup is malformed (a <TH> with no opening <TR>), and parsers
   disagree about it: lxml and html.parser drop the row entirely, html5lib keeps
   it, giving 10 rows instead of 9. So the row count is never trusted - the 備註
   row is removed by its unique label and the remaining 8 are asserted against
   the expected label sequence. The note itself is extracted from the raw markup,
   which is parser-independent. 3324/2026-03 has a real note that the lxml path
   would otherwise have silently discarded.

3. Foreign-registered (-KY) issuers file a DIFFERENT form. Live evidence: 3661
   Alchip and 6415 Silergy - and only those two of the 37 - return

     項目            合併營業收入淨額        <- 合併, i.e. CONSOLIDATED
     新台幣          功能性貨幣(美金)        <- a currency sub-header row
     本月            1,933,218   60,678.53   <- THREE columns: label, TWD, USD
     ...
     本月換算匯率：   ─          31.8600     <- two trailing FX-rate rows
     本年累計換算匯率：─         31.6310

   `營業收入淨額` is a substring of `合併營業收入淨額`, so the anchor still finds
   the table; what breaks is the row set. The three extra rows are dropped by
   label, after which the same 8 positions assert cleanly, and column 1 is the
   TWD figure the brief asks for. That column order is asserted, not assumed:
   silently reading the functional-currency column would make the levels ~30x too
   small with no other visible symptom. The consolidated basis is recorded as a
   CONSOLIDATED_BASIS finding, because those two companies' revenue LEVELS are
   not directly comparable with the 34 standalone filers (their growth rates are).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from bs4 import BeautifulSoup

from . import roc
from .schema import (
    MOPS_ROW_LABELS,
    MOPS_ROW_TARGETS,
    SchemaDriftError,
    blank_row,
    clean_int,
    clean_pct,
    clean_text,
    row_hash,
)

SOURCE_ID = "mops_company"

# Outcome statuses. Only DATA yields a row; the other two are legitimate
# "nothing to report" answers and must not be treated as fetch failures.
DATA = "data"
NOT_AN_ISSUER = "not_an_issuer"   # 6286: filing obligation ended
NO_DATA = "no_data"               # month not published yet, or never filed

# Exact strings observed in live responses (HTTP 200 in both cases).
RE_NOT_AN_ISSUER = re.compile(r"公開發行公司不繼續公開發行")
RE_NO_DATA = re.compile(r"查無需求資料|查無資料|查無此公司")

UNIT_ANCHOR = "單位：新台幣仟元"
TABLE_ANCHOR = "營業收入淨額"

RE_BANNER = re.compile(r"本資料由\s*[（(]([^)）]+)[)）]\s*(.*?)\s*公司提供")
RE_ROC_BANNER = re.compile(r"民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月")
# The 備註 cell, taken from raw markup because parsers disagree about the row.
#
# Two forms, two labels. The standalone form writes 備註 / 營收變化原因說明 in a
# <TH> followed by the value <TD>. The foreign-issuer (-KY) form labels the same
# cell plain 備註 in an ordinary <td class='tblHead'>, which the first pattern
# cannot match - so 3661 and 6415 silently lost the issuer's mandatory
# explanation of the revenue swing, which is exactly the sentence a reader wants
# when the -KY levels already carry a comparability caveat. RE_NOTE_KY closes
# that, and worker/src/mops.ts takes the same cell from its parsed rows so both
# writers of source_id 'mops_company' agree - `note` is inside row_hash.
RE_NOTE = re.compile(r"營收變化原因說明\s*</TH>\s*<TD[^>]*>(.*?)</TD>", re.I | re.S)
RE_NOTE_KY = re.compile(
    r"<td[^>]*>\s*備註\s*</td>\s*<td[^>]*>(.*?)</td>", re.I | re.S
)
RE_TAG = re.compile(r"<[^>]+>")

MARKET_FROM_BANNER = {"上市公司": "sii", "上櫃公司": "otc", "興櫃公司": "rotc"}
NOTE_LABEL = "備註"

# ---------------------------------------------------------------------------
# The foreign-issuer (-KY) variant. See trap 3 in the module docstring.
# ---------------------------------------------------------------------------
# Header of the consolidated form. Contains TABLE_ANCHOR as a substring, so the
# anchor search finds this table too - the difference is the row shape, not the
# anchor.
CONSOLIDATED_ANCHOR = "合併營業收入淨額"
# The currency sub-header row: ['新台幣', '功能性貨幣(美金)'].
NTD_COLUMN_LABEL = "新台幣"
FUNCTIONAL_CURRENCY_LABEL = "功能性貨幣"
# Trailing FX-rate rows: 本月換算匯率：/ 本年累計換算匯率：
FX_RATE_LABEL = "換算匯率"
RE_FUNCTIONAL_CURRENCY = re.compile(r"功能性貨幣\s*[（(]([^)）]+)[)）]")


class TickerMismatch(SchemaDriftError):
    """The response is for a different company than requested.

    Almost always a URL-construction bug, and the most dangerous possible error
    here: it would write one company's revenue under another's ticker.
    """


class MonthMismatch(SchemaDriftError):
    """The response is for a different month than requested."""


class UnitChanged(SchemaDriftError):
    """The 單位：新台幣仟元 declaration is missing or changed."""


@dataclass
class Outcome:
    """Result of parsing one company-month."""
    status: str
    ticker: str
    month: str
    row: dict[str, Any] | None = None
    # (severity, code, message) - written to quality_findings, never fatal.
    findings: list[tuple[str, str, str]] = field(default_factory=list)

    @property
    def has_row(self) -> bool:
        return self.row is not None


def url_for(ticker: str, month: str, template: str) -> str:
    """Build the brief's URL. `mm` and the yearmonth suffix are zero-padded."""
    roc_year, mm = roc.month_to_roc_parts(month)
    return template.format(code=ticker, roc_year=roc_year, mm=f"{mm:02d}")


def cache_key(ticker: str, month: str) -> str:
    """Human-browsable cache path: opening one ticker-month's exact bytes matters."""
    return f"{SOURCE_ID}/{ticker}_{roc.month_to_roc_yyyymm(month)}.html"


def validate_body(body: bytes, *, min_bytes: int = 1500) -> str | None:
    """Fetcher validator: None to accept for caching, else a retryable reason.

    A legitimately empty answer (6286, or an unpublished month) is ACCEPTED, not
    retried. Retrying those would waste 5 attempts per ticker-month and still
    fail - and their emptiness is a fact worth caching.
    """
    if len(body) < min_bytes:
        return f"body too short ({len(body)} bytes < {min_bytes})"
    text = body.decode("utf-8", "replace")
    if text.count("�") > 20:
        return f"not valid UTF-8 ({text.count(chr(0xfffd))} replacement chars)"
    if RE_NOT_AN_ISSUER.search(text) or RE_NO_DATA.search(text):
        return None
    if TABLE_ANCHOR not in text:
        # Neither real data nor a recognised empty answer - most likely a MOPS
        # holding/maintenance page, which is transient. Retry.
        return f"missing {TABLE_ANCHOR!r} and no known empty marker"
    return None


def _echoed_fields(soup: BeautifulSoup) -> dict[str, str]:
    out: dict[str, str] = {}
    for inp in soup.find_all("input"):
        name, value = inp.get("name"), inp.get("value")
        if name and value is not None:
            out[name] = str(value).strip()
    return out


def _revenue_table_rows(soup: BeautifulSoup) -> list[list[str]]:
    """Rows of the table containing the revenue anchor, as trimmed cell text."""
    for table in soup.find_all("table"):
        if TABLE_ANCHOR not in table.get_text():
            continue
        rows: list[list[str]] = []
        for tr in table.find_all("tr"):
            cells = [
                c.get_text(strip=True).replace("　", " ").strip()
                for c in tr.find_all(["th", "td"])
            ]
            if any(cells):
                rows.append(cells)
        if rows:
            return rows
    raise SchemaDriftError(f"no table containing {TABLE_ANCHOR!r}")


def _extract_note(raw_html: str) -> str | None:
    """The note, from either form. See RE_NOTE / RE_NOTE_KY above."""
    for pattern in (RE_NOTE, RE_NOTE_KY):
        m = pattern.search(raw_html)
        if not m:
            continue
        text = RE_TAG.sub(" ", m.group(1)).replace("&nbsp;", " ")
        cleaned = clean_text(text)
        if cleaned:
            return cleaned
    return None


def parse(
    raw_html: str,
    *,
    ticker: str,
    month: str,
    parser: str = "lxml",
) -> Outcome:
    """Parse one company-month response into a raw_revenue row.

    Raises SchemaDriftError (or a subclass) for anything structurally wrong -
    those must never be persisted. Softer problems become findings.
    """
    if RE_NOT_AN_ISSUER.search(raw_html):
        return Outcome(
            status=NOT_AN_ISSUER, ticker=ticker, month=month,
            findings=[(
                "info", "NOT_AN_ISSUER",
                f"{ticker} {month}: MOPS reports 不繼續公開發行 - no filing "
                f"obligation, so no data exists for this month",
            )],
        )
    if RE_NO_DATA.search(raw_html):
        return Outcome(
            status=NO_DATA, ticker=ticker, month=month,
            findings=[(
                "info", "NO_DATA",
                f"{ticker} {month}: MOPS reports 查無需求資料 - not published "
                f"(or never filed) for this month",
            )],
        )

    soup = BeautifulSoup(raw_html, parser)
    findings: list[tuple[str, str, str]] = []

    # -- the request echo: assert the server answered the question we asked ----
    echo = _echoed_fields(soup)
    echoed_ticker = echo.get("Q1V") or echo.get("compID")
    if echoed_ticker and echoed_ticker != ticker:
        raise TickerMismatch(
            f"requested {ticker} but response echoes {echoed_ticker!r} "
            f"(compID={echo.get('compID')!r}) - check url_for()"
        )
    want_yyyymm = roc.month_to_roc_yyyymm(month)
    echoed_month = echo.get("Q2V")
    if echoed_month and echoed_month != want_yyyymm:
        raise MonthMismatch(
            f"{ticker}: requested {month} ({want_yyyymm}) but response echoes "
            f"{echoed_month!r} - the month parameter was not honoured"
        )

    # The banner is a cross-check on the echo, not a substitute for it.
    if UNIT_ANCHOR not in raw_html:
        raise UnitChanged(
            f"{ticker} {month}: {UNIT_ANCHOR!r} not found - the reporting unit may "
            f"have changed; refusing to write figures whose scale is unconfirmed"
        )
    banner_month = RE_ROC_BANNER.search(raw_html)
    if banner_month:
        got = f"{int(banner_month.group(1))}{int(banner_month.group(2)):02d}"
        if got != want_yyyymm:
            raise MonthMismatch(
                f"{ticker}: banner says 民國{banner_month.group(1)}年"
                f"{banner_month.group(2)}月 but {month} was requested"
            )

    market = (echo.get("Market") or "").strip().lower() or None
    company_name: str | None = None
    banner = RE_BANNER.search(raw_html.replace("　", " "))
    if banner:
        banner_market = MARKET_FROM_BANNER.get(banner.group(1).strip())
        company_name = clean_text(RE_TAG.sub(" ", banner.group(2)))
        if banner_market and market and banner_market != market:
            findings.append((
                "warn", "MARKET_ECHO_DISAGREEMENT",
                f"{ticker} {month}: Market field says {market!r} but the banner "
                f"says {banner.group(1)!r} ({banner_market!r})",
            ))
        market = market or banner_market
    if market not in (None, "sii", "otc", "rotc"):
        findings.append(("warn", "UNKNOWN_MARKET", f"{ticker} {month}: market={market!r}"))
        market = None
    # raw_revenue only models the two listed boards; 興櫃 would be a real change.
    if market == "rotc":
        findings.append((
            "warn", "EMERGING_BOARD",
            f"{ticker} {month}: reported on 興櫃 (emerging board), not sii/otc",
        ))
        market = None

    # -- the revenue table: drop non-value rows by label, assert the 8 positions --
    # Rows are removed by their unique labels rather than by index or count,
    # because the two form variants and the three HTML parsers all disagree about
    # how many rows there are. What they cannot disagree about is the labels.
    rows = _revenue_table_rows(soup)
    pairs: list[list[str]] = []
    for cells in rows:
        if len(cells) < 2:
            continue
        label = cells[0]
        if label.startswith(NOTE_LABEL):
            continue                       # 備註; extracted from raw markup instead
        if label in ("項目", TABLE_ANCHOR, CONSOLIDATED_ANCHOR):
            continue                       # table header
        if label == NTD_COLUMN_LABEL or FUNCTIONAL_CURRENCY_LABEL in label:
            continue                       # -KY currency sub-header
        if FX_RATE_LABEL in label:
            continue                       # -KY 換算匯率 footer rows
        pairs.append(cells)

    labels = tuple(r[0] for r in pairs)
    if labels != MOPS_ROW_LABELS:
        raise SchemaDriftError(
            f"{ticker} {month}: revenue table labels changed.\n"
            f"  expected {MOPS_ROW_LABELS}\n  got      {labels}"
        )

    # On the -KY form every value row is [label, NTD, functional currency]. We
    # take column 1, so the column ORDER is load-bearing: if MOPS ever swapped
    # them we would ingest USD figures as if they were TWD thousands, and the
    # levels would be ~30x too small with no other symptom. So the sub-header is
    # asserted rather than assumed.
    consolidated = CONSOLIDATED_ANCHOR in raw_html
    if consolidated:
        subheader = next(
            (r for r in rows if r and r[0] == NTD_COLUMN_LABEL), None
        )
        if subheader is None:
            raise SchemaDriftError(
                f"{ticker} {month}: consolidated form without the expected "
                f"'{NTD_COLUMN_LABEL}' currency sub-header - cannot prove which "
                f"column is TWD"
            )
        if not any(FUNCTIONAL_CURRENCY_LABEL in c for c in subheader[1:]):
            raise SchemaDriftError(
                f"{ticker} {month}: currency sub-header is {subheader!r}; "
                f"expected {NTD_COLUMN_LABEL} first, functional currency second"
            )
        currency = RE_FUNCTIONAL_CURRENCY.search(raw_html)
        findings.append((
            "info", "CONSOLIDATED_BASIS",
            f"{ticker} {month}: reports 合併營業收入淨額 (consolidated) with a "
            f"functional currency of {currency.group(1) if currency else '?'}; "
            f"TWD column taken. Levels are not directly comparable with the "
            f"standalone filers in the universe.",
        ))
    widths = {len(r) for r in pairs}
    if consolidated and widths != {3}:
        findings.append((
            "warn", "UNEXPECTED_ROW_WIDTH",
            f"{ticker} {month}: consolidated form rows have widths {sorted(widths)}, "
            f"expected 3",
        ))

    row = blank_row()
    row.update(
        source_id=SOURCE_ID,
        market=market,
        month=month,
        month_idx=roc.month_idx(month),
        ticker=ticker,
        roc_yyyymm=want_yyyymm,
        company_name=company_name,
        # This endpoint carries neither 產業別 nor 出表日期, and has no 上月營收
        # field at all - hence the Dec-2025 shoulder month, which is the only
        # way mom_pct for Jan 2026 can exist.
        industry=None,
        report_date=None,
        revenue_prev_month=None,
        src_mom_pct=None,
    )

    deltas: list[int | None] = []
    for cells, target in zip(pairs, MOPS_ROW_TARGETS):
        # cells is [label, value, ...]; the figure is always the second column.
        raw_value = cells[1]
        if target is None:
            deltas.append(clean_int(raw_value))          # the two 增減金額 rows
        elif target.startswith("src_"):
            row[target] = clean_pct(raw_value)
        else:
            row[target] = clean_int(raw_value)

    findings.extend(_self_check(row, deltas, ticker, month))
    row["row_hash"] = row_hash(row)
    return Outcome(status=DATA, ticker=ticker, month=month, row=row, findings=findings)


def _self_check(
    row: dict[str, Any],
    deltas: list[int | None],
    ticker: str,
    month: str,
) -> list[tuple[str, str, str]]:
    """Verify the positional mapping against the source's own derived figures.

    The response hands us 增減金額 and 增減百分比, which are functions of the
    levels. Recomputing them and comparing is a free per-row proof that the
    positional mapping is correct: if 本年累計 and 去年累計 were transposed, the
    percentages would disagree immediately rather than months later.
    """
    out: list[tuple[str, str, str]] = []

    def check_delta(kind: str, cur: Any, prior: Any, reported: int | None) -> None:
        if None in (cur, prior) or reported is None:
            return
        if cur - prior != reported:
            out.append((
                "error", "DELTA_MISMATCH",
                f"{ticker} {month}: {kind} {cur} - {prior} = {cur - prior} but "
                f"MOPS reports 增減金額 {reported} - positional mapping suspect",
            ))

    def check_pct(kind: str, cur: Any, prior: Any, reported: float | None) -> None:
        if None in (cur, prior) or reported is None or prior <= 0:
            return
        recomputed = 100.0 * (cur / prior - 1.0)
        drift = abs(recomputed - reported)
        if drift > 0.5:
            out.append((
                "error", "PCT_MISMATCH",
                f"{ticker} {month}: {kind} recomputed {recomputed:.2f}% vs "
                f"reported {reported:.2f}% (drift {drift:.2f}pp)",
            ))
        elif drift > 0.05:
            out.append((
                "warn", "PCT_MISMATCH",
                f"{ticker} {month}: {kind} recomputed {recomputed:.2f}% vs "
                f"reported {reported:.2f}% (drift {drift:.2f}pp)",
            ))

    monthly_delta = deltas[0] if len(deltas) > 0 else None
    cum_delta = deltas[1] if len(deltas) > 1 else None
    check_delta("monthly", row["revenue_month"], row["revenue_yoy_month"], monthly_delta)
    check_delta("cumulative", row["cum_revenue"], row["cum_revenue_prior"], cum_delta)
    check_pct("YoY", row["revenue_month"], row["revenue_yoy_month"], row["src_yoy_pct"])
    check_pct(
        "cumulative YoY",
        row["cum_revenue"], row["cum_revenue_prior"], row["src_cum_yoy_pct"],
    )

    if row["revenue_month"] is not None and row["revenue_month"] <= 0:
        out.append((
            "warn", "NONPOSITIVE_REVENUE",
            f"{ticker} {month}: revenue_month = {row['revenue_month']}",
        ))
    return out


def parse_from_bytes(body: bytes, *, ticker: str, month: str, parser: str = "lxml") -> Outcome:
    """Convenience wrapper: decode UTF-8 and parse, attaching the note.

    The note lives outside the parsed table (see module docstring), so it is
    applied here where the raw markup is still in hand.
    """
    raw = body.decode("utf-8", "replace")
    outcome = parse(raw, ticker=ticker, month=month, parser=parser)
    if outcome.row is not None:
        note = _extract_note(raw)
        if note:
            outcome.row["note"] = note
            # The hash covers `note`, so it must be set before the hash is taken.
            outcome.row["row_hash"] = row_hash(outcome.row)
    return outcome
