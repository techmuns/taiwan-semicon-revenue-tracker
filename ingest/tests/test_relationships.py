"""config/relationships.yaml and the TypeScript it generates.

Everything here guards one asymmetry: an entry in this file REMOVES REVENUE FROM
A HEADLINE TOTAL. Getting it wrong in the eager direction deletes a real company
from the universe figure, which is a worse failure than the double count the
file exists to correct - so every invariant gets a test that proves it actually
raises, not merely that the happy path parses.
"""

from __future__ import annotations

import textwrap

import pytest

from twrev.config import ConfigError, load_universe
from twrev import relationships as rel


@pytest.fixture(scope="module")
def universe():
    return load_universe()


def write(tmp_path, body: str):
    path = tmp_path / "relationships.yaml"
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


PAIR = """
    consolidation:
      - parent: "3231"
        child: "6669"
        treatment: consolidated
        as_of: "test fixture"
        evidence: control retained
    """


# ------------------------------------------------------------- the real file --


def test_repo_file_loads_and_excludes_wiwynn(universe):
    r = rel.load_relationships(universe=universe)
    assert r.excluded_from_aggregates == ("6669",)
    assert r.parent_of("6669") == "3231"


def test_cleared_pairs_are_not_excluded(universe):
    """TSMC/GUC is ~35% and equity method; Wistron/Wiwynn is ~35-40% and
    consolidated. The stake does not decide it, and only one is a double count."""
    r = rel.load_relationships(universe=universe)
    cleared = {c.child for c in r.cleared}
    assert "3443" in cleared
    assert "3443" not in r.excluded_from_aggregates


def test_generated_typescript_is_current(universe):
    """A stale generated file means the page and the config disagree about a
    number that is on screen. `twrev validate` runs this check; so does CI."""
    r = rel.load_relationships(universe=universe)
    assert rel.check_generated(r, universe) == []


def test_both_generated_copies_are_byte_identical(universe):
    """web/ and worker/ must de-duplicate the same set. Two copies that drifted
    would put a different total in the browser than in the stage aggregate."""
    r = rel.load_relationships(universe=universe)
    root = rel.repo_root()
    texts = {(root / p).read_text(encoding="utf-8") for p in rel.GENERATED_TS}
    assert len(texts) == 1


# ----------------------------------------------------------------- invariants --


def test_self_consolidation_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        consolidation:
          - parent: "3231"
            child: "3231"
            treatment: consolidated
            as_of: "test fixture"
            evidence: nonsense
        """)
    with pytest.raises(ConfigError, match="cannot consolidate itself"):
        rel.load_relationships(path, universe)


def test_two_parents_for_one_child_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        consolidation:
          - parent: "3231"
            child: "6669"
            treatment: consolidated
            as_of: "test fixture"
            evidence: a
          - parent: "2317"
            child: "6669"
            treatment: consolidated
            as_of: "test fixture"
            evidence: b
        """)
    with pytest.raises(ConfigError, match="consolidated into both"):
        rel.load_relationships(path, universe)


def test_cycle_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        consolidation:
          - parent: "3231"
            child: "6669"
            treatment: consolidated
            as_of: "test fixture"
            evidence: a
          - parent: "6669"
            child: "3231"
            treatment: consolidated
            as_of: "test fixture"
            evidence: b
        """)
    with pytest.raises(ConfigError, match="cycle"):
        rel.load_relationships(path, universe)


def test_equity_method_in_consolidation_is_rejected(tmp_path, universe):
    """The whole point of the file. An equity-method holding is NOT inside the
    parent's revenue, so excluding it would delete a real company from the total."""
    path = write(tmp_path, """
        consolidation:
          - parent: "2330"
            child: "3443"
            treatment: equity_method
            as_of: "test fixture"
            evidence: TSMC equity-methods GUC
        """)
    with pytest.raises(ConfigError, match="Only 'consolidated'"):
        rel.load_relationships(path, universe)


def test_untracked_ticker_is_rejected(tmp_path, universe):
    """A relationship with a company this tracker does not collect cannot cause
    a double count, so it must not be able to exclude anything either."""
    path = write(tmp_path, """
        consolidation:
          - parent: "9999"
            child: "6669"
            treatment: consolidated
            as_of: "test fixture"
            evidence: made up
        """)
    with pytest.raises(ConfigError, match="not in the universe"):
        rel.load_relationships(path, universe)


