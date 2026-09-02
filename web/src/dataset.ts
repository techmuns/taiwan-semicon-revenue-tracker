/**
 * The dashboard's data, read from files instead of queried from a database.
 *
 * Cloudflare D1 is gone. Every endpoint the Worker used to answer is now a
 * static JSON file published by `twrev export`, and the filtering the SQL used
 * to do in a WHERE clause happens here instead.
 *
 * WHAT IS AND IS NOT COMPUTED HERE. This module filters and projects. It does
 * NOT aggregate. The bucket heatmap - the one screen that genuinely needed a
 * GROUP BY, and the code in this repository with the worst defect history - was
 * not reimplemented in TypeScript. It is computed at publish time by the same
 * SQL statement that ran on D1, character for character, out of
 * ingest/src/twrev/sql/heatmap_bucket.sql, and shipped as answers. Below, its
 * cells are looked up and sliced, never recalculated. That distinction is the
 * whole safety argument for this migration: a filter that is wrong shows the
 * wrong rows, which is visible; an aggregate that is wrong shows a plausible
 * number, which is not.
 *
 * WHY SLICING IS SOUND. heatmap.json holds one entry per tier subset because
 * those are the only filters that change a cell's VALUE. `from`, `to` and
 * `buckets` merely select which cells appear - per_bucket groups by
 * (bucket, month_idx) and the window always reaches one month behind `from`,
 * so they cannot alter what is inside a cell. That is measured, not assumed:
 * ingest/tests/test_heatmap_export.py executes the statement under a narrower
 * `to`, a wider `from` and a single-bucket filter and requires identical values
 * across every shared cell. If that test ever fails, this file's slicing is
 * wrong too.
 */

import { ApiError, type FilterState } from "./api";
import { reportUnauthorized } from "./unauthorized";
import type {
  AnalyticsResponse,
  AnalyticsRow,
  BucketHeatmap,
  CompanyDetail,
  HeatmapMetric,
  Meta,
  TickerHeatmap,
} from "./types";

/** Where the published files live, relative to the site root. */
const DATA = "/data";

/** One in-flight fetch per file, and one parsed copy, for the life of the page.
 *  The files are immutable for a given deploy, so re-fetching them on a filter
 *  change would be pure waste - and App.tsx keys its queries on the filter
 *  object, so every chip click would otherwise re-download the dataset. */
const cache = new Map<string, Promise<unknown>>();

function load<T>(name: string): Promise<T> {
  let hit = cache.get(name);
  if (!hit) {
    hit = fetch(`${DATA}/${name}`, { headers: { accept: "application/json" } }).then(
      async (r) => {
        // The published files sit behind the same access gate as the old API,
        // so a missing or stale cookie fails here exactly as it used to fail
        // on /api/*. Publish it once for the whole dashboard.
        if (r.status === 401) reportUnauthorized();
        if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status, `${DATA}/${name}`);
        return r.json();
      },
    );
    cache.set(name, hit);
  }
  return hit as Promise<T>;
}

/** Drop every cached file. Only for tests and a manual refresh. */
export function resetCache(): void {
  cache.clear();
}

/**
 * whereFor(), in TypeScript. The clauses are in the same order and mean the
 * same things; keep them that way so the two can be read side by side.
 *
 * `onlyWithData` tests `!== null` rather than falsiness. A filed zero is a
 * filing - the company reported no revenue that month, which is a fact - and
 * treating it as absent would silently drop a real row and shrink a basis.
 */
export function matchesFilters(row: AnalyticsRow, f: FilterState): boolean {
  if (f.from && row.month < f.from) return false;
  if (f.to && row.month > f.to) return false;
  if (f.tickers.length && !f.tickers.includes(row.ticker)) return false;
  if (f.buckets.length && !f.buckets.includes(row.bucket)) return false;
  if (f.tiers.length && !f.tiers.includes(row.tier)) return false;
  if (f.onlyWithData && row.revenue_twd_thousands === null) return false;
  return true;
}

export function filterRows(rows: readonly AnalyticsRow[], f: FilterState): AnalyticsRow[] {
  return rows.filter((r) => matchesFilters(r, f));
}

