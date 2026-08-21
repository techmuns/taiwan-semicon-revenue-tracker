/**
 * The whole view lives in the URL.
 *
 * Tab, month window, tier and stage filters, selected company, heatmap metric and
 * aggregation - all of it. A dashboard whose state is invisible in the address bar
 * cannot be cited: "look at Substrate/PCB in June" becomes a set of instructions
 * instead of a link. It also makes the back button work, and makes a reload land
 * where the reader was rather than at the default screen.
 */

import { EMPTY_FILTERS } from "./api";
import type { FilterState } from "./api";
import type { HeatmapMetric } from "./types";
import { TABS } from "./components/Header";
import type { Tab } from "./components/Header";

export interface ViewState {
  tab: Tab;
  filters: FilterState;
  ticker: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  /** True when the URL carried an explicit `from`, so the server default must not override it. */
  fromExplicit: boolean;
}

const METRICS: HeatmapMetric[] = [
  "yoy_acceleration_ppt",
  "yoy_pct",
  "mom_pct",
  "cumulative_yoy_pct",
];

function list(p: URLSearchParams, key: string): string[] {
  const raw = p.get(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function readView(): ViewState {
  const p = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const tabParam = p.get("tab");
  const tab = (TABS.find((t) => t.value === tabParam)?.value ?? "overview") as Tab;
  const metricParam = p.get("metric");
  const metric = METRICS.includes(metricParam as HeatmapMetric)
    ? (metricParam as HeatmapMetric)
    : "yoy_acceleration_ppt";
  const from = p.get("from");

  return {
    tab,
    ticker: p.get("ticker"),
    metric,
    agg: p.get("agg") === "equal" ? "equal" : "weighted",
    fromExplicit: from !== null,
    filters: {
      from: from ?? EMPTY_FILTERS.from,
      to: p.get("to"),
      buckets: list(p, "buckets"),
      tiers: list(p, "tiers")
        .map(Number)
        .filter((n) => Number.isFinite(n)),
      tickers: list(p, "tickers"),
      onlyWithData: p.get("only") === "1",
    },
  };
}

/**
 * Written with replaceState, not pushState.
 *
 * Every filter tick would otherwise become a history entry, and the back button
 * would walk backwards one chip at a time instead of leaving the dashboard.
 */
export function writeView(v: ViewState): void {
  if (typeof location === "undefined") return;
  const p = new URLSearchParams();
  if (v.tab !== "overview") p.set("tab", v.tab);
  p.set("from", v.filters.from);
  if (v.filters.to) p.set("to", v.filters.to);
  if (v.filters.buckets.length) p.set("buckets", v.filters.buckets.join(","));
  if (v.filters.tiers.length) p.set("tiers", v.filters.tiers.join(","));
  if (v.filters.tickers.length) p.set("tickers", v.filters.tickers.join(","));
  if (v.filters.onlyWithData) p.set("only", "1");
  if (v.ticker) p.set("ticker", v.ticker);
  if (v.metric !== "yoy_acceleration_ppt") p.set("metric", v.metric);
  if (v.agg !== "weighted") p.set("agg", v.agg);
  const next = `${location.pathname}?${p.toString()}`;
  if (next !== `${location.pathname}${location.search}`) {
    history.replaceState(null, "", next);
  }
}

/**
 * The months the current window covers, from the API's own month list.
 *
 * Derived from `meta.months` rather than from the returned rows on purpose: a month
 * where nobody filed still has to appear as a column, hatched. Deriving columns from
 * the data would make an empty month vanish, which is the one thing it must not do.
 */
export function windowMonths(months: string[], filters: FilterState): string[] {
  return months.filter((m) => m >= filters.from && (!filters.to || m <= filters.to));
}
