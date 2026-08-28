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

/**
 * Pairs CHECKED AND CLEARED - held, but not consolidated, so NOT double counts.
 *
 * Carried into the UI on purpose. The intuitive rule - a big stake means the
 * revenue is inside the parent's - is wrong here, and these are the counter
 * examples: stakes from 0.86% to 34.84%, none consolidating, against a 35-40%
 * stake that does. Showing them is what stops someone "fixing" a non-problem.
 */
export interface ClearedPair extends ConsolidationPair {
  treatment: string;
  stake: string;
}

export const CLEARED: readonly ClearedPair[] = [
  { parent: "2303", child: "3037", parentName: "UMC", childName: "Unimicron", treatment: "equity_method", stake: "~13.01%" },
  { parent: "2330", child: "3443", parentName: "TSMC", childName: "Global Unichip", treatment: "equity_method", stake: "34.84%" },
  { parent: "2330", child: "5347", parentName: "TSMC", childName: "VIS", treatment: "equity_method", stake: "~19%, was ~27.1% before May 2026" },
  { parent: "3231", child: "3661", parentName: "Wistron", childName: "Alchip", treatment: "fvoci", stake: "0.86%" },
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
