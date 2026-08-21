/**
 * API client.
 *
 * Same origin as the Worker that serves this bundle, so there is no base URL to
 * configure and no CORS. In `vite dev` the proxy in vite.config.ts forwards /api
 * to the deployed Worker, so the dashboard develops against real data.
 *
 * Errors are thrown as `ApiError` with the status attached. Widgets render an
 * error state from it; nothing swallows a failure into an empty array, because
 * "no data" and "the request failed" must not look the same on screen.
 */

import type {
  AnalyticsResponse,
  BucketHeatmap,
  CompanyDetail,
  HeatmapMetric,
  Health,
  Meta,
  Quality,
  TickerHeatmap,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface FilterState {
  from: string;
  to: string | null;
  buckets: string[];
  tiers: number[];
  tickers: string[];
  onlyWithData: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  from: "2026-01",
  to: null,
  buckets: [],
  tiers: [],
  tickers: [],
  onlyWithData: false,
};

/** Filters -> query string. Only non-empty values are sent, so the URL stays legible. */
export function filterParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.buckets.length) p.set("buckets", f.buckets.join(","));
  if (f.tiers.length) p.set("tiers", f.tiers.join(","));
  if (f.tickers.length) p.set("tickers", f.tickers.join(","));
  if (f.onlyWithData) p.set("only_with_data", "1");
  return p;
}

async function get<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, { headers: { accept: "application/json" } });
  } catch (err) {
    // Network-level failure: no status to report.
    throw new ApiError(err instanceof Error ? err.message : "network error", 0, path);
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string; detail?: string };
      if (body.error) detail = body.detail ? `${body.error}: ${body.detail}` : body.error;
    } catch {
      // Non-JSON error body; the status alone is the message.
    }
    throw new ApiError(detail, resp.status, path);
  }
  return (await resp.json()) as T;
}

export const api = {
  health: () => get<Health>("/api/health"),
  meta: () => get<Meta>("/api/meta"),

  analytics: (f: FilterState) => get<AnalyticsResponse>(`/api/analytics?${filterParams(f)}`),

  bucketHeatmap: (f: FilterState, metric: HeatmapMetric, agg: "weighted" | "equal") => {
    const p = filterParams(f);
    p.set("metric", metric);
    p.set("group", "bucket");
    p.set("agg", agg);
    return get<BucketHeatmap>(`/api/heatmap?${p}`);
  },

  tickerHeatmap: (f: FilterState, metric: HeatmapMetric) => {
    const p = filterParams(f);
    p.set("metric", metric);
    p.set("group", "ticker");
    return get<TickerHeatmap>(`/api/heatmap?${p}`);
  },

  company: (ticker: string) => get<CompanyDetail>(`/api/company/${encodeURIComponent(ticker)}`),

  quality: () => get<Quality>("/api/quality"),

  /** Not fetched - handed to the browser as a download. */
  exportUrl: (f: FilterState) => `/api/export.csv?${filterParams(f)}`,
};