/** The key heatmap.json is indexed by. Sorted and comma-joined, so {2,1} and
 *  {1,2} are the same subset - which they are. */
export function tierKey(tiers: readonly number[]): string {
  return [...tiers].sort((a, b) => a - b).join(",");
}

export async function meta(): Promise<Meta> {
  return load<Meta>("meta.json");
}

export async function analytics(f: FilterState): Promise<AnalyticsResponse> {
  const all = await load<AnalyticsResponse>("analytics.json");
  const rows = filterRows(all.rows, f);
  return { filters: f, count: rows.length, rows };
}

export async function company(ticker: string): Promise<CompanyDetail> {
  return load<CompanyDetail>(`company/${encodeURIComponent(ticker)}.json`);
}

/** Raised when a filter combination the published files cannot answer is asked
 *  for. Only a hand-written `?tickers=` link produces one - there is no control
 *  in the UI that does. Reported rather than answered with the unfiltered
 *  value, because a wrong number presented as a filtered one is worse than a
 *  refusal. */
export class UnsupportedFilterError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "UnsupportedFilterError";
  }
}

export async function bucketHeatmap(
  f: FilterState,
  metric: HeatmapMetric,
  agg: "weighted" | "equal",
): Promise<BucketHeatmap> {
  const file = await load<PublishedHeatmap>("heatmap.json");

  if (f.tickers.length) {
    throw new UnsupportedFilterError(
      "A ticker filter changes what a stage aggregate contains, and the published " +
        "file holds one answer per tier subset, not per ticker subset. Remove the " +
        "`tickers` parameter to see stage aggregates.",
    );
  }

  const key = tierKey(f.tiers);
  const subset = file.tier_subsets[key];
  if (!subset) {
    throw new UnsupportedFilterError(
      `no published heatmap for tier subset ${key === "" ? "(all)" : key}`,
    );
  }
  const combo = subset[`${metric}|${agg}`];
  if (!combo) throw new UnsupportedFilterError(`no published heatmap for ${metric}/${agg}`);

  // Slicing only. `from`/`to`/`buckets` select cells; they never change one.
  const cells = combo.cells.filter(
    (c) =>
      (!f.from || c.month >= f.from) &&
      (!f.to || c.month <= f.to) &&
      (!f.buckets.length || f.buckets.includes(c.bucket)),
  );

  return {
    group: "bucket",
    metric,
    // What was ACTUALLY applied, which is not always what was asked for:
    // cumulative YoY has no equal-weighted form. Echoing the request here is
    // the defect that labelled 70 of 70 cells "one company one vote" over a
    // revenue-weighted number.
    agg: combo.agg,
    agg_requested: combo.agg_requested,
    filters: f,
    cells,
  } as BucketHeatmap;
}

export async function tickerHeatmap(
  f: FilterState,
  metric: HeatmapMetric,
): Promise<TickerHeatmap> {
  // Per ticker there is nothing to aggregate: the metric is the metric. This
  // is a projection of the rows the analytics file already holds.
  const all = await load<AnalyticsResponse>("analytics.json");
  const cells = filterRows(all.rows, f).map((r) => ({
    ticker: r.ticker,
    company_name: r.company_name,
    bucket: r.bucket,
    tier: r.tier,
    month: r.month,
    value: r[metric] as number | null,
    revenue: r.revenue_twd_thousands,
  }));
  return { group: "ticker", metric, agg: "none", filters: f, cells } as TickerHeatmap;
}

// ---------------------------------------------------------------- shapes --

interface PublishedCell {
  bucket: string;
  month: string;
  value: number | null;
  members: number | null;
  members_with_revenue: number | null;
  composition_changed: boolean;
  revenue: number | null;
}

interface PublishedCombo {
  metric: string;
  agg: "weighted" | "equal";
  agg_requested: "weighted" | "equal";
  cells: PublishedCell[];
}

interface PublishedHeatmap {
  generated_from: string;
  from: string;
  tier_subsets: Record<string, Record<string, PublishedCombo>>;
  ticker_filter_unsupported: string;
}
