/**
 * Client-side aggregation for the KPI row and the insight panels.
 *
 * Rules that apply to every function here:
 *
 *  - **Nulls are excluded from the basis and the basis is reported.** Every
 *    aggregate returns `n` alongside the value so the widget can say what the
 *    number was computed over. An average across "the companies that happened to
 *    file" is a different number from an average across the universe, and the
 *    reader is entitled to know which one they are looking at.
 *  - **Medians, not means, for growth rates.** One company going from NT$2m to
 *    NT$60m is a real +2900% that would drag any mean into nonsense.
 *  - **Aggregate growth is revenue-weighted from levels**, never an average of
 *    percentages - averaging ratios weights a NT$300m substrate maker the same as
 *    TSMC.
 */

import { EXCLUDED_FROM_AGGREGATES } from "./generated/relationships";
import type { AnalyticsRow } from "./types";

const EXCLUDED = new Set(EXCLUDED_FROM_AGGREGATES);

/**
 * Drop companies whose revenue is ALREADY INSIDE another tracked company's
 * reported figure, before anything is summed across companies.
 *
 * Wistron consolidates Wiwynn, so both filing separately means Wiwynn's revenue
 * appears twice in any naive sum of the universe - once standalone and once
 * inside Wistron. Measured against the live data that overstated the universe
 * total by 4.55% and the Rack / ODM stage by 6.70%.
 *
 * **Call this before a SUM, and only before a SUM.** A subsidiary's own filed
 * revenue is perfectly real: its row, its series, its growth and its place in
 * the movers list are all correct as filed, and it is only ADDING it to its
 * parent's that double counts. Medians and per-company views deliberately do
 * not use this - a median counts each company once, which is not the same
 * arithmetic and not the same error.
 *
 * The excluded list is generated from config/relationships.yaml; see
 * src/generated/relationships.ts.
 */
export function forAggregate(rows: readonly AnalyticsRow[]): AnalyticsRow[] {
  if (EXCLUDED.size === 0) return [...rows];
  return rows.filter((r) => !EXCLUDED.has(r.ticker));
}

export interface Agg {
  value: number | null;
  /** How many companies the value was computed over. */
  n: number;
  /** How many were skipped because the input was null. */
  missing: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? null;
  const a = s[mid - 1];
  const b = s[mid];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

export function medianOf(
  rows: readonly AnalyticsRow[],
  pick: (r: AnalyticsRow) => number | null,
): Agg {
  const vals: number[] = [];
  let missing = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || Number.isNaN(v)) missing++;
    else vals.push(v);
  }
  return { value: median(vals), n: vals.length, missing };
}

export function sumRevenue(rows: readonly AnalyticsRow[]): Agg {
  let total = 0;
  let n = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.revenue_twd_thousands === null) missing++;
    else {
      total += r.revenue_twd_thousands;
      n++;
    }
  }
  return { value: n ? total : null, n, missing };
}

/**
 * Revenue-weighted YoY for a set of rows.
 *
 * The prior-year level is recovered from the row's own YoY:
 * `prior = revenue / (1 + yoy/100)`. Both operands come from the same filing, so
 * this is a reconstruction, not an estimate - and a company is included only if
 * it has both, so the numerator and denominator always cover the same set.
 */
export function weightedYoY(rows: readonly AnalyticsRow[]): Agg {
  let now = 0;
  let prior = 0;
  let n = 0;
  let missing = 0;
  for (const r of rows) {
    const rev = r.revenue_twd_thousands;
    const yoy = r.yoy_pct;
    if (rev === null || yoy === null || 1 + yoy / 100 <= 0) {
      missing++;
      continue;
    }
    now += rev;
    prior += rev / (1 + yoy / 100);
    n++;
  }
  if (!n || prior <= 0) return { value: null, n, missing };
  return { value: 100 * (now / prior - 1), n, missing };
}

/**
 * The arithmetic mean of one series ACROSS MONTHS. Nulls leave both the sum and
 * the divisor, so they are never silently zero.
 *
 * This is a different operation from `weightedYoY` above and the distinction is
 * the one that gets confused, so it is worth stating. `weightedYoY` aggregates
 * across *companies* within one month, where averaging ratios would weight a
 * NT$300m substrate maker the same as TSMC - hence levels, never percentages.
 * This averages *one row across time*, where every term is already the same
 * company's rate, or the same stage's already-revenue-weighted rate. Those terms
 * are commensurable, so the mean of them is a real number.
 *
 * `n` is returned and every caller prints it, because the mean of the three
 * months a company filed and the mean of the eight months in view are different
 * claims about the world.
 */
export function meanOf(values: readonly (number | null | undefined)[]): Agg {
  let total = 0;
  let n = 0;
  let missing = 0;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(v)) missing++;
    else {
      total += v;
      n++;
    }
  }
  return { value: n ? total / n : null, n, missing };
}

