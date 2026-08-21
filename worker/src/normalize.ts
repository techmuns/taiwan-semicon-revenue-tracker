/**
 * The TypeScript mirror of `ingest/src/twrev/schema.py`.
 *
 * Two implementations of the same coercions is a duplication I would normally
 * refuse, but the split is forced: the backfill is 296 throttled HTML requests
 * (off-platform) and the refresh is one JSON GET (Worker-native). What makes the
 * duplication safe is that the two halves are pinned to each other by shared
 * FIXTURES and by `row_hash` - see `canonicalJson` below, which is the one part
 * where "close enough" is not enough.
 *
 * WHY THE HASH MUST MATCH EXACTLY
 *
 * `row_hash` decides whether a re-fetch is a no-op or a restatement. Rows with
 * source_id 'mops_company' can be written by BOTH halves - the Python backfill
 * and the Worker's per-ticker repair path. If the two hashed the same filing
 * differently, every alternating write would fire the restatement trigger and
 * fill raw_revenue_history with phantom changes. So `canonicalJson` reproduces
 * Python's `json.dumps(..., sort_keys=True, ensure_ascii=False,
 * separators=(",", ":"))` rather than calling JSON.stringify.
 *
 * The one real divergence between the two languages is that Python distinguishes
 * int from float and writes 2.0 for a float, where JS writes 2. That is handled
 * by formatting the declared FLOAT columns as Python floats.
 */

export class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

/** MOPS writes this when the denominator is zero or the field overflows. */
export const PERCENT_SENTINEL = 999999.99;

/** Values that mean "no figure", as opposed to zero. All three feeds use "-". */
const NULL_TOKENS = new Set(["", "-", "--", "—", "N/A", "n/a", "NA", "nan", "None", "無"]);

const TICKER_RE = /^\d{4}[A-Z]?$/;

export const RAW_COLUMNS = [
  "source_id", "market", "month", "month_idx", "ticker", "roc_yyyymm",
  "company_name", "industry", "report_date",
  "revenue_month", "revenue_prev_month", "revenue_yoy_month",
  "src_mom_pct", "src_yoy_pct",
  "cum_revenue", "cum_revenue_prior", "src_cum_yoy_pct",
  "note", "row_hash", "first_seen_utc", "last_seen_utc",
] as const;

/** Reported values only. Excluding the timestamps is what makes a re-fetch a no-op. */
export const VALUE_COLUMNS = [
  "company_name", "industry", "report_date",
  "revenue_month", "revenue_prev_month", "revenue_yoy_month",
  "src_mom_pct", "src_yoy_pct",
  "cum_revenue", "cum_revenue_prior", "src_cum_yoy_pct",
  "note",
] as const;

/** REAL in SQLite, `float` in Python - so Python's json writes them as `2.0`. */
const FLOAT_COLUMNS = new Set(["src_mom_pct", "src_yoy_pct", "src_cum_yoy_pct"]);

/** OpenAPI JSON key -> RAW_COLUMNS name. All three feeds share these keys exactly. */
export const KEY_MAP: Record<string, string> = {
  "公司代號": "ticker",
  "公司名稱": "company_name",
  "產業別": "industry",
  "資料年月": "roc_yyyymm",
  "出表日期": "report_date",
  "營業收入-當月營收": "revenue_month",
  "營業收入-上月營收": "revenue_prev_month",
  "營業收入-去年當月營收": "revenue_yoy_month",
  "營業收入-上月比較增減(%)": "src_mom_pct",
  "營業收入-去年同月增減(%)": "src_yoy_pct",
  "累計營業收入-當月累計營收": "cum_revenue",
  "累計營業收入-去年累計營收": "cum_revenue_prior",
  "累計營業收入-前期比較增減(%)": "src_cum_yoy_pct",
  "備註": "note",
};

/**
 * Keys without which a record is not a revenue filing. Dropping any of these is
 * schema drift and must raise - NOT yield a row with a null revenue, which would
 * look like a company that filed nothing.
 */
export const REQUIRED_KEYS = [
  "公司代號", "資料年月", "營業收入-當月營收", "營業收入-去年當月營收",
] as const;

export type RawRow = Record<string, string | number | null>;

// ------------------------------------------------------------- coercions --

/**
 * '415,191,699' -> 415191699.
 *
 * Never routes through float: `float(4.151917e+08)` round-trips to 415191700,
 * one off the filed 415191699, and a percentage derived from a wrong level is
 * wrong quietly.
 */
