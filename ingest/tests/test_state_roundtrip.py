"""The durable state: SQLite -> JSONL -> SQLite, losing nothing.

The store of record is a SQLite file, and a SQLite file is a poor thing to keep
in git - binary, churning on every write, and unreadable in a diff. So the
durable form is JSONL and the database is rebuilt from it at the start of every
refresh. That rebuild is now load-bearing in a way the D1 seed never was: if it
loses rows, the store holds one month, and EVERY year-on-year figure in the
published export is null.

Two things must survive that nothing can re-fetch:

  raw_revenue_history - the restatements, written by a BEFORE UPDATE trigger in
  worker/migrations/0001_init.sql. It is the record of which filings a company
  later revised.

  first_seen_utc - when we first saw a figure. MOPS serves today's version of a
  filing, not the version it served in March, so a lost timestamp is lost for
  good and every "this was restated" claim loses its date.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from twrev import cli, store
from twrev.config import load_universe
from test_heatmap_sql import mk

MONTHS = ("2025-12", "2026-01", "2026-02")
DERIVED = (
    "revenue_twd_thousands", "mom_pct", "yoy_pct", "prior_month_yoy_pct",
    "yoy_acceleration_ppt", "cumulative_ytd_revenue_twd_thousands", "cumulative_yoy_pct",
)


@pytest.fixture
def seeded(tmp_path):
    """A store with three months for every trackable company."""
    universe = load_universe()
    db = tmp_path / "store.sqlite"
    conn = store.connect(db)
    store.load_universe(conn, universe)
    store.upsert_rows(conn, [
        mk(c.ticker, m, 10_000 + i * 100, 9_000)
        for i, c in enumerate(universe.companies) if c.ticker != "6286"
        for m in MONTHS
    ])
    conn.commit()
    conn.close()
    return db, universe, tmp_path


def test_a_store_rebuilt_from_jsonl_is_indistinguishable(seeded):
    """Every derived column, on every company-month, identical."""
    db, universe, tmp = seeded
    state = tmp / "raw"
    assert cli._dump_state(db, str(state)) > 0

    rebuilt = tmp / "rebuilt.sqlite"
    conn = store.connect(rebuilt)
    store.load_universe(conn, universe)
    cli._load_state(conn, str(state))

    original = store.connect(db)
    before = {(r["ticker"], r["month"]): dict(r) for r in store.analytics_monthly(original)}
    after = {(r["ticker"], r["month"]): dict(r) for r in store.analytics_monthly(conn)}
    assert set(before) == set(after), "a company-month was lost in the round trip"
    for key in before:
        for col in DERIVED:
            assert before[key][col] == after[key][col], f"{key} {col} changed"
    original.close()
    conn.close()


def test_first_seen_utc_survives(seeded):
    """It cannot be re-derived: MOPS serves today's filing, not March's."""
    db, universe, tmp = seeded
    state = tmp / "raw"
    cli._dump_state(db, str(state))

    original = store.connect(db)
    want = {(r["ticker"], r["month"], r["source_id"]): r["first_seen_utc"]
            for r in original.execute(
                "SELECT ticker, month, source_id, first_seen_utc FROM raw_revenue")}
    original.close()

    conn = store.connect(tmp / "rebuilt.sqlite")
    store.load_universe(conn, universe)
    cli._load_state(conn, str(state))
    got = {(r["ticker"], r["month"], r["source_id"]): r["first_seen_utc"]
           for r in conn.execute(
               "SELECT ticker, month, source_id, first_seen_utc FROM raw_revenue")}
    conn.close()
    assert got == want, "first_seen_utc was rewritten by the restore"


def test_the_restatement_table_is_part_of_the_state(seeded):
    """raw_revenue_history is dumped even when empty, because the day it is not
    empty is the day it matters, and a state format that only carries it
    sometimes is one that loses it silently."""
    db, _, tmp = seeded
    state = tmp / "raw"
    cli._dump_state(db, str(state))
    assert (state / "raw_revenue_history.jsonl").exists()
    assert "raw_revenue_history" in cli.STATE_TABLES


def test_jsonl_is_line_per_row_with_sorted_keys(seeded):
    """A refresh should diff as the lines that changed, not as a whole-file
    rewrite - which is the entire reason this is JSONL and not a .sqlite blob."""
    db, _, tmp = seeded
    state = tmp / "raw"
    cli._dump_state(db, str(state))
    lines = (state / "raw_revenue.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) > 1
    for line in lines[:5]:
        parsed = json.loads(line)
        assert list(parsed) == sorted(parsed), "keys must be sorted or every line churns"


def test_loading_no_state_is_not_an_error(tmp_path):
    """A first run has nothing to restore. It must build an empty store, not
    crash - the alternative is a bootstrap that can never happen."""
    conn = store.connect(tmp_path / "empty.sqlite")
    store.load_universe(conn, load_universe())
    assert cli._load_state(conn, str(tmp_path / "nothing-here")) == 0
    assert cli._load_state(conn, None) == 0
    conn.close()


def test_restoring_twice_converges(seeded):
    """The refresh restores then writes back every run. If that were not
    idempotent the state would grow or drift with each month."""
    db, universe, tmp = seeded
    state = tmp / "raw"
    cli._dump_state(db, str(state))
    first = (state / "raw_revenue.jsonl").read_text(encoding="utf-8")

    conn = store.connect(tmp / "again.sqlite")
    store.load_universe(conn, universe)
    cli._load_state(conn, str(state))
    cli._load_state(conn, str(state))          # twice, deliberately
    conn.commit()
    conn.close()

    cli._dump_state(tmp / "again.sqlite", str(tmp / "raw2"))
    assert (tmp / "raw2" / "raw_revenue.jsonl").read_text(encoding="utf-8") == first