export function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export function sortedMonths(rows: readonly { month: string }[]): string[] {
  return [...new Set(rows.map((r) => r.month))].sort();
}

/** Rows for one month, which is the basis for every "latest month" KPI. */
export function forMonth(rows: readonly AnalyticsRow[], month: string | null): AnalyticsRow[] {
  if (!month) return [];
  return rows.filter((r) => r.month === month);
}

export interface Mover {
  ticker: string;
  company_name: string;
  bucket: string;
  tier: number;
  value: number;
}

/** Top-N by a metric, nulls excluded. Ties keep source order, which is by ticker. */
export function movers(
  rows: readonly AnalyticsRow[],
  pick: (r: AnalyticsRow) => number | null,
  n: number,
  direction: "top" | "bottom",
): Mover[] {
  const list: Mover[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (v === null || Number.isNaN(v)) continue;
    list.push({
      ticker: r.ticker,
      company_name: r.company_name,
      bucket: r.bucket,
      tier: r.tier,
      value: v,
    });
  }
  list.sort((a, b) => (direction === "top" ? b.value - a.value : a.value - b.value));
  return list.slice(0, n);
}

/**
 * Rebase a series to 100 at its first non-null point.
 *
 * Used for the bucket-index chart: it is the only way to put stages of wildly
 * different absolute size on one axis honestly. Bases at the first month that has
 * data for that stage, and returns that month so the chart can say what "100" is.
 */
export function rebase(values: (number | null)[]): {
  indexed: (number | null)[];
  baseIdx: number | null;
} {
  const baseIdx = values.findIndex((v) => v !== null && v > 0);
  if (baseIdx < 0) return { indexed: values.map(() => null), baseIdx: null };
  const base = values[baseIdx] as number;
  return { indexed: values.map((v) => (v === null ? null : (100 * v) / base)), baseIdx };
}

/**
 * Median absolute deviation - the spread measure that a single extreme member
 * cannot move.
 *
 * A standard deviation over ten stages is dominated by whichever stage is
 * furthest out, which is precisely the stage a "what stands out" panel is trying
 * to detect: the outlier inflates the yardstick it is being measured against and
 * hides itself. The MAD does not have that feedback.
 */
export function mad(values: number[]): number | null {
  const med = median(values);
  if (med === null) return null;
  return median(values.map((v) => Math.abs(v - med)));
}

export interface Standout<T> {
  item: T;
  value: number;
  /** (value - median) / (1.4826 * MAD). Null when the MAD is 0. */
  score: number | null;
}

/**
 * Rank items by how far each sits from the median of the others, in MAD units.
 *
 * READ THE LIMIT BEFORE READING THE NUMBER. This is a RANKING, not a
 * significance test, and the difference is not pedantry:
 *
 *  - Across months, a per-series z-score is arithmetically incapable of
 *    reaching 3 at n=7 - the maximum possible |z| for a sample of 7 is 2.268 -
 *    so a "3-sigma alert" on this dataset can never fire, and a 2-sigma one
 *    fires on the series maximum or minimum every single time, by construction.
 *    Measured on the live store: 100% of |z| > 2 flags were the series max or
 *    min, and lag-1 autocorrelation was -0.310, so there is no trend model
 *    underneath to appeal to either.
 *  - Cross-sectionally, across ~10 stages in one month, the comparison at least
 *    has independent members - but ten is still far too few to quote a
 *    false-positive rate for, and the stages are not independent draws: they
 *    share customers, a cycle, and in places each other's revenue.
 *
 * So the output is ordered, labelled in MAD units, and never called
 * significant. It answers "which stage is most unlike the others this month",
 * which is a real and useful question, and refuses the one it cannot answer.
 *
 * The scale constant 1.4826 makes the MAD comparable to a standard deviation
 * for normally-distributed data. It is a unit convention here, not a normality
 * claim - nothing about these ten numbers is assumed normal.
 */
export function standouts<T>(
  items: readonly T[],
  pick: (item: T) => number | null,
): { ranked: Standout<T>[]; median: number | null; mad: number | null; n: number } {
  const pairs: { item: T; value: number }[] = [];
  for (const item of items) {
    const v = pick(item);
    if (v !== null && !Number.isNaN(v)) pairs.push({ item, value: v });
  }
  const values = pairs.map((p) => p.value);
  const med = median(values);
  const spread = mad(values);
  // A zero MAD means over half the members share one value. The ratio would be
  // infinite for everyone else, which is not a ranking - it is a division by
  // zero wearing a number's clothes.
  const scale = spread === null || spread === 0 ? null : 1.4826 * spread;
  const ranked = pairs
    .map((p) => ({
      ...p,
      score: scale === null || med === null ? null : (p.value - med) / scale,
    }))
    .sort((a, b) => Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0));
  return { ranked, median: med, mad: spread, n: pairs.length };
}
