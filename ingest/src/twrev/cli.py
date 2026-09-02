"""Command-line entry point.

    python -m twrev.cli backfill --from 2025-12 --to 2026-07
    python -m twrev.cli backfill --from 2026-07 --to 2026-07 --tickers 2330,3324
    python -m twrev.cli report   --from 2025-12 --to 2026-07      (offline, cache only)
    python -m twrev.cli seed     --from 2025-12 --to 2026-07 --out ../out/seed.sql
    python -m twrev.cli show     --ticker 2330
    python -m twrev.cli refresh  --db data/pipeline.sqlite
    python -m twrev.cli export   --db data/pipeline.sqlite --out web/public/data
    python -m twrev.cli validate                                  (offline, config only)

`--tickers` is a real filter here: per-company fetches are independent, so
repairing one ticker-month costs exactly one request.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from . import backfill as bf
from . import roc
from .config import ConfigError, load_sources, load_universe, repo_root
from .http import CachedFetcher, utc_now_iso


def _window(args: argparse.Namespace) -> list[str]:
    months = roc.month_range(args.start, args.end)
    if not months:
        raise SystemExit(f"empty month range: {args.start}..{args.end}")
    return months


def _fetcher(args: argparse.Namespace, sources) -> CachedFetcher:
    cache_dir = Path(args.cache or (repo_root() / "ingest" / "cache"))
    cfg = sources.backfill
    return CachedFetcher(
        cache_dir,
        min_interval_s=args.min_interval if args.min_interval is not None else cfg.min_interval_s,
        timeout_s=cfg.timeout_s,
        max_attempts=cfg.max_attempts,
        backoff_s=cfg.backoff_s,
        offline=args.offline or None,
    )


# Missing cells tolerated before a refresh is called a failure. Three passes a
# month means a straggler normally lands on the next one; more than this many at
# once is a source problem, not a straggler.
MAX_SOFT_FAILURES = 3


def _print_report(report: bf.Report, universe, months: list[str],
                  tickers: list[str] | None = None) -> None:
    cov = bf.coverage(report.rows, universe, months, tickers)
    gaps = bf.contiguity_gaps(report.rows)

    print()
    print(f"  {report.summary()}")
    print(f"  coverage: {cov['present']}/{cov['cells']} cells ({cov['pct']}%)")

    if cov["missing_known_absent"]:
        by = sorted({t for t, _ in cov["missing_known_absent"]})
        print(f"  known-absent (expected, not a defect): {', '.join(by)} "
              f"x{len(cov['missing_known_absent'])} cells")
    if cov["missing_trackable"]:
        print(f"  MISSING {len(cov['missing_trackable'])} trackable cells:")
        for ticker, month in cov["missing_trackable"][:40]:
            print(f"    - {ticker} {month} ({universe[ticker].display_name})")
        if len(cov["missing_trackable"]) > 40:
            print(f"    ... and {len(cov['missing_trackable']) - 40} more")
    if gaps:
        print(f"  INTERIOR SERIES GAPS ({len(gaps)}) - these break MoM:")
        for ticker, before, after in gaps:
            print(f"    - {ticker}: {before} -> {after}")

    by_code: dict[str, list[dict]] = {}
    for f in report.findings:
        by_code.setdefault(f"{f['severity']}/{f['code']}", []).append(f)
    if by_code:
        print("  findings:")
        for code in sorted(by_code):
            items = by_code[code]
            print(f"    {code}: {len(items)}")
            if code.startswith(("error", "warn")):
                for f in items[:5]:
                    print(f"        {f['message'][:160]}")
    if report.failures:
        print(f"  RETRYABLE FAILURES ({len(report.failures)}):")
        for ticker, month, err in report.failures[:20]:
            print(f"    - {ticker} {month}: {err[:120]}")
        tick = ",".join(sorted({t for t, _, _ in report.failures}))
        print(f"  retry with: --tickers {tick}")


def cmd_backfill(args: argparse.Namespace) -> int:
    universe, sources = load_universe(), load_sources()
    months = _window(args)
    tickers = [t.strip() for t in args.tickers.split(",")] if args.tickers else None
    fetcher = _fetcher(args, sources)

    n = len(tickers or universe.tickers) * len(months)
    print(f"backfill {args.start}..{args.end} "
          f"({len(months)} months x {len(tickers or universe.tickers)} tickers = {n} cells)")
    print(f"  source : {sources.backfill.source_id} (the brief's per-company endpoint)")
    print(f"  cache  : {fetcher.cache_dir}")
    print(f"  offline: {fetcher.offline}   interval: {fetcher.min_interval_s}s")

    report = bf.run(
        universe=universe, sources=sources, fetcher=fetcher,
        months=months, tickers=tickers,
        force_refetch=args.force_refetch, progress=not args.quiet,
    )
    print(f"  http   : {fetcher.stats}")
    _print_report(report, universe, months, tickers)

    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(
            json.dumps(
                {"rows": report.rows, "findings": report.findings,
                 "fetch_log": report.fetch_log,
                 "failures": report.failures, "counts": report.counts},
                indent=2, ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"  wrote  : {args.json_out}")

    # Non-zero only for things a human must act on. A missing 6286 is not that.
    return 1 if (report.failures or bf.contiguity_gaps(report.rows)) else 0


def cmd_report(args: argparse.Namespace) -> int:
    """Re-parse the cache offline. Free, and proves the cache is self-sufficient."""
    args.offline = True
    args.force_refetch = False
    return cmd_backfill(args)


def cmd_verify(args: argparse.Namespace) -> int:
    """Read the refresh feeds and cross-check them against the cached MOPS rows.

    This is the only check that can distinguish "our parser is wrong" from "the
    data is odd": the per-company page and the OpenAPI feeds are two renderings
    of one filing, so their integer levels must be identical. Percentages are
    excluded from the comparison because both sides round to 2dp independently.
    """
    from . import openapi

    universe, sources = load_universe(), load_sources()
    fetcher = _fetcher(args, sources)
    results: list = []

    print(f"verify {args.month or 'latest published month'}")
    print(f"  feeds  : {len(sources.feeds)} in precedence order "
          f"(role 'specified' first, per the brief)")

    for feed in sources.feeds:
        try:
            fetched = fetcher.get(
                feed.url, openapi.cache_key(feed),
                validate=openapi.validate_body,
                force_refetch=args.force_refetch,
            )
        except Exception as err:  # a dead feed must not stop the others
            print(f"  {feed.source_id:18} FETCH FAILED  {type(err).__name__}: {err}")
            continue

        try:
            res = openapi.parse(fetched.body, feed=feed, universe=universe,
                                expect_month=args.month)
        except Exception as err:
            print(f"  {feed.source_id:18} PARSE FAILED  {type(err).__name__}: {err}")
            continue

        results.append(res)
        print(f"  {feed.source_id:18} {res.role:10} month={res.month} "
              f"records={res.records:>5} universe_hits={len(res.covered):>3} "
              f"{'(from cache)' if fetched.from_cache else ''}")
        for severity, code, message in res.findings:
            print(f"      [{severity}] {code}: {message[:180]}")

        # Re-file the snapshot under the month it turned out to describe, so the
        # audit trail is dated rather than perpetually overwritten as 'latest'.
        if res.month and not fetched.from_cache:
            fetcher.file_under(openapi.cache_key(feed, res.month), fetched)

    feed_rows = [r for res in results for r in res.rows]
    months = sorted({r["month"] for r in feed_rows})
    if not months:
        print("\n  no feed rows for any universe ticker - nothing to cross-check")
        return 1

    # Compare against the same months from the cached per-company scrape.
    fetcher.offline = True
    mops = bf.run(universe=universe, sources=sources, fetcher=fetcher,
                  months=months, tickers=None, progress=False)
    print(f"\n  cross-check vs {sources.backfill.source_id} on {months}: "
          f"{len(mops.rows)} mops rows vs {len(feed_rows)} feed rows")

    findings = openapi.compare(mops.rows, feed_rows)
    errors = [f for f in findings if f[0] == "error"]
    if not findings:
        print("  SOURCE_DISAGREEMENT: none - every shared level matches exactly")
    for severity, code, message in findings[:40]:
        print(f"    [{severity}] {code}: {message[:200]}")
    if len(findings) > 40:
        print(f"    ... and {len(findings) - 40} more")

    feed_errors = [f for res in results for f in res.findings if f[0] == "error"]
    return 1 if (errors or feed_errors) else 0


def cmd_seed(args: argparse.Namespace) -> int:
    from . import seed  # lazy: keeps backfill usable before the seeder exists

    universe, sources = load_universe(), load_sources()
    months = _window(args)
    fetcher = _fetcher(args, sources)
    fetcher.offline = True  # seeding must never depend on the network
    report = bf.run(
        universe=universe, sources=sources, fetcher=fetcher,
        months=months, tickers=None, progress=not args.quiet,
    )
    _print_report(report, universe, months)

    # Gate before writing. A seed that reproduces the golden numbers and passes
    # the units check is worth applying to D1; one that does not must not be
    # written at all, because the next step is a remote --file apply.
    problems = seed.golden_checks(report.rows)
    if problems and not args.force:
        print("\n  SEED REJECTED - golden checks failed:", file=sys.stderr)
        for p in problems:
            print(f"    - {p}", file=sys.stderr)
        print("  (--force writes it anyway)", file=sys.stderr)
        return 1
    if problems:
        print("\n  WARNING - writing despite failed golden checks:")
        for p in problems:
            print(f"    - {p}")
    else:
        print("  golden checks: pass (2330/2026-03 = 415,191,699; units sane)")

    out = Path(args.out or (repo_root() / "ingest" / "out" / "seed.sql")).resolve()
    sql = seed.build(universe=universe, report=report, sources=sources)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(sql, encoding="utf-8")
    print(f"  wrote {out} ({len(sql):,} bytes, {len(report.rows)} revenue rows)")

    try:
        rel = out.relative_to(repo_root())
    except ValueError:
        rel = out
    print("  apply with:")
    print(f"    sqlite3 data/pipeline.sqlite < {rel.as_posix()}")
    return 0



# ------------------------------------------------------- the durable state --
#
# The store of record is a SQLite file, and a SQLite file is a poor thing to
# keep in git: it is binary, it churns on every write, and a reviewer cannot see
# what a refresh changed. So the DURABLE form is JSONL - one row per line, keys
# sorted - and the database is rebuilt from it at the start of every run.
#
# Two tables matter and both are kept. raw_revenue is the filings. And
# raw_revenue_history is the RESTATEMENTS: the record of which filings a company
# later revised, written by a BEFORE UPDATE trigger in the migrations. That
# table, and the original first_seen_utc timestamps beside it, are the one part
# of this dataset that cannot be re-scraped - MOPS serves today's version of a
# filing, not the version it served in March. Losing them would quietly destroy
# the only evidence that a number ever changed.

STATE_TABLES = ("raw_revenue", "raw_revenue_history")


def _state_path(state_dir: str | Path, table: str) -> Path:
    return Path(state_dir).resolve() / f"{table}.jsonl"


def _load_state(conn, state_dir: str | None) -> int:
    """Restore prior rows into a freshly built store. Returns rows restored."""
    if not state_dir:
        return 0
    from . import store

    total = 0
    for table in STATE_TABLES:
        path = _state_path(state_dir, table)
        if not path.exists():
            continue
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not rows:
            continue
        if table == "raw_revenue":
            # Through the same upsert the scrape uses, so the row_hash gate and
            # the restatement trigger behave identically for restored rows.
            total += store.upsert_rows(conn, rows)
        else:
            cols = list(rows[0].keys())
            conn.executemany(
                f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' for _ in cols)})",
                [[r[c] for c in cols] for r in rows],
            )
            total += len(rows)
    conn.commit()
    return total


def _dump_state(db_path: Path, state_dir: str) -> int:
    """Write the store's durable tables back out as JSONL."""
    import sqlite3

    from . import store

    out = Path(state_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    conn = store.connect(db_path)
    conn.row_factory = sqlite3.Row
    total = 0
    try:
        for table in STATE_TABLES:
            rows = [dict(r) for r in conn.execute(
                f"SELECT * FROM {table} ORDER BY ticker, month_idx, source_id"
                if table == "raw_revenue" else f"SELECT * FROM {table}"
            )]
            # Sorted keys and a trailing newline: a refresh should diff as the
            # lines that actually changed, not as a whole-file rewrite.
            text = "".join(
                json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows
            )
            _state_path(out, table).write_text(text, encoding="utf-8")
            total += len(rows)
    finally:
        conn.close()
    return total


def cmd_refresh(args: argparse.Namespace) -> int:
    """Scrape the latest published month straight into the SQLite store.

    This is what GitHub Actions runs, and it is the whole pipeline: MOPS for
    every company, the OpenAPI feeds for a second opinion, both written to a
    SQLite file that IS the store of record.

    Why the store is a plain file rather than D1: the Worker's scheduled handler
    was never registered, because the Cloudflare account sits at the Workers Free
    ceiling of five cron triggers per account. A GitHub Actions schedule has no
    such cap - and no subrequest budget either, which is why this fetches MOPS
    for all 36 trackable names instead of repairing tier-1 only.

    Nothing here is new machinery. `store` already applies the real D1 migrations
    to SQLite and was used to prove the two engines agree: 296 company-months x
    12 columns, zero divergences. It was written as a test harness; this promotes
    it to production without changing a line of it.
    """
    from . import openapi, seed, store

    universe, sources = load_universe(), load_sources()
    month = args.month or roc.latest_expected_month()
    db_path = Path(args.db or (repo_root() / "data" / "pipeline.sqlite")).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    fresh = not db_path.exists()

    print(f"refresh {month}  ->  {db_path}")
    print(f"  store  : {'creating' if fresh else 'existing'} "
          f"({'-' if fresh else f'{db_path.stat().st_size:,} bytes'})")

    fetcher = _fetcher(args, sources)
    print(f"  cache  : {fetcher.cache_dir}   interval: {fetcher.min_interval_s}s")

    # ---------------------------------------------------------- MOPS scrape --
    report = bf.run(
        universe=universe, sources=sources, fetcher=fetcher,
        months=[month], tickers=None,
        run_id=f"refresh-{month}-{utc_now_iso()}",
        force_refetch=args.force_refetch, progress=not args.quiet,
    )
    # One retry pass for the cells that failed transiently.
    #
    # MOPS serves a block page on first contact and the real page on the retry -
    # `rejected` in the fetcher stats runs at roughly one per cell - so a company
    # that exhausts its five attempts is usually unlucky rather than broken, and
    # asking again a moment later costs one request and normally works.
    if report.failures:
        retry = sorted({t for t, _, _ in report.failures})
        print(f"  retry  : {len(retry)} cell(s) that failed transiently: {', '.join(retry)}")
        second = bf.run(
            universe=universe, sources=sources, fetcher=fetcher,
            months=[month], tickers=retry, run_id=report.run_id,
            force_refetch=True, progress=not args.quiet,
        )
        recovered = {r["ticker"] for r in second.rows}
        if recovered:
            print(f"  retry  : recovered {', '.join(sorted(recovered))}")
        report.rows.extend(second.rows)
        report.findings.extend(second.findings)
        report.fetch_log.extend(second.fetch_log)
        report.failures = [f for f in second.failures]

    print(f"  http   : {fetcher.stats}")
    _print_report(report, universe, [month])

    # ------------------------------------------------- feeds, as a 2nd source --
    #
    # Worth doing HERE and not in the Worker. The feeds partition the universe -
    # t187ap05_L carries 31 of our names, mopsfin_t187ap05_O the other 5, and a
    # company is listed or OTC but never both - and the Worker only ever reached
    # for MOPS on names the feeds had already missed. So no company-month was
    # ever carried by two sources and the cross-source check had nothing to
    # compare. Scraping every name via MOPS *and* reading the feeds gives the
    # same cell from two independent renderings of one filing, which is the only
    # way `openapi.compare` can actually catch a bad number.
    feed_rows: list[dict[str, Any]] = []
    if not args.skip_feeds:
        for feed in sources.feeds:
            try:
                fetched = fetcher.get(feed.url, openapi.cache_key(feed),
                                      validate=openapi.validate_body,
                                      force_refetch=args.force_refetch)
                res = openapi.parse(fetched.body, feed=feed, universe=universe,
                                    expect_month=month)
            except Exception as err:  # one dead feed must not fail the run
                print(f"  feed {feed.source_id:18} SKIPPED  {type(err).__name__}: {err}")
                report.findings.append({
                    "run_id": report.run_id, "created_at_utc": utc_now_iso(),
                    "severity": "warn", "code": "FEED_UNAVAILABLE", "month": month,
                    "ticker": None, "source_id": feed.source_id,
                    "message": f"{feed.source_id}: {type(err).__name__}: {err}"[:400],
                })
                continue
            print(f"  feed {feed.source_id:18} month={res.month} "
                  f"records={res.records:>5} universe_hits={len(res.covered):>3}")
            if res.month == month:
                feed_rows.extend(res.rows)
            for severity, code, message in res.findings:
                report.findings.append({
                    "run_id": report.run_id, "created_at_utc": utc_now_iso(),
                    "severity": severity, "code": code, "month": month,
                    "ticker": None, "source_id": feed.source_id, "message": message,
                })

    disagreements = []
    if feed_rows:
        disagreements = openapi.compare(report.rows, feed_rows)
        shared = {(r["ticker"], r["month"]) for r in report.rows} & \
                 {(r["ticker"], r["month"]) for r in feed_rows}
        print(f"  cross  : {len(shared)} company-months carried by two sources, "
              f"{len(disagreements)} disagreement(s)")
        for severity, code, message in disagreements:
            report.findings.append({
                "run_id": report.run_id, "created_at_utc": utc_now_iso(),
                "severity": severity, "code": code, "month": month,
                "ticker": None, "source_id": None, "message": message,
            })

    # ------------------------------------------------------------- persist --
    conn = store.connect(db_path)
    try:
        store.load_universe(conn, universe)          # YAML stays authoritative
        # Prior months, restored from the durable state before this month's rows
        # go in. The store is rebuilt from the migrations on every run, so
        # without this each refresh would hold ONE month and every year-on-year
        # figure in the export would be null. The state is JSONL and committed:
        # a month's refresh is then a reviewable diff rather than an opaque
        # write to a service nobody can see into.
        restored = _load_state(conn, args.state)
        if restored:
            print(f"  state  : restored {restored} row(s) from {args.state}")
        written = store.upsert_rows(conn, report.rows)
        store.insert_findings(conn, report.findings)
        store.insert_fetch_log(conn, report.fetch_log)
        store.assert_view_contract(conn)
        total = conn.execute("SELECT count(*) FROM raw_revenue").fetchone()[0]
        print(f"  wrote  : {written} rows for {month}; store now holds {total}")

        # Gate on the WHOLE store, not just this month - a refresh that corrupts
        # an older row is exactly as bad as one that writes a wrong new row, and
        # the golden numbers are the cheapest way to notice.
        all_rows = [dict(r) for r in conn.execute(
            "SELECT * FROM raw_revenue WHERE source_id = ?", (bf.mc.SOURCE_ID,))]
        # One assertion in the gate anchors on a reference cell, so it can only
        # speak when that cell is in scope - a single-month refresh legitimately
        # will not contain it. Only THAT assertion is waived. The units, type,
        # column-completeness and month_idx checks apply to any rows at all and
        # stay on, because waiving the whole set over an out-of-scope month is
        # how a units change would slip through unnoticed.
        gt, gm = seed.GOLDEN_KEY
        have_golden = any(r["ticker"] == gt and r["month"] == gm for r in all_rows)
        problems = seed.golden_checks(all_rows, require_golden_row=have_golden)
        if not have_golden:
            print(f"  golden : {gt}/{gm} not in scope; units, type and column "
                  f"checks still applied to {len(all_rows)} rows")
    finally:
        conn.close()

    if problems:
        print("\n  GOLDEN CHECKS FAILED:", file=sys.stderr)
        for p in problems:
            print(f"    - {p}", file=sys.stderr)
        if not args.force:
            print("  refusing the run (--force overrides)", file=sys.stderr)
            return 1
    elif have_golden:
        print("  golden : pass")

    # A cell that is still missing after the retry is not automatically a failed
    # run. The schedule fires on the 11th, 14th and 18th precisely because
    # Taiwanese filers trickle in and MOPS is intermittent; the later passes
    # exist to collect the stragglers. Failing the job on one flaky company
    # would cry wolf twice a month. Past MAX_SOFT_FAILURES it is no longer
    # flakiness, and a human should look.
    # --------------------------------------------------- the durable state --
    #
    # Where the D1 seed used to be. There is no database to apply anything to
    # any more: the store of record is data/pipeline.sqlite, and this writes it
    # back out as JSONL so it survives between runs and so a month's refresh
    # arrives as a diff somebody can read.
    #
    # Dumped AFTER the gates above, never before, so a run that fails its golden
    # checks cannot overwrite good state with bad.
    if args.state:
        n = _dump_state(db_path, args.state)
        print(f"  state  : wrote {n} row(s) to {args.state}")

    hard = [f for f in report.findings if f["severity"] == "error"
            and f["code"] != "FETCH_FAILED"]
    stragglers = sorted({t for t, _, _ in report.failures})
    if stragglers:
        print(f"\n  {len(stragglers)} cell(s) still missing after retry: "
              f"{', '.join(stragglers)}")
    if hard or len(stragglers) > MAX_SOFT_FAILURES:
        print(f"  FAILED: {len(stragglers)} missing cell(s), {len(hard)} error "
              f"finding(s)", file=sys.stderr)
        return 1
    if stragglers:
        print("  the next scheduled pass will pick them up")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    """Write the dashboard's data as static files.

    The Worker answered six endpoints out of D1 on every page load; it does not
    need to. The whole dataset is 296 rows - /api/analytics was 105 KB raw and
    10 KB gzipped - so the browser can hold all of it and filter locally, which
    takes the database out of the request path entirely.

    One endpoint is deliberately not exported. /api/heatmap aggregates over
    whatever filters are live, and ticker selection is an arbitrary subset of 37
    names, so its answers cannot be enumerated into files. That aggregation
    moves to the browser.
    """
    from . import export, store
    from .relationships import load_relationships

    universe, sources = load_universe(), load_sources()
    # The de-duplication pairs the heatmap needs. Passed explicitly rather than
    # defaulted, because an empty list is a valid configuration (no
    # consolidation) and is indistinguishable from having forgotten to load
    # them - and forgetting overstates every Rack / ODM figure by the whole of
    # Wiwynn's revenue, silently, with the members_* counts still describing
    # the de-duplicated set.
    consolidation = [(c.parent, c.child) for c in load_relationships().consolidation]
    db_path = Path(args.db or (repo_root() / "data" / "pipeline.sqlite")).resolve()
    if not db_path.exists():
        print(f"no store at {db_path} - run `refresh` first", file=sys.stderr)
        return 1
    out = Path(args.out or (repo_root() / "web" / "public" / "data")).resolve()

    conn = store.connect(db_path)
    try:
        store.assert_view_contract(conn)
        rows = conn.execute("SELECT count(*) FROM raw_revenue").fetchone()[0]
        written = export.write_all(
            conn, universe, sources, out, consolidation=consolidation
        )
    finally:
        conn.close()

    print(f"export {db_path}  ->  {out}")
    print(f"  store  : {rows} raw rows")
    print(f"  dedupe : {len(consolidation)} consolidation pair(s) applied")
    for name in ("meta.json", "analytics.json", "heatmap.json", "quality.json", "export.csv"):
        print(f"  {name:16} {written[name]:>9,} bytes")
    companies = sum(v for k, v in written.items() if k.startswith("company/"))
    print(f"  company/*.json   {companies:>9,} bytes over "
          f"{sum(1 for k in written if k.startswith('company/'))} files")
    print(f"  total  : {sum(written.values()):,} bytes in {len(written)} files")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Check every hand-edited config file, offline, in under a second.

    This is the command to run after editing `config/universe.yaml` - which is
    where a company's stage and tier live, and which the monthly seed rewrites
    wholesale into D1. An edit here is live on the dashboard after the next
    refresh, with no code change and no migration, so the thing standing between
    a typo and a wrong stage on the published site is this check.

    It also checks `config/relationships.yaml` and asserts the TypeScript it
    generates is not stale. That file removes revenue from a headline total, so
    a stale generated copy would mean the number on the page and the number the
    config describes have quietly diverged.
    """
    from . import relationships as rel_mod
    from . import segments as seg_mod

    problems: list[str] = []
    universe = load_universe()
    print(f"universe.yaml       : {len(universe)} companies, "
          f"{len(universe.trackable_tickers)} trackable, "
          f"{len(universe.buckets)} stages")

    # Every stage named on a company must be one of the declared buckets, and
    # every declared bucket should have at least one member - an empty stage
    # renders as a blank heatmap row that no filter can ever populate.
    empty = [b for b in universe.buckets if not any(c.bucket == b for c in universe)]
    for b in empty:
        problems.append(f"universe.yaml: stage {b!r} is declared but has no companies")

    sources = load_sources()
    print(f"sources.yaml        : {sources.backfill.source_id} + "
          f"{len(sources.feeds)} feed(s)")

    # ------------------------------------------------------------------------
    # The one thing migration 0002 says "must never drift":
    #
    #   "analytics_monthly's source-precedence CASE and this list have to agree,
    #    or the view would prefer a row the cron considers a fallback."
    #
    # Nothing enforced it. The CASE in 0001_init.sql is a hardcoded four-source
    # list ending in ELSE 9, so adding a feed to config/sources.yaml at position
    # 1 gives it precedence 1 in `source_feed` - the refresh treats it as the
    # highest-priority fallback and writes its rows - while the view ranks it
    # BELOW every named source and silently prefers the older row. The two
    # halves would disagree about which filing is authoritative, which is the
    # one disagreement that changes published numbers.
    #
    # Checked here rather than fixed in SQL on purpose: making the view read
    # `source_feed` would need a migration, and migrations are applied to D1 by
    # hand while everything else is automated - so a schema the tests had and
    # production did not is a worse failure than the drift. A config edit that
    # needs a matching SQL edit should simply fail CI, loudly, before either.
    expected = [sources.backfill.source_id] + [f.source_id for f in sources.feeds]
    case_sql = (repo_root() / "worker" / "migrations" / "0001_init.sql").read_text(
        encoding="utf-8"
    )
    start = case_sql.find("ORDER BY CASE r.source_id")
    arms = (
        re.findall(r"WHEN '([a-z0-9_]+)'\s+THEN\s+(\d+)",
                   case_sql[start:case_sql.find("END", start)])
        if start != -1
        else []
    )
    if not arms:
        problems.append(
            "could not find the source-precedence CASE in worker/migrations/"
            "0001_init.sql - it was restructured; re-check it against "
            "config/sources.yaml by hand"
        )
    else:
        ranked = [sid for sid, _ in sorted(arms, key=lambda a: int(a[1]))]
        print(f"  precedence          : {' > '.join(ranked)}")
        if ranked != expected:
            problems.append(
                "source precedence disagrees between config/sources.yaml and the "
                "CASE in worker/migrations/0001_init.sql:\n"
                f"      yaml : {' > '.join(expected)}\n"
                f"      sql  : {' > '.join(ranked)}\n"
                "    A source the YAML ranks first but the SQL does not name falls to "
                "ELSE 9 and loses to every named source, so the refresh and the view "
                "would disagree about which filing is authoritative."
            )

    rel = rel_mod.load_relationships(universe=universe)
    print(f"relationships.yaml  : {len(rel.consolidation)} consolidation, "
          f"{len(rel.cleared)} cleared, {len(rel.edges)} edges")
    for c in rel.consolidation:
        print(f"  excluded from sums: {c.child} ({c.parent} consolidates it)")

    segs = seg_mod.load_segments(universe=universe)
    print(f"segments.yaml       : {len(segs.definitions)} segment(s), "
          f"{segs.observation_count} observation(s)")
    for seg in segs.definitions:
        print(f"  {seg.key:<12} {len(seg.members)} member(s), "
              f"{sum(1 for o in segs.observations if o.segment == seg.key)} observation(s)")

    # The generated TypeScript is the only copy the browser and the Worker read,
    # so a stale file means the page and the config disagree about a number.
    if args.write:
        for path in (rel_mod.write_generated(rel, universe)
                     + seg_mod.write_generated(segs, universe)):
            print(f"generated           : wrote {path.relative_to(repo_root())}")
    else:
        stale = rel_mod.check_generated(rel, universe) + seg_mod.check_generated(segs, universe)
        for path in stale:
            problems.append(
                f"{path} is stale - re-run `python -m twrev.cli validate --write`"
            )
        if not stale:
            print("generated           : current")

    if problems:
        print("\nFAILED:", file=sys.stderr)
        for msg in problems:
            print(f"  - {msg}", file=sys.stderr)
        return 1
    print("\nall config valid")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    universe, sources = load_universe(), load_sources()
    company = universe[args.ticker]
    months = roc.month_range(args.start, args.end)
    fetcher = _fetcher(args, sources)
    fetcher.offline = True
    report = bf.run(
        universe=universe, sources=sources, fetcher=fetcher,
        months=months, tickers=[args.ticker], progress=False,
    )
    print(f"{company.ticker} {company.display_name} ({company.name_zh}) "
          f"| {company.bucket} | tier {company.tier} | {company.status}")
    print(f"{'month':<9}{'revenue':>15}{'yoy base':>15}{'yoy%':>9}"
          f"{'cum':>16}{'cum yoy%':>10}  note")
    # `show` is the break-glass command for a month that looks wrong, so it has
    # to survive the row that IS wrong. A None revenue_month - a cell MOPS left
    # blank - used to crash it twice over: once dividing by it for MoM, once
    # formatting None with a thousands separator. An em dash carries the same
    # meaning the rest of the project gives it, and never means zero.
    def num(value: Any, width: int, digits: int = 0) -> str:
        if value is None:
            return f"{'—':>{width}}"
        return f"{value:>{width},.{digits}f}" if digits else f"{value:>{width},}"

    prev = None
    for r in sorted(report.rows, key=lambda r: r["month"]):
        mom = ""
        if (
            prev
            and prev["month_idx"] == r["month_idx"] - 1
            and prev["revenue_month"]
            and r["revenue_month"] is not None
        ):
            mom = f"{100.0 * (r['revenue_month'] / prev['revenue_month'] - 1):+.1f}%"
        print(f"{r['month']:<9}{num(r['revenue_month'], 15)}{num(r['revenue_yoy_month'], 15)}"
              f"{num(r['src_yoy_pct'], 8, 2)}%{num(r['cum_revenue'], 16)}"
              f"{num(r['src_cum_yoy_pct'], 9, 2)}%  mom {mom:<8}{(r['note'] or '')[:50]}")
        prev = r
    if not report.rows:
        print("  (no rows - see findings)")
        for f in report.findings:
            print(f"  [{f['severity']}] {f['code']}: {f['message'][:150]}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="twrev", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp: argparse.ArgumentParser, *, window: bool = True) -> None:
        if window:
            sp.add_argument("--from", dest="start", required=True, metavar="YYYY-MM")
            sp.add_argument("--to", dest="end", required=True, metavar="YYYY-MM")
        sp.add_argument("--cache", default=None, help="cache dir (default ingest/cache)")
        sp.add_argument("--offline", action="store_true",
                        help="cache only; a miss is an error")
        sp.add_argument("--min-interval", type=float, default=None,
                        help="seconds between requests (default from sources.yaml)")
        sp.add_argument("--quiet", action="store_true")

    sp = sub.add_parser("backfill", help="fetch + parse a window")
    common(sp)
    sp.add_argument("--tickers", default=None, help="comma-separated subset")
    sp.add_argument("--force-refetch", action="store_true")
    sp.add_argument("--json-out", default=None)
    sp.set_defaults(func=cmd_backfill)

    sp = sub.add_parser("report", help="re-parse the cache offline and summarise")
    common(sp)
    sp.add_argument("--tickers", default=None)
    sp.add_argument("--json-out", default=None)
    sp.set_defaults(func=cmd_report, force_refetch=False)

    sp = sub.add_parser("verify", help="cross-check the refresh feeds vs the MOPS scrape")
    common(sp, window=False)
    sp.add_argument("--month", default=None, metavar="YYYY-MM",
                    help="month you expect the feeds to be publishing")
    sp.add_argument("--force-refetch", action="store_true")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("seed", help="emit seed SQL for the store, from the cache")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.add_argument("--force", action="store_true",
                    help="write the seed even if the golden checks fail")
    sp.set_defaults(func=cmd_seed)

    sp = sub.add_parser(
        "refresh",
        help="scrape the latest published month into the SQLite store (what CI runs)",
    )
    common(sp, window=False)
    sp.add_argument("--month", default=None, metavar="YYYY-MM",
                    help="override the month; default is the latest one due by the 10th")
    sp.add_argument("--db", default=None,
                    help="SQLite store path (default data/pipeline.sqlite)")
    sp.add_argument("--skip-feeds", action="store_true",
                    help="MOPS only; skips the OpenAPI cross-check")
    sp.add_argument("--force-refetch", action="store_true")
    sp.add_argument("--force", action="store_true",
                    help="persist even if the golden checks fail")
    sp.add_argument("--state", default=None, metavar="DIR",
                    help="durable JSONL state: restored before the scrape, "
                         "rewritten after the gates pass (default data/raw)")
    sp.set_defaults(func=cmd_refresh)

    sp = sub.add_parser("export", help="write the dashboard's data as static files")
    common(sp, window=False)
    sp.add_argument("--db", default=None,
                    help="SQLite store path (default data/pipeline.sqlite)")
    sp.add_argument("--out", default=None,
                    help="output directory (default web/public/data)")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser(
        "validate",
        help="check the hand-edited config files and the TypeScript they generate",
    )
    sp.add_argument("--write", action="store_true",
                    help="regenerate the TypeScript instead of asserting it is current")
    sp.set_defaults(func=cmd_validate)

    sp = sub.add_parser("show", help="print one ticker's series from the cache")
    sp.add_argument("--ticker", required=True)
    sp.add_argument("--from", dest="start", default="2025-12")
    sp.add_argument("--to", dest="end", default="2026-07")
    common(sp, window=False)
    sp.set_defaults(func=cmd_show)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as err:
        print(f"config error: {err}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted - the cache is intact; re-run to resume", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