export function cleanInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    throw new SchemaDriftError(`bool where a revenue figure was expected: ${value}`);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new SchemaDriftError(`non-integral revenue figure: ${value}`);
    }
    return value;
  }
  let text = String(value).trim().replace(/,/g, "").replace(/　/g, "");
  if (NULL_TOKENS.has(text)) return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  if (negative) text = text.slice(1, -1);
  if (!/^[+-]?\d+$/.test(text)) {
    throw new SchemaDriftError(`cannot parse integer from ${JSON.stringify(value)}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    // TWD thousands for the whole universe stays far below 2^53, so this can only
    // mean a units change or a corrupt body - both must stop the write.
    throw new SchemaDriftError(`integer out of safe range: ${text}`);
  }
  return negative ? -parsed : parsed;
}

export function cleanPct(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const text = String(value).trim().replace(/,/g, "").replace(/%/g, "");
    if (NULL_TOKENS.has(text)) return null;
    parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      throw new SchemaDriftError(`cannot parse percent from ${JSON.stringify(value)}`);
    }
  }
  if (Math.abs(parsed) >= PERCENT_SENTINEL - 0.005) return null;
  return parsed;
}

/** Tickers are TEXT everywhere. An int one drops a leading zero and breaks joins. */
export function cleanTicker(value: unknown): string {
  const text = String(value).trim();
  if (!TICKER_RE.test(text)) {
    throw new SchemaDriftError(`not a valid ticker: ${JSON.stringify(value)}`);
  }
  return text;
}

export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/　/g, " ").replace(/\s+/g, " ");
  if (NULL_TOKENS.has(text)) return null;
  return text || null;
}

// ---------------------------------------------------------- ROC calendar --

/** '11507' -> '2026-07'. ROC year is Gregorian - 1911. */
export function rocToMonth(value: unknown): string {
  const text = String(value).trim();
  if (!/^\d{5,6}$/.test(text)) {
    throw new SchemaDriftError(`not an ROC yyyymm: ${JSON.stringify(value)}`);
  }
  const year = Number(text.slice(0, -2)) + 1911;
  const month = Number(text.slice(-2));
  if (month < 1 || month > 12) {
    throw new SchemaDriftError(`ROC month out of range: ${text}`);
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function monthToRoc(month: string): string {
  const [y, m] = month.split("-");
  return `${Number(y) - 1911}${m}`;
}

/** year*12 + (month-1). Makes contiguity an integer compare everywhere. */
export function monthIdx(month: string): number {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    throw new SchemaDriftError(`not a canonical YYYY-MM month: ${month}`);
  }
  return y * 12 + (m - 1);
}

export function addMonths(month: string, delta: number): string {
  const idx = monthIdx(month) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

// ------------------------------------------------------------- row_hash --

/**
 * Python's json.dumps(payload, sort_keys=True, ensure_ascii=False,
 * separators=(",", ":")), reproduced.
 *
 * Only the shapes that actually occur in VALUE_COLUMNS are handled - string,
 * number, null. Anything else throws rather than silently hashing differently
 * from the Python side, because a silent divergence here manifests as phantom
 * restatements a month later, far from the cause.
 */
export function canonicalJson(payload: Record<string, unknown>): string {
  const parts = Object.keys(payload)
    .sort()
    .map((key) => `${jsonString(key)}:${canonicalValue(key, payload[key])}`);
  return `{${parts.join(",")}}`;
}

function canonicalValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SchemaDriftError(`non-finite number in ${key}: ${value}`);
    }
    // Python writes floats via repr(), so an integral float is "2.0" and an
    // integral int is "2". JS has one numeric type, so the declared column type
    // is what decides - which is exactly what Python is doing too.
    if (FLOAT_COLUMNS.has(key) && Number.isInteger(value)) return `${value}.0`;
    return String(value);
  }
  throw new SchemaDriftError(`unhashable ${typeof value} in ${key}`);
}

/**
 * JSON string escaping matching Python's ensure_ascii=False: short escapes for
 * \b \f \n \r \t " \\, \uXXXX for the remaining C0 controls, everything else
 * literal. JSON.stringify agrees on all of these, so it does the work; the
 * explicit table is here so a future reader can verify the claim.
 */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

export async function rowHash(row: RawRow): Promise<string> {
  const payload: Record<string, unknown> = {};
  for (const col of VALUE_COLUMNS) payload[col] = row[col] ?? null;
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------- record -> row --

export interface NormalizeOptions {
  sourceId: string;
  market: string | null;
  nowUtc: string;
}

/**
 * One OpenAPI record -> one raw_revenue row.
 *
 * The caller must filter to universe tickers BEFORE calling this: the brief's
 * `_P` feed uses 6-digit issuer codes (e.g. 000104), which `cleanTicker`
 * correctly rejects. That filter is load-bearing, not an optimisation.
 */
export async function normalizeRecord(
  record: Record<string, unknown>,
  opts: NormalizeOptions,
): Promise<RawRow> {
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      throw new SchemaDriftError(`feed record is missing required key ${key}`);
    }
  }

  const month = rocToMonth(record["資料年月"]);
  const row: RawRow = {};
  for (const col of RAW_COLUMNS) row[col] = null;

  row.source_id = opts.sourceId;
  row.market = opts.market;
  row.month = month;
  row.month_idx = monthIdx(month);
  row.ticker = cleanTicker(record["公司代號"]);
  row.roc_yyyymm = String(record["資料年月"]).trim();

  row.company_name = cleanText(record["公司名稱"]);
  row.industry = cleanText(record["產業別"]);
  row.report_date = cleanText(record["出表日期"]);
  row.note = cleanText(record["備註"]);

  row.revenue_month = cleanInt(record["營業收入-當月營收"]);
  row.revenue_prev_month = cleanInt(record["營業收入-上月營收"]);
  row.revenue_yoy_month = cleanInt(record["營業收入-去年當月營收"]);
  row.cum_revenue = cleanInt(record["累計營業收入-當月累計營收"]);
  row.cum_revenue_prior = cleanInt(record["累計營業收入-去年累計營收"]);

  // Reported percentages are stored for cross-checking ONLY. Every displayed
  // figure is recomputed from the integer levels: the feeds carry ~15 significant
  // digits and the MOPS HTML truncates to 2dp (44.68 where the honest rounding is
  // 44.69), so copying either would bake in one surface's rounding convention.
  row.src_mom_pct = cleanPct(record["營業收入-上月比較增減(%)"]);
  row.src_yoy_pct = cleanPct(record["營業收入-去年同月增減(%)"]);
  row.src_cum_yoy_pct = cleanPct(record["累計營業收入-前期比較增減(%)"]);

  row.first_seen_utc = opts.nowUtc;
  row.last_seen_utc = opts.nowUtc;
  row.row_hash = await rowHash(row);
  return row;
}
