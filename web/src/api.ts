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
 *
 * One status is handled here rather than by the widget that happened to hit it:
 * 401. When the Worker is in `secret` mode a credential is missing for the whole
 * dashboard, not for one card, so a 401 is published to a subscriber (App) that
 * shows the unlock screen. Left to the widgets it would draw six identical
 * "unauthorized" error cards and no way to fix any of them.
 */

import type {
  AnalyticsResponse,
  BucketHeatmap,
  CompanyDetail,
  HeatmapMetric,
  Health,
  Meta,
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

// -------------------------------------------------------------- 401 signal --

const lockListeners = new Set<() => void>();

/**
 * Subscribe to "the API says we have no credential". Returns an unsubscribe, so
 * it drops straight into a useEffect.
 */
export function onUnauthorized(fn: () => void): () => void {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

async function get<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, { headers: { accept: "application/json" } });
  } catch (err) {
    // Network-level failure: no status to report.
    throw new ApiError(err instanceof Error ? err.message : "network error", 0, path);
  }
  if (resp.status === 401) for (const fn of lockListeners) fn();
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

  /** Not fetched - handed to the browser as a download. */
  exportUrl: (f: FilterState) => `/api/export.csv?${filterParams(f)}`,

  /**
   * Exchange the shared key for the session cookie. POST, never a query string:
   * a key in a URL lands in browser history, in any proxy's logs, and in
   * Cloudflare's own request logs. The cookie the Worker sets is HttpOnly, so
   * this is the last time any JavaScript here sees the key - it is not stored.
   *
   * Resolves true on acceptance, false on rejection. A wrong key is an expected
   * outcome of a login form, not an exception.
   */
  auth: async (key: string): Promise<boolean> => {
    const resp = await fetch("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return resp.ok;
  },

  /** Clear the session cookie. The only write this dashboard performs. */
  logout: async (): Promise<void> => {
    await fetch("/logout", { method: "POST" });
  },
};
