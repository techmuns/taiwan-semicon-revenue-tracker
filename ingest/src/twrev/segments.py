"""config/segments.yaml - named slices of the universe, and where segment-level
figures are allowed to enter.

THE HONEST VERSION OF WHAT THIS CAN DO

The monthly filing this pipeline scrapes is a single consolidated revenue figure
per company. It has no product line, no end market and no segment in it. So a
`Segment` here is NOT "TSMC's HPC revenue"; it is "the companies we have decided
belong to the HPC theme, summed". That is a real, defensible, fully-computable
number - and it is a different number from the one a reader will assume unless
the surface rendering it says so. `Segment.basis` is required for exactly that
reason: there is no way to define a segment in this file without also writing
down what its figure actually measures.

`observations` is the other half: hand-transcribed segment splits from a named
source. Nothing writes to it, nothing scrapes into it, and a row without a
source is rejected. It is empty, and an empty list is the truthful state until
someone does the quarterly-filing work.

The aggregate de-duplicates against config/relationships.yaml, so a segment may
list both a parent and its consolidated subsidiary - membership is a claim about
which businesses belong to the theme, and the arithmetic is not allowed to be
wrong because of how that claim was written.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config import ConfigError, Universe, repo_root

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,23}$")
# "2026-03" (a month) or "2026-Q1" (a quarter). Segment splits are disclosed
# quarterly, monthly revenue is not, and conflating them is the failure mode.
PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$")


@dataclass(frozen=True)
class Segment:
    key: str
    label: str
    basis: str
    members: tuple[str, ...]
    notes: str


@dataclass(frozen=True)
class Observation:
    """One segment figure, transcribed by hand from a named document."""

    ticker: str
    segment: str
    period: str
    share_pct: float | None
    revenue_twd_thousands: int | None
    source: str
    as_of: str


@dataclass(frozen=True)
class Segments:
    definitions: tuple[Segment, ...]
    observations: tuple[Observation, ...]

    @property
    def observation_count(self) -> int:
        return len(self.observations)

    def __getitem__(self, key: str) -> Segment:
        for s in self.definitions:
            if s.key == key:
                return s
        raise ConfigError(f"no segment named {key!r}")


def _segment(raw: Any, where: str, known: set[str] | None) -> Segment:
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: expected a mapping")
    for f in ("key", "label", "basis", "members"):
        if not raw.get(f):
            raise ConfigError(f"{where}: missing required field {f!r}")

    key = str(raw["key"])
    if not KEY_RE.match(key):
        raise ConfigError(
            f"{where}: key {key!r} must be lowercase letters, digits and underscores "
            f"(2-24 chars). It reaches a URL and a generated TypeScript identifier."
        )

    members = [str(t) for t in raw["members"]]
    if len(set(members)) != len(members):
        dupes = sorted({t for t in members if members.count(t) > 1})
        raise ConfigError(f"{where}: member(s) {dupes} listed more than once")
    if known is not None:
        unknown = [t for t in members if t not in known]
        if unknown:
            raise ConfigError(
                f"{where}: member(s) {unknown} are not in config/universe.yaml. "
                f"A segment can only slice companies this tracker actually collects."
            )

    # A one-company segment is a company, and a segment holding the whole
    # universe is the universe. Both render as a figure that looks like an
    # aggregate and is not one.
    if len(members) < 2:
        raise ConfigError(f"{where}: a segment needs at least two members")

    return Segment(
        key=key,
        label=str(raw["label"]),
        basis=str(raw["basis"]).strip(),
        members=tuple(members),
        notes=str(raw.get("notes", "")).strip(),
    )


def _observation(raw: Any, where: str, keys: set[str], known: set[str] | None) -> Observation:
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: expected a mapping")
    for f in ("ticker", "segment", "period", "source", "as_of"):
        if not raw.get(f):
            raise ConfigError(
                f"{where}: missing required field {f!r}. Every observation is a "
                f"quotation from a document and must name it."
            )

    ticker, segment = str(raw["ticker"]), str(raw["segment"])
    if known is not None and ticker not in known:
        raise ConfigError(f"{where}: ticker {ticker!r} is not in the universe")
    if segment not in keys:
        raise ConfigError(f"{where}: segment {segment!r} is not defined above")

    period = str(raw["period"])
    if not PERIOD_RE.match(period):
        raise ConfigError(
            f"{where}: period {period!r} must be YYYY-MM or YYYY-Qn. Segment splits "
            f"are disclosed quarterly; monthly revenue is not, and a quarterly "
            f"figure written as a month would be silently compared against one."
        )

    share = raw.get("share_pct")
    revenue = raw.get("revenue_twd_thousands")
    if share is None and revenue is None:
        raise ConfigError(f"{where}: needs share_pct or revenue_twd_thousands")
    if share is not None and not 0 <= float(share) <= 100:
        raise ConfigError(f"{where}: share_pct {share} is not a percentage")

    return Observation(
        ticker=ticker,
        segment=segment,
        period=period,
        share_pct=None if share is None else float(share),
        revenue_twd_thousands=None if revenue is None else int(revenue),
        source=str(raw["source"]).strip(),
        as_of=str(raw["as_of"]),
    )


def load_segments(path: Path | None = None, universe: Universe | None = None) -> Segments:
    path = path or repo_root() / "config" / "segments.yaml"
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"segments file not found: {path}") from None
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from None
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        raise ConfigError(f"{path}: expected a mapping at the top level")

    known = set(universe.tickers) if universe is not None else None

    definitions: list[Segment] = []
    for i, raw in enumerate(doc.get("segments") or ()):
        definitions.append(_segment(raw, f"{path}: segments[{i}]", known))

    keys = [s.key for s in definitions]
    if len(set(keys)) != len(keys):
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        raise ConfigError(f"{path}: duplicate segment key(s) {dupes}")

    observations = [
        _observation(raw, f"{path}: observations[{i}]", set(keys), known)
        for i, raw in enumerate(doc.get("observations") or ())
    ]

    return Segments(definitions=tuple(definitions), observations=tuple(observations))


# ---------------------------------------------------------------- generation --
#
# Same reasoning as relationships.py: the browser needs this and D1 must not be
# asked for it. Adding a table would need a migration, migrations are applied by
# hand outside CI, and the monthly seed applies as ONE transaction - so a seed
# referencing a table D1 did not have yet would abort the whole month's revenue
# update. A build-time constant cannot fail that way.

BANNER = "// GENERATED FILE - do not edit. Source: config/segments.yaml"
GENERATED_TS = Path("web") / "src" / "generated" / "segments.ts"


def _ts(value: str) -> str:
    """A TS string literal. Whitespace is collapsed - these are YAML block
    scalars, so they arrive with the source file's own line breaks in them."""
    collapsed = " ".join(value.split())
    return '"' + collapsed.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_ts(segs: Segments, universe: Universe) -> str:
    name = {c.ticker: c.display_name for c in universe}
    lines = [
        BANNER,
        "//",
        "// A segment is a NAMED SET OF COMPANIES, and its figure is the sum of their",
        "// TOTAL revenue - NOT their revenue in that segment. Monthly filings carry no",
        "// product split. Every surface that renders a segment must show `basis`.",
        "//",
        "// Regenerate with:  python -m twrev.cli validate --write",
        "",
        "export interface Segment {",
        "  key: string;",
        "  label: string;",
        "  /** What the figure actually measures. Render it; it is not optional prose. */",
        "  basis: string;",
        "  members: readonly string[];",
        "  notes: string;",
        "}",
        "",
        "export const SEGMENTS: readonly Segment[] = [",
    ]
    for s in segs.definitions:
        lines += [
            "  {",
            f"    key: {_ts(s.key)},",
            f"    label: {_ts(s.label)},",
            f"    basis: {_ts(s.basis)},",
            "    members: [",
        ]
        for t in s.members:
            lines.append(f'      "{t}",   // {name.get(t, "?")}')
        lines += [
            "    ],",
            f"    notes: {_ts(s.notes)},",
            "  },",
        ]
    lines += [
        "];",
        "",
        "/** Segment splits transcribed by hand from a named source. */",
        "export interface SegmentObservation {",
        "  ticker: string;",
        "  segment: string;",
        "  period: string;",
        "  sharePct: number | null;",
        "  revenueTwdThousands: number | null;",
        "  source: string;",
        "  asOf: string;",
        "}",
        "",
        "// Empty, and an empty list is the truthful state: no monthly filing in this",
        "// pipeline contains a segment split. Populating it is a data-sourcing task",
        "// against quarterly IFRS 8 notes, not a visualization task.",
        "export const SEGMENT_OBSERVATIONS: readonly SegmentObservation[] = [",
    ]
    for o in segs.observations:
        lines.append(
            f'  {{ ticker: "{o.ticker}", segment: "{o.segment}", period: "{o.period}", '
            f"sharePct: {'null' if o.share_pct is None else o.share_pct}, "
            f"revenueTwdThousands: "
            f"{'null' if o.revenue_twd_thousands is None else o.revenue_twd_thousands}, "
            f"source: {_ts(o.source)}, asOf: {_ts(o.as_of)} }},"
        )
    lines += ["];", ""]
    return "\n".join(lines)


def write_generated(segs: Segments, universe: Universe, root: Path | None = None) -> list[Path]:
    root = root or repo_root()
    out = root / GENERATED_TS
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_ts(segs, universe), encoding="utf-8")
    return [out]


def check_generated(segs: Segments, universe: Universe, root: Path | None = None) -> list[str]:
    """Returns stale paths. Empty means the generated file is current."""
    root = root or repo_root()
    out = (root or repo_root()) / GENERATED_TS
    want = render_ts(segs, universe)
    if not out.exists() or out.read_text(encoding="utf-8") != want:
        return [str(GENERATED_TS)]
    return []