def test_same_pair_in_both_lists_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        consolidation:
          - parent: "3231"
            child: "6669"
            treatment: consolidated
            as_of: "test fixture"
            evidence: a
        cleared:
          - parent: "3231"
            child: "6669"
            treatment: equity_method
            as_of: "test fixture"
            evidence: b
        """)
    with pytest.raises(ConfigError, match="BOTH"):
        rel.load_relationships(path, universe)


def test_missing_evidence_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        consolidation:
          - parent: "3231"
            child: "6669"
            treatment: consolidated
        """)
    with pytest.raises(ConfigError, match="evidence"):
        rel.load_relationships(path, universe)


def test_empty_file_is_valid_and_excludes_nothing(tmp_path, universe):
    """No relationships is a legitimate state - it is what every other universe
    of companies would have - and must not be an error or a silent exclusion."""
    path = write(tmp_path, "consolidation: []\ncleared: []\n")
    r = rel.load_relationships(path, universe)
    assert r.excluded_from_aggregates == ()


# ----------------------------------------------------------------- generation --


def test_edges_are_within_the_universe_and_directional(universe):
    """An edge to an untracked company cannot be rendered against a filing, and a
    self-edge is meaningless. Direction matters: `supplies` is from -> to."""
    r = rel.load_relationships(universe=universe)
    known = set(universe.tickers)
    for e in r.edges:
        assert e.from_ticker in known and e.to_ticker in known
        assert e.from_ticker != e.to_ticker
        assert e.kind in ("supplies", "competes")
        assert e.confidence in ("high", "medium", "low")
        assert e.evidence


def test_no_edge_is_asserted_twice_in_the_same_direction(universe):
    """A duplicate would render as two rows saying the same thing, and would
    double whatever weight a future consumer gave the link."""
    r = rel.load_relationships(universe=universe)
    seen = [(e.kind, e.from_ticker, e.to_ticker) for e in r.edges]
    assert len(seen) == len(set(seen))


def test_no_edge_can_change_a_number(universe):
    """The invariant the whole edge feature rests on. Edges are a prompt to go
    and look; if one ever reached `excluded_from_aggregates` it would silently
    delete a company from the universe total."""
    r = rel.load_relationships(universe=universe)
    endpoints = {t for e in r.edges for t in (e.from_ticker, e.to_ticker)}
    assert endpoints, "expected at least one edge, or this test proves nothing"
    # The exclusion set is a function of `consolidation` ALONE. Edges name plenty
    # of companies - Wiwynn among them - and naming one must never exclude it.
    assert set(r.excluded_from_aggregates) == {c.child for c in r.consolidation}


def test_competitor_edges_are_not_recorded(universe):
    """Deliberate. Every competitor pair the research returned was two companies
    in the SAME bucket, which config/universe.yaml already encodes and every
    screen already shows. A second copy could only drift from the first."""
    r = rel.load_relationships(universe=universe)
    assert [e for e in r.edges if e.kind == "competes"] == []


def test_self_edge_is_rejected(tmp_path, universe):
    path = write(tmp_path, """
        supplies:
          - from: "2330"
            to: "2330"
            evidence: nonsense
        """)
    with pytest.raises(ConfigError, match="its own supplier"):
        rel.load_relationships(path, universe)


def test_duplicate_edge_is_rejected(tmp_path, universe):
    """Two rows saying the same thing, and double the weight for any future
    consumer that counts links."""
    path = write(tmp_path, """
        supplies:
          - from: "2330"
            to: "3443"
            evidence: a
          - from: "2330"
            to: "3443"
            evidence: b
        """)
    with pytest.raises(ConfigError, match="duplicate edge"):
        rel.load_relationships(path, universe)


def test_edge_confidence_must_be_a_known_level(tmp_path, universe):
    """Confidence is rendered on every row and is what separates "a source names
    the buyer" from "inferred from stage structure". An unrecognised level would
    render as neither."""
    path = write(tmp_path, """
        supplies:
          - from: "2330"
            to: "3443"
            confidence: certain
            evidence: a
        """)
    with pytest.raises(ConfigError, match="not high/medium/low"):
        rel.load_relationships(path, universe)


def test_render_is_deterministic(universe):
    r = rel.load_relationships(universe=universe)
    assert rel.render_ts(r, universe) == rel.render_ts(r, universe)


def test_render_names_the_parent_in_the_exclusion_comment(universe):
    """Someone reading the generated file must be able to see WHY a ticker is
    excluded without opening the YAML."""
    r = rel.load_relationships(universe=universe)
    ts = rel.render_ts(r, universe)
    assert '"6669",   // inside Wistron' in ts
    assert "EXCLUDED_FROM_AGGREGATES" in ts


