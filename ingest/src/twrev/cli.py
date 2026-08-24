"""Command-line entry point.

    python -m twrev.cli backfill --from 2025-12 --to 2026-07
    python -m twrev.cli backfill --from 2026-07 --to 2026-07 --tickers 2330,3324
    python -m twrev.cli report   --from 2025-12 --to 2026-07      (offline, cache only)
    python -m twrev.cli seed     --from 2025-12 --to 2026-07 --out ../out/seed.sql
    python -m twrev.cli show     --ticker 2330

`--tickers` is a real filter here: per-company fetches are independent, so
repairing one ticker-month costs exactly one request.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import backfill as bf
from . import roc
from .config import ConfigError, load_sources, load_universe, repo_root
from .http import CachedFetcher


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
    print("  apply with (from worker/):")
    print(f"    npx wrangler d1 execute taiwan-semicon-revenue --remote "
          f"--file=../{rel.as_posix()}")
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

    sp = sub.add_parser("seed", help="emit D1 seed SQL from the cache")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.add_argument("--force", action="store_true",
                    help="write the seed even if the golden checks fail")
    sp.set_defaults(func=cmd_seed)

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
