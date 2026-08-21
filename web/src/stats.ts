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

import type { AnalyticsRow } from "./types";

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
