"""config/segments.yaml - named slices, and the guard on segment-level figures.

The point these tests defend is the one the file itself opens with: a segment
here is a SET OF COMPANIES, and its figure is those companies' TOTAL revenue,
not their revenue in that segment. Nothing in the monthly filing carries a
product split. So `basis` is mandatory, an `observation` without a source is
rejected, and the observations list is expected to be empty - an empty list is
the truthful state, and a test asserts it rather than leaving it to drift.
"""

from __future__ import annotations

import textwrap

import pytest

from twrev.config import ConfigError, load_universe
from twrev import segments as seg


@pytest.fixture(scope="module")
def universe():
    return load_universe()


def write(tmp_path, body: str):
    path = tmp_path / "segments.yaml"
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


VALID = """
    segments:
      - key: hpc
        label: High-performance compute
        basis: Total revenue of the members, not their HPC revenue.
        members: ["2330", "3231"]
    """


# ------------------------------------------------------------- the real file --


def test_repo_file_loads(universe):
    s = seg.load_segments(universe=universe)
    assert [d.key for d in s.definitions] == ["hpc"]
    assert len(s["hpc"].members) >= 2


def test_every_member_is_in_the_universe(universe):
    s = seg.load_segments(universe=universe)
    known = set(universe.tickers)
    for d in s.definitions:
        assert set(d.members) <= known


def test_observations_are_empty(universe):
    """Not a placeholder assertion. No source in this pipeline carries a segment
    split, so any row here would have been typed in from a document - and if one
    ever is, this test should fail and be updated deliberately, with the source
    read, rather than a figure appearing on the dashboard unnoticed."""
    assert seg.load_segments(universe=universe).observations == ()


def test_generated_typescript_is_current(universe):
    s = seg.load_segments(universe=universe)
    assert seg.check_generated(s, universe) == []


def test_basis_reaches_the_generated_file(universe):
    """The caveat is the difference between a true statement and a false one, so
    it must survive into the only copy the browser reads."""
    s = seg.load_segments(universe=universe)
    ts = seg.render_ts(s, universe)
    assert "not their HPC-only revenue" in ts
    assert "basis:" in ts


# ----------------------------------------------------------------- invariants --


def test_missing_basis_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        segments:
          - key: hpc
            label: High-performance compute
            members: ["2330", "3231"]
        """)
    with pytest.raises(ConfigError, match="basis"):
        seg.load_segments(path, universe)


def test_unknown_member_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        segments:
          - key: hpc
            label: HPC
            basis: total revenue of members
            members: ["2330", "9999"]
        """)
    with pytest.raises(ConfigError, match="not in config/universe.yaml"):
        seg.load_segments(path, universe)


def test_duplicate_member_is_rejected(tmp_path, universe):
    """A member listed twice would be summed twice - the same class of error the
    consolidation de-duplication exists to prevent, arriving by a different door."""
    path = write(tmp_path, """
        segments:
          - key: hpc
            label: HPC
            basis: total revenue of members
            members: ["2330", "2330", "3231"]
        """)
    with pytest.raises(ConfigError, match="more than once"):
        seg.load_segments(path, universe)


def test_single_member_segment_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        segments:
          - key: solo
            label: Solo
            basis: total revenue of members
            members: ["2330"]
        """)
    with pytest.raises(ConfigError, match="at least two members"):
        seg.load_segments(path, universe)


def test_bad_key_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        segments:
          - key: "High Performance"
            label: HPC
            basis: total revenue of members
            members: ["2330", "3231"]
        """)
    with pytest.raises(ConfigError, match="lowercase"):
        seg.load_segments(path, universe)


def test_duplicate_keys_are_rejected(tmp_path, universe):
    path = write(tmp_path, """
        segments:
          - key: hpc
            label: One
            basis: total revenue of members
            members: ["2330", "3231"]
          - key: hpc
            label: Two
            basis: total revenue of members
            members: ["2382", "2317"]
        """)
    with pytest.raises(ConfigError, match="duplicate segment key"):
        seg.load_segments(path, universe)


def test_observation_without_a_source_is_rejected(tmp_path, universe):
    path = write(tmp_path, VALID + """
    observations:
      - ticker: "2330"
        segment: hpc
        period: 2026-Q1
        share_pct: 60
        as_of: 2026-05-01
""")
    with pytest.raises(ConfigError, match="source"):
        seg.load_segments(path, universe)


def test_observation_with_a_bad_period_is_rejected(tmp_path, universe):
    """Segment splits are quarterly and monthly revenue is not. A quarterly
    figure written as a month would be silently compared against one."""
    path = write(tmp_path, VALID + """
    observations:
      - ticker: "2330"
        segment: hpc
        period: Q1-2026
        share_pct: 60
        source: https://example.invalid/filing
        as_of: 2026-05-01
""")
    with pytest.raises(ConfigError, match="YYYY-MM or YYYY-Qn"):
        seg.load_segments(path, universe)


def test_observation_needs_a_figure(tmp_path, universe):
    path = write(tmp_path, VALID + """
    observations:
      - ticker: "2330"
        segment: hpc
        period: 2026-Q1
        source: https://example.invalid/filing
        as_of: 2026-05-01
""")
    with pytest.raises(ConfigError, match="share_pct or revenue"):
        seg.load_segments(path, universe)


def test_observation_for_an_undefined_segment_is_rejected(tmp_path, universe):
    path = write(tmp_path, VALID + """
    observations:
      - ticker: "2330"
        segment: automotive
        period: 2026-Q1
        share_pct: 12
        source: https://example.invalid/filing
        as_of: 2026-05-01
""")
    with pytest.raises(ConfigError, match="not defined above"):
        seg.load_segments(path, universe)


def test_a_valid_observation_is_accepted(tmp_path, universe):
    """The shape someone will have to type when the sourcing work is done."""
    path = write(tmp_path, VALID + """
    observations:
      - ticker: "2330"
        segment: hpc
        period: 2026-Q1
        share_pct: 59.4
        source: "TSMC 2026 Q1 consolidated statements, segment note"
        as_of: 2026-05-01
""")
    s = seg.load_segments(path, universe)
    assert s.observation_count == 1
    assert s.observations[0].share_pct == 59.4
    assert s.observations[0].revenue_twd_thousands is None


def test_render_is_deterministic(universe):
    s = seg.load_segments(universe=universe)
    assert seg.render_ts(s, universe) == seg.render_ts(s, universe)
