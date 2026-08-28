// GENERATED FILE - do not edit. Source: config/relationships.yaml
//
// Companies whose revenue is already inside another tracked company's reported
// figure. They are removed from SUMS ONLY - the universe total and the per-stage
// aggregates. Their own rows, series and acceleration are untouched, because a
// subsidiary's own numbers are perfectly real; it is only adding them to the
// parent that double counts.
//
// Regenerate with:  python -m twrev.cli validate --write

export interface ConsolidationPair {
  parent: string;
  child: string;
  parentName: string;
  childName: string;
}

export const CONSOLIDATION: readonly ConsolidationPair[] = [
  { parent: "3231", child: "6669", parentName: "Wistron", childName: "Wiwynn" },
];

/** Tickers to drop from any SUM across companies. */
export const EXCLUDED_FROM_AGGREGATES: readonly string[] = [
  "6669",   // inside Wistron
];

/** One line a reader can act on, or null when nothing is excluded. */
export function consolidationNote(): string | null {
  if (CONSOLIDATION.length === 0) return null;
  const parts = CONSOLIDATION.map(
    (c) => `${c.childName} (${c.child}) is already inside ${c.parentName} (${c.parent})`,
  );
  return (
    `${parts.join("; ")} — so totals across companies count it once. ` +
    `Each company's own figures are unaffected.`
  );
}