def test_empty_relationships_generate_a_null_note(tmp_path, universe):
    path = write(tmp_path, "consolidation: []\n")
    ts = rel.render_ts(rel.load_relationships(path, universe), universe)
    assert "if (CONSOLIDATION.length === 0) return null;" in ts


# --------------------------------------------------------------------------
# The stage order and the supply edges describe the SAME chain, and until
# 2026-08 they disagreed about it completely.
#
# `sort_order` is file order in universe.yaml, and config.py says it exists so
# the dashboard renders stages "in supply-chain sequence". App.tsx repeated the
# claim and spelled the sequence out. Nothing checked it, and it was wrong:
# thermal, power and semi equipment were listed AFTER the stages they sell into,
# so every one of the 18 recorded edges ran backwards up the page. A reader
# taking the row order at face value would have concluded that fab equipment
# sits downstream of the servers it helps build.
#
# The edges are the authority here - each carries a citation to a 20-F or an
# annual report, while the ordering carried none - so the ordering moved.
# --------------------------------------------------------------------------

# TSMC ships wafers to ASE for packaging AND buys outsourced back-end capacity
# from it, so this pair points both ways at once and no linear order can hold
# it. Named rather than silently tolerated: a second exception appearing here
# means somebody should re-read the chain, not widen the allow-list.
BIDIRECTIONAL = {("3711", "2330")}


def test_stage_order_follows_the_supply_edges():
    u = load_universe()
    edges = rel.load_relationships().edges
    by_ticker = {c.ticker: c for c in u.companies}

    order: list[str] = []
    for c in sorted(u.companies, key=lambda x: x.sort_order):
        if c.bucket not in order:
            order.append(c.bucket)
    pos = {b: i for i, b in enumerate(order)}

    backwards = [
        (e.from_ticker, e.to_ticker)
        for e in edges
        if pos[by_ticker[e.from_ticker].bucket] > pos[by_ticker[e.to_ticker].bucket]
    ]
    unexpected = [p for p in backwards if p not in BIDIRECTIONAL]
    assert not unexpected, (
        "these edges run backwards against the stage order, so the dashboard "
        "renders a supplier below its own customer: "
        + ", ".join(
            f"{f} {by_ticker[f].display_name} [{by_ticker[f].bucket}] -> "
            f"{t} {by_ticker[t].display_name} [{by_ticker[t].bucket}]"
            for f, t in unexpected
        )
    )


def test_the_bidirectional_exception_still_exists():
    """If ASE -> TSMC is ever removed or reversed, BIDIRECTIONAL is stale and
    the test above silently permits a real inversion."""
    pairs = {(e.from_ticker, e.to_ticker) for e in rel.load_relationships().edges}
    assert BIDIRECTIONAL <= pairs, (
        f"BIDIRECTIONAL names {BIDIRECTIONAL - pairs}, which is no longer an "
        "edge. Drop it from the allow-list rather than leaving it to excuse "
        "some future inversion."
    )


def test_buckets_list_matches_the_order_the_companies_imply():
    """universe.yaml states the stage order twice - once in `buckets:` and once
    by the order companies appear. Two copies of one fact drift."""
    u = load_universe()
    implied: list[str] = []
    for c in sorted(u.companies, key=lambda x: x.sort_order):
        if c.bucket not in implied:
            implied.append(c.bucket)
    assert list(u.buckets) == implied, (
        f"`buckets:` says {list(u.buckets)}\nbut the company order implies {implied}"
    )


def test_every_pair_is_dated():
    """An accounting treatment is a fact about a date.

    TSMC's VIS holding is why this is required rather than optional: the record
    said `equity_method` flatly while its own evidence described a May 2026 sale
    that ends it, and the dashboard rendered the bare word to a reader in
    August. Neither field was wrong on its own - the pairing was.
    """
    r = rel.load_relationships()
    for c in (*r.consolidation, *r.cleared):
        assert c.as_of.strip(), f"{c.parent}->{c.child} has no as_of"


def test_as_of_is_required_not_defaulted(tmp_path, universe):
    """A default would let the next pair in be undated and look fine."""
    path = write(tmp_path, """
        consolidation: []
        cleared:
          - parent: "2330"
            child: "3443"
            treatment: equity_method
            stake: "34.84%"
            confidence: high
            evidence: some evidence
        """)
    with pytest.raises(ConfigError, match="as_of"):
        rel.load_relationships(path, universe)
