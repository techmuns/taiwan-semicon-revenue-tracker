/**
 * API client.
 *
 * There is no longer an API. Cloudflare D1 is gone and every endpoint the
 * Worker used to answer is a static file published by `twrev export`; this
 * module keeps the shape the components already call so that none of them had
 * to change, and delegates to ./dataset, which reads those files.
 *
 * What remains genuinely server-side is small and deliberate: /api/health, so
 * an external monitor still has something that can go red, and /auth + /logout,
 * because the session cookie is HttpOnly and only the Worker can set it.
 *
 * Same origin as the Worker that serves this bundle, so there is no base URL to
 * configure and no CORS.
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

import { csvObjectUrl } from "./csv";
import * as dataset from "./dataset";
import type { HeatmapMetric, Health } from "./types";

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

/** Re-exported so callers keep importing it from here. It lives in its own
 *  module because ./dataset raises it too, and neither should import the other. */
export { onUnauthorized } from "./unauthorized";
import { reportUnauthorized } from "./unauthorized";

async function get<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, { headers: { accept: "application/json" } });
  } catch (err) {
    // Network-level failure: no status to report.
    throw new ApiError(err instanceof Error ? err.message : "network error", 0, path);
  }
  if (resp.status === 401) reportUnauthorized();
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
  /** Still the Worker's own, and still 503 on an empty publish - see
   *  worker/src/index.ts. It is the one thing an uptime monitor can watch that
   *  a reader's own browser cannot fake. */
  health: () => get<Health>("/api/health"),

  meta: () => dataset.meta(),

  analytics: (f: FilterState) => dataset.analytics(f),

  bucketHeatmap: (f: FilterState, metric: HeatmapMetric, agg: "weighted" | "equal") =>
    dataset.bucketHeatmap(f, metric, agg),

  tickerHeatmap: (f: FilterState, metric: HeatmapMetric) => dataset.tickerHeatmap(f, metric),

  company: (ticker: string) => dataset.company(ticker),

  /**
   * The CSV download.
   *
   * Unfiltered, this is the published file - one URL, cached, nothing built.
   * Filtered, the Worker used to run the query; there is no Worker query any
   * more, so the rows the page is already holding are turned into a blob here.
   * Byte-identical to the published file either way: web/src/csv.ts and
   * ingest/src/twrev/export.py:rows_to_csv are both asserted against
   * web/fixtures/export-parity.csv.
   *
   * Returns a URL and, when it made one, the revoke that goes with it. Without
   * revoking, every filter change would leak a copy of the dataset for the life
   * of the tab.
   */
  exportCsv: async (f: FilterState): Promise<{ href: string; revoke?: () => void }> => {
    const filtered =
      Boolean(f.to) || f.buckets.length > 0 || f.tiers.length > 0 ||
      f.tickers.length > 0 || f.onlyWithData || f.from !== EMPTY_FILTERS.from;
    if (!filtered) return { href: "/data/export.csv" };
    const { rows } = await dataset.analytics(f);
    const href = csvObjectUrl(rows);
    return { href, revoke: () => URL.revokeObjectURL(href) };
  },

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
