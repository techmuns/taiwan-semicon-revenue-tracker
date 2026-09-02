/**
 * The API's shapes, mirrored.
 *
 * Every numeric field that can be absent is typed `number | null`, never
 * `number | undefined` and never just `number`. That is not defensive typing -
 * it is the contract: the API preserves NULL as null rather than coalescing to
 * 0, because a month a company did not file and a month it earned nothing are
 * different facts. The types make it impossible to forget which one you have.
 */

export interface UniverseRow {
  ticker: string;
  display_name: string;
  name_zh: string | null;
  bucket: string;
  tier: number;
  market_hint: string | null;
  /** "active" | "merged" | "delisted" | "suspended" - not all of them owe a filing. */
  status: string;
  /** The months this company owed a filing. Null means unbounded on that side. */
  active_from: string | null;
  active_to: string | null;
  successor: string | null;
  thesis: string | null;
  notes: string | null;
  sort_order: number;
}

/** The brief's twelve columns, as the `analytics_monthly` view defines them. */
export interface AnalyticsRow {
  ticker: string;
  company_name: string;
  bucket: string;
  tier: number;
  month: string;
  revenue_twd_thousands: number | null;
  mom_pct: number | null;
  yoy_pct: number | null;
  prior_month_yoy_pct: number | null;
  yoy_acceleration_ppt: number | null;
  cumulative_ytd_revenue_twd_thousands: number | null;
  cumulative_yoy_pct: number | null;
}

export interface SourceSummary {
  source_id: string;
  rows_n: number;
  first_month: string | null;
  last_month: string | null;
  last_seen_utc: string | null;
}

export interface FreshnessRow {
  month: string;
  tickers_with_data: number;
  last_seen_utc: string | null;
}

/**
 * What the reader has to be told, wherever they are. Lives on /api/meta because
 * meta is in hand on every tab and there is no Quality tab left to open.
 */
export interface Alerts {
  /** A filed month missing between two filed months: the fetch failed, not the filer. */
  interior_gaps: { ticker: string; display_name: string; month: string }[];
  /** error and warn only - `info` is per-company colour, already on the company. */
  severe_findings: {
    severity: string;
    code: string;
    ticker: string | null;
    month: string | null;
    message: string;
  }[];
  /**
   * How many error/warn findings there ACTUALLY are. `severe_findings` is capped
   * at 20; this is not. Render this as the count, never the array's length.
   */
  severe_total?: number;
  /** Filers whose revenue LEVELS are not comparable with the standalone filers. */
  consolidated: { ticker: string; display_name: string }[];
}

export interface FindingCount {
  severity: string;
  code: string;
  n: number;
}

export interface AccessPosture {
  mode: "open" | "secret" | "cf-access";
  public: boolean;
  note: string;
}

export interface Meta {
  universe: UniverseRow[];
  buckets: string[];
  tiers: number[];
  months: string[];
  default_from: string;
  shoulder_months: string[];
  latest_month: string | null;
  sources: SourceSummary[];
  freshness: FreshnessRow[];
  findings_by_code: FindingCount[];
  alerts: Alerts;
  access: AccessPosture;
  units: { revenue: string; percentages: string; acceleration: string };
}

export interface Health {
  ok: boolean;
  service: string;
  /**
   * The LIVE access posture, evaluated by the Worker from its own secrets.
   *
   * `Meta.access` cannot be trusted for this: it is written by an exporter on a
   * GitHub runner, which cannot see those secrets, so it is frozen at "open".
   * This field is the one that reflects reality, and it is present on the
   * failure branches too - a broken publish must not also hide whether the
   * dashboard is gated.
   */
  access?: AccessPosture;
  /** Absent on the 503 branches, which carry `error` instead. */
  data?: {
    source: string;
    universe_n: number;
    months: number;
    latest_month?: string;
    generated_at_utc: string | null;
  };
  error?: string;
  hint?: string;
}

export type HeatmapMetric =
  | "yoy_acceleration_ppt"
  | "yoy_pct"
  | "mom_pct"
  | "cumulative_yoy_pct";

export interface BucketCell {
  bucket: string;
  month: string;
  value: number | null;
  /** Members behind THIS metric, not behind the bucket as a whole. */
  members: number;
  members_with_revenue: number;
  /** True when the member set changed vs the prior month, so the denominator moved. */
  composition_changed: boolean;
  revenue: number | null;
}

export interface TickerCell {
  ticker: string;
  company_name: string;
  bucket: string;
  tier: number;
  month: string;
  value: number | null;
  revenue: number | null;
}

export interface Filters {
  from: string;
  to: string | null;
  tickers: string[];
  buckets: string[];
  tiers: number[];
  onlyWithData: boolean;
}

export interface BucketHeatmap {
  group: "bucket";
  metric: HeatmapMetric;
  /**
   * The aggregation the SERVER APPLIED, which is not always the one requested -
   * cumulative YoY has no equal-weighted variant. Label figures from this, never
   * from the local toggle state, or the caption and the maths can disagree.
   */
  agg: "weighted" | "equal";
  /** What was asked for. Differs from `agg` only when it could not be honoured. */
  agg_requested?: "weighted" | "equal";
  filters: Filters;
  cells: BucketCell[];
}

export interface TickerHeatmap {
  group: "ticker";
  metric: HeatmapMetric;
  agg: "none";
  filters: Filters;
  cells: TickerCell[];
}

export interface AnalyticsResponse {
  filters: Filters;
  count: number;
  rows: AnalyticsRow[];
}

export interface CompanySeriesRow {
  month: string;
  revenue_twd_thousands: number | null;
  mom_pct: number | null;
  yoy_pct: number | null;
  prior_month_yoy_pct: number | null;
  yoy_acceleration_ppt: number | null;
  cumulative_ytd_revenue_twd_thousands: number | null;
  cumulative_yoy_pct: number | null;
  revenue_yoy_month: number | null;
  cum_revenue_prior: number | null;
  reported_name: string | null;
  industry: string | null;
  note: string | null;
  source_id: string | null;
  market: string | null;
  has_data: number;
}

export interface RestatementRow {
  ticker: string;
  month: string;
  superseded_at_utc: string;
  [key: string]: unknown;
}

export interface RawRow {
  ticker: string;
  month: string;
  source_id: string;
  revenue_month: number | null;
  [key: string]: unknown;
}

export interface CompanyDetail {
  company: UniverseRow;
  series: CompanySeriesRow[];
  raw_rows: RawRow[];
  restatements: RestatementRow[];
}

/*
 * The /api/quality types used to live here. The endpoint still exists and still
 * returns the coverage matrix, every finding and the fetch log - it is the
 * operator's record and the runbook's post-deploy check curls it - but nothing
 * in the UI reads it any more. What a reader needs from it now arrives on
 * /api/meta as `alerts`, above.
 */
