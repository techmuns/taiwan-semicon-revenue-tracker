"""Trim the cached OpenAPI snapshots into committable test fixtures.

The live feeds are 150KB-600KB each (1.25MB for all three), which is too much to
commit and too slow to re-read in every test. But the fixtures must still be
REAL BYTES, not hand-written JSON - the whole reason the MOPS parser had three
separate bugs is that no hand-written fixture would have contained the actual
quirks.

So this keeps every record for a universe ticker verbatim, plus a few
non-universe records, and drops the rest. What survives is unmodified source
bytes; only the record count changes.

The non-universe records are kept deliberately, for two reasons:
  * they prove the ticker filter actually filters, rather than the fixture simply
    containing nothing to reject;
  * for `_P`, which covers none of our 37, they are the ONLY records - so the
    SOURCE_EMPTY path is exercised against a realistic body rather than an empty
    array (which validate_body would reject outright).

A sidecar records the original record count, because a trimmed fixture will trip
RECORD_COUNT_LOW and a reader needs to know that is an artifact of trimming
rather than a partially-published feed.

Usage (after a `verify` run has populated the cache):

    PYTHONPATH=ingest/src python ingest/tools/make_openapi_fixtures.py --month 2026-07
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from twrev import openapi
from twrev.config import load_sources, load_universe, repo_root

# Enough to prove the filter works without bloating the fixture.
NON_UNIVERSE_KEEP = 6


def trim(body: bytes, wanted: set[str], keep_others: int) -> tuple[bytes, dict]:
    payload = json.loads(body.decode("utf-8"))
    kept: list[dict] = []
    others = 0
    for record in payload:
        ticker = str(record.get("公司代號", "")).strip()
        if ticker in wanted:
            kept.append(record)
        elif others < keep_others:
            kept.append(record)
            others += 1
    # ensure_ascii=False keeps the Chinese keys readable in the committed file -
    # a fixture you cannot read by eye is a fixture nobody checks.
    out = json.dumps(kept, ensure_ascii=False, indent=1).encode("utf-8")
    return out, {
        "original_records": len(payload),
        "kept_records": len(kept),
        "universe_records": len(kept) - others,
        "non_universe_records": others,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--month", required=True, metavar="YYYY-MM",
                    help="the month whose cached snapshot to trim")
    ap.add_argument("--cache", default=None)
    args = ap.parse_args(argv)

    root = repo_root()
    universe, sources = load_universe(), load_sources()
    cache_dir = Path(args.cache or (root / "ingest" / "cache"))
    fixtures = root / "ingest" / "tests" / "fixtures" / "openapi"
    fixtures.mkdir(parents=True, exist_ok=True)
    wanted = set(universe.tickers)

    written = 0
    for feed in sources.feeds:
        src = cache_dir / openapi.cache_key(feed, args.month)
        if not src.is_file():
            print(f"  {feed.source_id:18} SKIP - no cache entry at {src}",
                  file=sys.stderr)
            continue
        body, stats = trim(src.read_bytes(), wanted, NON_UNIVERSE_KEEP)

        name = f"{feed.source_id}_{args.month.replace('-', '')}"
        (fixtures / f"{name}.json").write_bytes(body)
        (fixtures / f"{name}.trim.json").write_text(
            json.dumps({"source_id": feed.source_id, "month": args.month,
                        "source_url": feed.url, **stats,
                        "note": "trimmed from the live snapshot; records are "
                                "verbatim, the count is not"},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"  {feed.source_id:18} {stats['original_records']:>5} -> "
              f"{stats['kept_records']:>3} records "
              f"({stats['universe_records']} universe + "
              f"{stats['non_universe_records']} other), {len(body):,} bytes")
        written += 1

    if not written:
        print("no fixtures written - run `twrev.cli verify` first", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
