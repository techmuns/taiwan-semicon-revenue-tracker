"""config/relationships.yaml - who contains whom, and who is connected to whom.

The dashboard sums 37 companies. That is only correct if no company's reported
revenue already contains another's. It does: Wistron consolidates Wiwynn, so the
naive sum counted Wiwynn twice and overstated the universe total by ~4.5%.

This module loads the hand-authored relationship file and enforces the
invariants that make an entry safe to act on. Every check here exists because
getting it wrong DELETES REAL REVENUE from a headline figure, which is a worse
failure than the double count it corrects:

  * both sides of every edge must be in the universe - an edge to an untracked
    company cannot cause a double count and must not silently exclude anything
  * a ticker may be consolidated into at most one parent
  * no cycles, and nothing may consolidate itself
  * a pair may not appear in both `consolidation` and `cleared`
  * a consolidation entry must actually say treatment: consolidated

`cleared` is the other half of the design. TSMC holds ~35% of Global Unichip and
Wistron holds ~35-40% of Wiwynn, but only the second is a double count, because
only the second is consolidated. Recording the cleared pair stops anyone
"fixing" it later by pattern-matching on the stake.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import ConfigError, Universe, repo_root


@dataclass(frozen=True)
class Consolidation:
    """`parent`'s reported revenue already contains `child`'s."""

    parent: str
    child: str
    treatment: str
    stake: str
    confidence: str
    evidence: str


@dataclass(frozen=True)
class Edge:
    from_ticker: str
    to_ticker: str
    kind: str  # "supplies" | "competes"
    confidence: str
    evidence: str


@dataclass(frozen=True)
class Relationships:
    consolidation: tuple[Consolidation, ...]
    cleared: tuple[Consolidation, ...]
    edges: tuple[Edge, ...]
    _excluded: frozenset[str] = field(repr=False, default=frozenset())

    @property
    def excluded_from_aggregates(self) -> tuple[str, ...]:
        """Children to drop from SUMS. Their own rows stay untouched.

        Sorted so generated artifacts are byte-stable and a regeneration diff
        means a real change, not a dict-ordering wobble.
        """
        return tuple(sorted(self._excluded))

    def parent_of(self, ticker: str) -> str | None:
        for c in self.consolidation:
            if c.child == ticker:
                return c.parent
        return None


VALID_TREATMENTS = {"consolidated", "equity_method", "fvoci", "unclear"}
VALID_CONFIDENCE = {"high", "medium", "low"}
VALID_KINDS = {"supplies", "competes"}


def _pairs(doc: dict[str, Any], key: str, path: Path) -> list[Consolidation]:
    out: list[Consolidation] = []
    for i, raw in enumerate(doc.get(key) or ()):
        where = f"{path}: {key}[{i}]"
        if not isinstance(raw, dict):
            raise ConfigError(f"{where}: expected a mapping")
        for f in ("parent", "child", "treatment", "evidence"):
            if not raw.get(f):
                raise ConfigError(f"{where}: missing required field {f!r}")
        treatment = str(raw["treatment"])
        if treatment not in VALID_TREATMENTS:
            raise ConfigError(
                f"{where}: treatment {treatment!r} not one of {sorted(VALID_TREATMENTS)}"
            )
        confidence = str(raw.get("confidence", "low"))
        if confidence not in VALID_CONFIDENCE:
            raise ConfigError(f"{where}: confidence {confidence!r} is not high/medium/low")
        out.append(
            Consolidation(
                parent=str(raw["parent"]),
                child=str(raw["child"]),
                treatment=treatment,
                stake=str(raw.get("stake", "unknown")),
                confidence=confidence,
                evidence=str(raw["evidence"]).strip(),
            )
        )
    return out


def load_relationships(
    path: Path | None = None, universe: Universe | None = None
) -> Relationships:
    path = path or repo_root() / "config" / "relationships.yaml"
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"relationships file not found: {path}") from None
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from None
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        raise ConfigError(f"{path}: expected a mapping at the top level")

    consolidation = _pairs(doc, "consolidation", path)
    cleared = _pairs(doc, "cleared", path)

    edges: list[Edge] = []
    for kind in ("supplies", "competes"):
        for i, raw in enumerate(doc.get(kind) or ()):
            where = f"{path}: {kind}[{i}]"
            if not isinstance(raw, dict):
                raise ConfigError(f"{where}: expected a mapping")
            for f in ("from", "to", "evidence"):
                if not raw.get(f):
                    raise ConfigError(f"{where}: missing required field {f!r}")
            edges.append(
                Edge(
                    from_ticker=str(raw["from"]),
                    to_ticker=str(raw["to"]),
                    kind=kind,
                    confidence=str(raw.get("confidence", "low")),
                    evidence=str(raw["evidence"]).strip(),
                )
            )

    # ------------------------------------------------------------ invariants --
    #
    # An entry here removes revenue from a headline number. Every one of these
    # checks is the difference between correcting the double count and silently
    # deleting a real company from the total.

    # A consolidation entry that is not actually consolidated would exclude a
    # company that is not double counted at all.
    for c in consolidation:
        if c.treatment != "consolidated":
            raise ConfigError(
                f"{path}: consolidation {c.parent}->{c.child} has treatment "
                f"{c.treatment!r}. Only 'consolidated' belongs in `consolidation`; "
                f"move it to `cleared` if the parent equity-methods it."
            )

    for c in consolidation + cleared:
        if c.parent == c.child:
            raise ConfigError(f"{path}: {c.parent} cannot consolidate itself")

    # The same pair asserted both ways means nobody knows which is true.
    both = {(c.parent, c.child) for c in consolidation} & {(c.parent, c.child) for c in cleared}
    if both:
        raise ConfigError(
            f"{path}: pair(s) {sorted(both)} appear in BOTH consolidation and cleared"
        )

    # Two parents claiming the same child would subtract it once but leave the
    # reader unable to say whose total contains it.
    seen: dict[str, str] = {}
    for c in consolidation:
        if c.child in seen:
            raise ConfigError(
                f"{path}: {c.child} is consolidated into both {seen[c.child]} and {c.parent}"
            )
        seen[c.child] = c.parent

    # A -> B -> A would make the total depend on iteration order.
    for c in consolidation:
        hop, chain = c.parent, [c.child, c.parent]
        while hop in seen:
            hop = seen[hop]
            if hop in chain:
                raise ConfigError(f"{path}: consolidation cycle {' -> '.join(chain + [hop])}")
            chain.append(hop)

    if universe is not None:
        known = set(universe.tickers)
        for c in consolidation + cleared:
            for side, t in (("parent", c.parent), ("child", c.child)):
                if t not in known:
                    raise ConfigError(
                        f"{path}: {side} {t!r} in {c.parent}->{c.child} is not in the universe. "
                        f"A relationship with an untracked company cannot double-count and "
                        f"must not exclude anything."
                    )
        for e in edges:
            for side, t in (("from", e.from_ticker), ("to", e.to_ticker)):
                if t not in known:
                    raise ConfigError(
                        f"{path}: {kind} edge {side} {t!r} is not in the universe"
                    )

    return Relationships(
        consolidation=tuple(consolidation),
        cleared=tuple(cleared),
        edges=tuple(edges),
        _excluded=frozenset(c.child for c in consolidation),
    )


# ---------------------------------------------------------------- generation --
#
# The de-duplication has to happen in TWO places that cannot share a module: the
# Worker's SQL aggregate and the browser's KPI sum. Rather than hand-maintain the
# ticker list twice - which would drift, silently, in the direction of a wrong
# headline number - both are GENERATED from this one YAML and a check asserts they
# are not stale.
#
# Generating rather than querying D1 is deliberate: adding a column to the
# `universe` table would need a migration, and migrations are applied by hand
# outside CI while the monthly refresh is automated. A seed that referenced a
# column D1 did not have yet would abort the whole month's revenue update, since
# the seed applies as a single transaction. A build-time constant cannot do that.

BANNER = "// GENERATED FILE - do not edit. Source: config/relationships.yaml"


def render_ts(rel: Relationships, universe: Universe) -> str:
    """The TypeScript module both web/ and worker/ import."""
    name = {c.ticker: c.display_name for c in universe}

    lines = [
        BANNER,
        "//",
        "// Companies whose revenue is already inside another tracked company's reported",
        "// figure. They are removed from SUMS ONLY - the universe total and the per-stage",
        "// aggregates. Their own rows, series and acceleration are untouched, because a",
        "// subsidiary's own numbers are perfectly real; it is only adding them to the",
        "// parent that double counts.",
        "//",
        "// Regenerate with:  python -m twrev.cli validate --write",
        "",
        "export interface ConsolidationPair {",
        "  parent: string;",
        "  child: string;",
        "  parentName: string;",
        "  childName: string;",
        "}",
        "",
        "export const CONSOLIDATION: readonly ConsolidationPair[] = [",
    ]
    for c in sorted(rel.consolidation, key=lambda c: c.child):
        lines.append(
            f'  {{ parent: "{c.parent}", child: "{c.child}", '
            f'parentName: "{name.get(c.parent, c.parent)}", '
            f'childName: "{name.get(c.child, c.child)}" }},'
        )
    lines += [
        "];",
        "",
        "/** Tickers to drop from any SUM across companies. */",
        "export const EXCLUDED_FROM_AGGREGATES: readonly string[] = [",
    ]
    for t in rel.excluded_from_aggregates:
        lines.append(f'  "{t}",   // inside {name.get(rel.parent_of(t) or "", "?")}')
    lines += [
        "];",
        "",
        "/**",
        " * Pairs CHECKED AND CLEARED - held, but not consolidated, so NOT double counts.",
        " *",
        " * Carried into the UI on purpose. The intuitive rule - a big stake means the",
        " * revenue is inside the parent's - is wrong here, and these are the counter",
        " * examples: stakes from 0.86% to 34.84%, none consolidating, against a 35-40%",
        " * stake that does. Showing them is what stops someone \"fixing\" a non-problem.",
        " */",
        "export interface ClearedPair extends ConsolidationPair {",
        "  treatment: string;",
        "  stake: string;",
        "}",
        "",
        "export const CLEARED: readonly ClearedPair[] = [",
    ]
    for c in sorted(rel.cleared, key=lambda c: (c.parent, c.child)):
        lines.append(
            f'  {{ parent: "{c.parent}", child: "{c.child}", '
            f'parentName: "{name.get(c.parent, c.parent)}", '
            f'childName: "{name.get(c.child, c.child)}", '
            f'treatment: "{c.treatment}", stake: "{c.stake}" }},'
        )
    lines += [
        "];",
        "",
        "/** One line a reader can act on, or null when nothing is excluded. */",
        "export function consolidationNote(): string | null {",
        "  if (CONSOLIDATION.length === 0) return null;",
        "  const parts = CONSOLIDATION.map(",
        "    (c) => `${c.childName} (${c.child}) is already inside ${c.parentName} (${c.parent})`,",
        "  );",
        "  return (",
        "    `${parts.join(\"; \")} — so totals across companies count it once. ` +",
        "    `Each company's own figures are unaffected.`",
        "  );",
        "}",
        "",
    ]
    return "\n".join(lines)


GENERATED_TS = (
    Path("web") / "src" / "generated" / "relationships.ts",
    Path("worker") / "src" / "generated" / "relationships.ts",
)


def write_generated(rel: Relationships, universe: Universe, root: Path | None = None) -> list[Path]:
    root = root or repo_root()
    text = render_ts(rel, universe)
    written = []
    for rel_path in GENERATED_TS:
        out = root / rel_path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        written.append(out)
    return written


def check_generated(rel: Relationships, universe: Universe, root: Path | None = None) -> list[str]:
    """Returns a list of stale paths. Empty means the generated files are current."""
    root = root or repo_root()
    want = render_ts(rel, universe)
    stale = []
    for rel_path in GENERATED_TS:
        out = root / rel_path
        if not out.exists() or out.read_text(encoding="utf-8") != want:
            stale.append(str(rel_path))
    return stale
