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
