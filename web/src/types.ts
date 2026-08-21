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
  /** "active" | "merged" - "merged" means no filing obligation, not missing data. */
  status: string;
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
  access: AccessPosture;
  units: { revenue: string; percentages: string; acceleration: string };
}

export interface Health {
  ok: boolean;
  service: string;
  d1?: {
    bound: boolean;
    universe_n?: number;
    raw_n?: number;
    latest_month?: string | null;
    error?: string;
  };
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
  agg: "weighted" | "equal";
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

export interface QualityMatrixCell {
  ticker: string;
  display_name: string;
  bucket: string;
  tier: number;
  status: string;
  month: string;
  has_data: number;
  source_id: string | null;
}

export interface InteriorGap {
  ticker: string;
  display_name: string;
  status: string;
  month: string;
}

export interface Finding {
  run_id: string;
  created_at_utc: string;
  severity: string;
  code: string;
  month: string | null;
  ticker: string | null;
  source_id: string | null;
  message: string;
}

export interface FetchLogRow {
  source_id: string;
  month: string;
  fetches: number;
  ok_n: number;
  fail_n: number;
  last_fetch_utc: string | null;
}

export interface MultiSourceCell {
  ticker: string;
  month: string;
  sources: number;
  source_ids: string;
}

export interface Quality {
  coverage: {
    cells: number;
    with_data: number;
    pct: number | null;
    trackable_cells: number;
    trackable_with_data: number;
    trackable_pct: number | null;
    known_absent: { ticker: string; month: string; status: string }[];
  };
  matrix: QualityMatrixCell[];
  interior_gaps: InteriorGap[];
  findings: Finding[];
  fetch_log: FetchLogRow[];
  multi_source_cells: MultiSourceCell[];
}
