"""The backfill runner: fetch and parse every (ticker, month) in the window.

Resumable by construction - the fetcher caches raw bytes, so an interrupted run
re-fetches only what is missing. A second run over a warm cache is offline-fast
and produces byte-identical rows, which is what makes the parse loop safe to
iterate on.

Failures are per-cell, never fatal to the run. One company timing out must not
cost the other 295 requests; it is recorded in `fetch_log` and reported at the
end so it can be retried on its own.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from . import mops_company as mc
from . import roc
from .config import Sources, Universe
from .http import CachedFetcher, FetchError, utc_now_iso


@dataclass
class Report:
    """Everything one backfill run produced, for seeding and for review."""
    # Identifies this run in quality_findings, and is what makes re-applying the
    # same generated seed file idempotent rather than duplicating findings.
    run_id: str = ""
    rows: list[dict[str, Any]] = field(default_factory=list)
    findings: list[dict[str, Any]] = field(default_factory=list)
    fetch_log: list[dict[str, Any]] = field(default_factory=list)
    # (ticker, month, error) - cells that produced neither a row nor a
    # recognised empty answer. These are the only ones worth retrying.
    failures: list[tuple[str, str, str]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def bump(self, key: str) -> None:
        self.counts[key] = self.counts.get(key, 0) + 1

    def summary(self) -> str:
        parts = [f"{k}={v}" for k, v in sorted(self.counts.items())]
        return (
            f"rows={len(self.rows)} findings={len(self.findings)} "
            f"failures={len(self.failures)} " + " ".join(parts)
        )


def run(
    *,
    universe: Universe,
    sources: Sources,
    fetcher: CachedFetcher,
    months: Iterable[str],
    tickers: Iterable[str] | None = None,
    run_id: str | None = None,
    force_refetch: bool = False,
    progress: bool = True,
) -> Report:
    cfg = sources.backfill
    months = list(months)
    # Universe order, not caller order, so cache layout and logs are stable.
    wanted = set(tickers) if tickers else None
    targets = [c.ticker for c in universe if wanted is None or c.ticker in wanted]
    if wanted:
        unknown = wanted - set(universe.tickers)
        if unknown:
            raise ValueError(f"not in universe: {sorted(unknown)}")

    run_id = run_id or f"backfill-{utc_now_iso()}"
    report = Report(run_id=run_id)
    total = len(targets) * len(months)
    started = time.monotonic()
    done = 0

    def emit(severity: str, code: str, month: str, ticker: str, message: str) -> None:
        report.findings.append({
            "run_id": run_id, "created_at_utc": utc_now_iso(),
            "severity": severity, "code": code, "month": month,
            "ticker": ticker, "source_id": mc.SOURCE_ID, "message": message,
        })

    # Month-major so a partial run leaves whole months complete rather than a
    # ragged edge across every company - much easier to reason about mid-flight.
    for month in months:
        for ticker in targets:
            done += 1
            url = mc.url_for(ticker, month, cfg.url_template)
            key = mc.cache_key(ticker, month)
            company = universe[ticker]

            try:
                result = fetcher.get(
                    url, key,
                    validate=lambda b: mc.validate_body(b, min_bytes=cfg.min_body_bytes),
                    force_refetch=force_refetch,
                )
            except FetchError as err:
                report.bump("fetch_failed")
                report.failures.append((ticker, month, f"{type(err).__name__}: {err}"))
                report.fetch_log.append({
                    "source_id": mc.SOURCE_ID, "month": month, "ticker": ticker,
                    "url": url,
                    "http_status": None, "byte_len": None, "sha256": None,
                    "rows_parsed": 0, "ok": 0, "error": str(err)[:500],
                    "fetched_at_utc": utc_now_iso(),
                })
                emit("error", "FETCH_FAILED", month, ticker, str(err)[:400])
                _tick(progress, done, total, started, ticker, month, "FETCH FAIL")
                continue

            try:
                outcome = mc.parse_from_bytes(result.body, ticker=ticker, month=month)
            except Exception as err:
                # Parse errors are structural. Never persist; always surface.
                report.bump("parse_failed")
                report.failures.append((ticker, month, f"{type(err).__name__}: {err}"))
                report.fetch_log.append({
                    "source_id": mc.SOURCE_ID, "month": month, "ticker": ticker,
                    "url": url,
                    "http_status": result.http_status, "byte_len": result.byte_len,
                    "sha256": result.sha256, "rows_parsed": 0, "ok": 0,
                    "error": f"{type(err).__name__}: {err}"[:500],
                    "fetched_at_utc": result.fetched_at_utc,
                })
                emit("error", "PARSE_FAILED", month, ticker,
                     f"{type(err).__name__}: {err}"[:400])
                _tick(progress, done, total, started, ticker, month, "PARSE FAIL")
                continue

            for severity, code, message in outcome.findings:
                # 6286's absence is a known, decided-upon fact, not news. Keep it
                # as info so it stays visible without polluting the error count.
                if code == "NOT_AN_ISSUER" and not company.trackable:
                    severity = "info"
                emit(severity, code, month, ticker, message)

            if outcome.row is not None:
                now = utc_now_iso()
                outcome.row["first_seen_utc"] = now
                outcome.row["last_seen_utc"] = now
                report.rows.append(outcome.row)
                report.bump("rows")
            else:
                report.bump(outcome.status)

            report.fetch_log.append({
                "source_id": mc.SOURCE_ID, "month": month, "ticker": ticker,
                "url": url,
                "http_status": result.http_status, "byte_len": result.byte_len,
                "sha256": result.sha256,
                "rows_parsed": 1 if outcome.row is not None else 0,
                "ok": 1, "error": None, "fetched_at_utc": result.fetched_at_utc,
            })
            report.bump("cache_hit" if result.from_cache else "network")
            _tick(progress, done, total, started, ticker, month, outcome.status)

    return report


def _tick(
    enabled: bool, done: int, total: int, started: float,
    ticker: str, month: str, status: str,
) -> None:
    """Single-line progress. A 15-20 minute silent run is indistinguishable from a hang."""
    if not enabled:
        return
    elapsed = time.monotonic() - started
    rate = done / elapsed if elapsed > 0 else 0
    eta = (total - done) / rate if rate > 0 else 0
    sys.stderr.write(
        f"\r  [{done:>4}/{total}] {ticker} {month} {status:<14} "
        f"eta {eta / 60:5.1f}m  "
    )
    sys.stderr.flush()
    if done == total:
        sys.stderr.write("\n")


def expected_cells(universe: Universe, months: list[str]) -> int:
    return len(universe) * len(months)


def coverage(
    rows: list[dict[str, Any]],
    universe: Universe,
    months: list[str],
    tickers: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Which (ticker, month) cells are missing, split by whether that is expected.

    `tickers` scopes the expectation to the set actually requested - otherwise a
    deliberately narrow `--tickers` run reports the entire universe as missing.

    6286 is separated out rather than counted as a gap: keeping it in the universe
    with an explicit "no data" state was a deliberate decision, so it must not
    show up as a defect every run.
    """
    scope = set(tickers) if tickers else set(universe.tickers)
    companies = [c for c in universe if c.ticker in scope]
    have = {(r["ticker"], r["month"]) for r in rows}
    missing_trackable: list[tuple[str, str]] = []
    missing_known: list[tuple[str, str]] = []
    for company in companies:
        for month in months:
            if (company.ticker, month) in have:
                continue
            (missing_trackable if company.trackable else missing_known).append(
                (company.ticker, month)
            )
    cells = len(companies) * len(months)
    return {
        "cells": cells,
        "present": len(have),
        "missing_trackable": missing_trackable,
        "missing_known_absent": missing_known,
        "pct": round(100.0 * len(have) / cells, 1) if cells else 0.0,
    }


def contiguity_gaps(rows: list[dict[str, Any]]) -> list[tuple[str, str, str]]:
    """Interior holes in a ticker's series, which break MoM silently.

    Returns (ticker, month_before_gap, month_after_gap). Trailing absence is not
    a gap - that is a delisting or an unpublished month, handled elsewhere.
    """
    by_ticker: dict[str, list[int]] = {}
    for r in rows:
        by_ticker.setdefault(r["ticker"], []).append(r["month_idx"])
    out: list[tuple[str, str, str]] = []
    for ticker, idxs in by_ticker.items():
        ordered = sorted(idxs)
        for a, b in zip(ordered, ordered[1:]):
            if b - a > 1:
                out.append((ticker, roc.month_from_idx(a), roc.month_from_idx(b)))
    return out
