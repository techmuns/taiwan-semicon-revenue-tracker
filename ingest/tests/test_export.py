"""The static export, where it can silently disagree with the Worker.

`ingest/tools/check_export_parity.py` diffs the whole export against the live
API, which is the real guarantee - but it needs the network, so it is a tool and
not a test, and it SKIPS the `alerts` block. These are the two places inside
that blind spot where the two implementations have already drifted or could.
"""

from __future__ import annotations

import pytest

from twrev import export, store
from twrev.config import load_sources, load_universe


@pytest.fixture
def conn():
    c = store.connect()
    store.load_universe(c, load_universe())
    yield c
    c.close()


def add_finding(conn, severity, code, month):
    conn.execute(
        "INSERT INTO quality_findings"
        " (run_id, created_at_utc, severity, code, month, ticker, source_id, message)"
        " VALUES ('run', '2026-08-21T00:00:00Z', ?, ?, ?, '2330', 'mops_company', 'msg')",
        (severity, code, month),
    )


def test_severe_total_is_not_the_capped_list_length(conn):
    """The alert strip prints this number.

    The list is capped at 20 so a bad month cannot ship a thousand-line strip.
    Rendering that capped list's LENGTH as the count said "20 open findings"
    when there were 25 - understating a data-quality problem, which is the one
    direction it must never be wrong in.
    """
    for i in range(25):
        add_finding(conn, "warn" if i else "error", "CODE", f"2026-{(i % 12) + 1:02d}")
    conn.commit()

    alerts = export.build_meta(conn, load_universe(), load_sources())["alerts"]
    assert len(alerts["severe_findings"]) == 20, "the list stays capped"
    assert alerts["severe_total"] == 25, "the count must not be"


def test_severe_total_counts_only_error_and_warn(conn):
    """`info` findings are per-company colour - the consolidated-basis and
    no-filing-obligation notes - and are already stated on the company itself.
    Counting them here would put a permanent non-zero alert on every screen."""
    add_finding(conn, "error", "A", "2026-01")
    add_finding(conn, "warn", "B", "2026-01")
    add_finding(conn, "info", "CONSOLIDATED_BASIS", "2026-01")
    conn.commit()
    alerts = export.build_meta(conn, load_universe(), load_sources())["alerts"]
    assert alerts["severe_total"] == 2


def test_no_findings_is_zero_not_absent(conn):
    alerts = export.build_meta(conn, load_universe(), load_sources())["alerts"]
    assert alerts["severe_total"] == 0
    assert alerts["severe_findings"] == []


@pytest.mark.parametrize(
    "value, want",
    [
        (17.0, 17),      # the live bug: Python wrote "17.0", JavaScript writes "17"
        (17.5, 17.5),
        (-0.0, 0),
        (0.0, 0),
        (None, None),
        (415191699, 415191699),
        ("2026-01", "2026-01"),
    ],
)
def test_js_number_matches_javascript_string_conversion(value, want):
    """CSV formatting is part of the contract - it is a file someone downloads
    and diffs month to month. An integral float rendered as `17.0` where the
    Worker writes `17` made every month's export churn against the last."""
    assert export._js_number(value) == want


def test_csv_fixture_is_identical_in_both_languages():
    """The other half of a two-language byte contract.

    web/fixtures/export-parity.csv is asserted by web/scripts/check-dataset.mjs
    to equal what web/src/csv.ts produces. This asserts it also equals what this
    module produces. Neither implementation can drift without one of the two
    failing - which matters because the CSV is a documented deliverable that
    somebody diffs month to month, and because these two HAVE diverged before:
    Python wrote an integral float as "17.0" where JavaScript wrote "17", found
    on 6147 / 2026-01.

    If this fails after a deliberate format change, regenerate the fixture with
    export.rows_to_csv and let the JS assertion re-verify the other side.
    """
    import json
    from pathlib import Path

    from twrev import export

    fixtures = Path(__file__).resolve().parents[2] / "web" / "fixtures"
    rows = json.loads((fixtures / "export-parity.json").read_text(encoding="utf-8"))
    # newline="" or Python's universal-newline translation turns the file's
    # CRLF into LF on the way in and the comparison fails for a reason that has
    # nothing to do with either writer. Node's readFileSync does no such
    # translation, which is why the JS side saw the bytes correctly and this
    # side did not.
    with open(fixtures / "export-parity.csv", encoding="utf-8", newline="") as fh:
        expected = fh.read()
    assert export.rows_to_csv(rows) == expected, (
        "export.py and the committed fixture disagree. web/src/csv.ts is asserted "
        "against that same fixture, so one of the two CSV writers has drifted."
    )
