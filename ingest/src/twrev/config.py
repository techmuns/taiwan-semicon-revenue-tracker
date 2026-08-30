"""Loaders for config/universe.yaml and config/sources.yaml.

Validation is deliberately strict and fails fast, naming the offending ticker.
A typo in the universe is otherwise invisible: the name simply never appears in
the dashboard, and a missing row looks identical to a company that filed nothing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

VALID_STATUS = frozenset({"active", "merged", "delisted", "suspended"})
VALID_MARKET_HINT = frozenset({"sii", "otc", "rotc"})


class ConfigError(ValueError):
    """Config is unusable. Always names what and where."""


def repo_root() -> Path:
    """Walk up from this file to the directory containing config/.

    Resolved rather than assumed so the CLI works from any cwd; `TWREV_ROOT`
    overrides it for tests and for running out of a different checkout.
    """
    override = os.environ.get("TWREV_ROOT")
    if override:
        return Path(override).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "config" / "universe.yaml").is_file():
            return parent
    raise ConfigError(
        f"could not locate config/universe.yaml above {here}; set TWREV_ROOT"
    )


@dataclass(frozen=True)
class Company:
    ticker: str
    display_name: str
    bucket: str
    tier: int
    name_zh: str | None = None
    market_hint: str | None = None
    status: str = "active"
    active_from: str | None = None
    active_to: str | None = None
    successor: str | None = None
    thesis: str | None = None
    notes: str | None = None
    sort_order: int = 0

    @property
    def trackable(self) -> bool:
        """False only for names with no filing obligation at all (6286).

        Used to suppress MISSING_TICKER_MONTH findings. It does NOT exclude the
        company from the universe table or the dashboard - the whole point of the
        decision to keep 6286 is that its gap renders as an explicit "no data".
        """
        return self.status != "merged"


@dataclass(frozen=True)
class Universe:
    version: int
    buckets: tuple[str, ...]
    companies: tuple[Company, ...]
    _by_ticker: dict[str, Company] = field(repr=False, default_factory=dict)

    def __getitem__(self, ticker: str) -> Company:
        try:
            return self._by_ticker[ticker]
        except KeyError:
            raise ConfigError(f"ticker {ticker!r} is not in the universe") from None

    def __contains__(self, ticker: object) -> bool:
        return ticker in self._by_ticker

    def __iter__(self):
        return iter(self.companies)

    def __len__(self) -> int:
        return len(self.companies)

    @property
    def tickers(self) -> tuple[str, ...]:
        return tuple(c.ticker for c in self.companies)

    @property
    def trackable_tickers(self) -> tuple[str, ...]:
        return tuple(c.ticker for c in self.companies if c.trackable)

    def tier(self, tier: int) -> tuple[Company, ...]:
        return tuple(c for c in self.companies if c.tier == tier)


def _require(mapping: dict[str, Any], key: str, where: str) -> Any:
    if key not in mapping or mapping[key] in (None, ""):
        raise ConfigError(f"{where}: missing required field {key!r}")
    return mapping[key]


def load_universe(path: Path | None = None) -> Universe:
    path = path or repo_root() / "config" / "universe.yaml"
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"universe file not found: {path}") from None
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from None
    if not isinstance(doc, dict):
        raise ConfigError(f"{path}: expected a mapping at the top level")

    buckets = tuple(doc.get("buckets") or ())
    if not buckets:
        raise ConfigError(f"{path}: 'buckets' must be a non-empty list")
    if len(set(buckets)) != len(buckets):
        raise ConfigError(f"{path}: duplicate bucket names")

    raw_entries = doc.get("tickers")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise ConfigError(f"{path}: 'tickers' must be a non-empty list")

    companies: list[Company] = []
    seen: dict[str, int] = {}
    for i, entry in enumerate(raw_entries):
        where = f"{path.name} tickers[{i}]"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where}: expected a mapping")

        raw_ticker = _require(entry, "ticker", where)
        # The single most valuable check in this file. YAML turns an unquoted
        # 2330 into an int, which then fails to join against TEXT tickers
        # everywhere downstream - and 0050 would lose its leading zero outright.
        if not isinstance(raw_ticker, str):
            raise ConfigError(
                f"{where}: ticker {raw_ticker!r} must be a quoted string - "
                f'write ticker: "{raw_ticker}"'
            )
        ticker = raw_ticker.strip()
        if len(ticker) != 4 or not ticker.isdigit():
            raise ConfigError(f"{where}: ticker {ticker!r} must be 4 digits")
        if ticker in seen:
            raise ConfigError(
                f"{where}: duplicate ticker {ticker!r} (first at tickers[{seen[ticker]}])"
            )
        seen[ticker] = i

        bucket = _require(entry, "bucket", where)
        if bucket not in buckets:
            raise ConfigError(
                f"{where}: bucket {bucket!r} for {ticker} is not in the declared "
                f"bucket list; add it to 'buckets' or fix the typo"
            )

        tier = _require(entry, "tier", where)
        if tier not in (1, 2):
            raise ConfigError(f"{where}: tier for {ticker} must be 1 or 2, got {tier!r}")

        status = entry.get("status", "active")
        if status not in VALID_STATUS:
            raise ConfigError(
                f"{where}: status {status!r} for {ticker} not in {sorted(VALID_STATUS)}"
            )

        hint = entry.get("market_hint")
        if hint is not None and hint not in VALID_MARKET_HINT:
            raise ConfigError(
                f"{where}: market_hint {hint!r} for {ticker} not in {sorted(VALID_MARKET_HINT)}"
            )

        successor = entry.get("successor")
        if successor is not None and not isinstance(successor, str):
            raise ConfigError(f'{where}: successor for {ticker} must be quoted')
        if status == "merged" and not successor:
            raise ConfigError(
                f"{where}: {ticker} is status 'merged' but has no successor recorded"
            )

        companies.append(Company(
            ticker=ticker,
            display_name=str(_require(entry, "display_name", where)),
            bucket=str(bucket),
            tier=int(tier),
            name_zh=entry.get("name_zh"),
            market_hint=hint,
            status=status,
            active_from=entry.get("active_from"),
            active_to=entry.get("active_to"),
            successor=successor,
            thesis=entry.get("thesis"),
            notes=entry.get("notes"),
            # Preserve file order so the dashboard renders buckets in
            # supply-chain sequence rather than alphabetically. What makes that
            # sequence right is tested, not asserted: see
            # test_relationships.py::test_stage_order_follows_the_supply_edges.
            sort_order=i,
        ))

    return Universe(
        version=int(doc.get("version", 1)),
        buckets=buckets,
        companies=tuple(companies),
        _by_ticker={c.ticker: c for c in companies},
    )


@dataclass(frozen=True)
class Feed:
    source_id: str
    role: str
    url: str
    market: str | None
    expect_min_records: int
    expect_target_coverage: int
    anchor_tickers: tuple[str, ...]
    notes: str | None = None


@dataclass(frozen=True)
class BackfillSource:
    source_id: str
    url_template: str
    min_interval_s: float
    timeout_s: int
    max_attempts: int
    backoff_s: tuple[float, ...]
    body_anchor: str
    known_empty_markers: dict[str, str]
    min_body_bytes: int


@dataclass(frozen=True)
class Sources:
    backfill: BackfillSource
    feeds: tuple[Feed, ...]
    month_field: str
    percent_sentinel: float
    revenue_unit: str

    def feed(self, source_id: str) -> Feed:
        for f in self.feeds:
            if f.source_id == source_id:
                return f
        raise ConfigError(f"no feed with source_id {source_id!r}")


def load_sources(path: Path | None = None) -> Sources:
    path = path or repo_root() / "config" / "sources.yaml"
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"sources file not found: {path}") from None
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from None

    b = _require(doc, "backfill", str(path))
    template = str(_require(b, "url_template", "backfill"))
    # Fail here rather than fetching 296 wrong URLs.
    for token in ("{code}", "{roc_year}", "{mm}"):
        if token not in template:
            raise ConfigError(f"backfill.url_template is missing {token}")

    backfill = BackfillSource(
        source_id=str(_require(b, "source_id", "backfill")),
        url_template=template,
        min_interval_s=float(b.get("min_interval_s", 3.0)),
        timeout_s=int(b.get("timeout_s", 45)),
        max_attempts=int(b.get("max_attempts", 5)),
        backoff_s=tuple(float(x) for x in b.get("backoff_s", (5, 15, 45, 90))),
        body_anchor=str(_require(b, "body_anchor", "backfill")),
        known_empty_markers=dict(b.get("known_empty_markers") or {}),
        min_body_bytes=int(b.get("min_body_bytes", 1500)),
    )

    r = _require(doc, "refresh", str(path))
    raw_feeds = _require(r, "feeds", "refresh")
    if not isinstance(raw_feeds, list) or not raw_feeds:
        raise ConfigError("refresh.feeds must be a non-empty list")

    feeds: list[Feed] = []
    for i, entry in enumerate(raw_feeds):
        where = f"refresh.feeds[{i}]"
        market = entry.get("market")
        if market is not None and market not in VALID_MARKET_HINT:
            raise ConfigError(f"{where}: bad market {market!r}")
        feeds.append(Feed(
            source_id=str(_require(entry, "source_id", where)),
            role=str(entry.get("role", "fallback")),
            url=str(_require(entry, "url", where)),
            market=market,
            expect_min_records=int(entry.get("expect_min_records", 0)),
            expect_target_coverage=int(entry.get("expect_target_coverage", 0)),
            anchor_tickers=tuple(str(t) for t in (entry.get("anchor_tickers") or ())),
            notes=entry.get("notes"),
        ))

    ids = [f.source_id for f in feeds]
    if len(set(ids)) != len(ids):
        raise ConfigError("refresh.feeds has duplicate source_id values")
    # The brief names t187ap05_P as the ongoing source; keeping it first in
    # precedence is a requirement, not a preference. Guard it so a future edit
    # that demotes it has to be deliberate.
    if feeds[0].role != "specified":
        raise ConfigError(
            "refresh.feeds[0] must have role 'specified' - the brief's endpoint "
            "stays first in precedence"
        )

    return Sources(
        backfill=backfill,
        feeds=tuple(feeds),
        month_field=str(r.get("month_field", "資料年月")),
        percent_sentinel=float(doc.get("percent_sentinel", 999999.99)),
        revenue_unit=str(doc.get("revenue_unit", "twd_thousands")),
    )


@lru_cache(maxsize=1)
def universe() -> Universe:
    return load_universe()


@lru_cache(maxsize=1)
def sources() -> Sources:
    return load_sources()
