/**
 * Read-only JSON API over the D1 analytics views.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Every value is bound, never interpolated.** Filters accept comma-separated
 *    lists, which means building `IN (?,?,?)` placeholder lists by hand - the one
 *    place a mistake would become an injection, so `inClause()` is the single
 *    helper that does it and nothing else constructs SQL from input.
 *
 * 2. **NULL is preserved as null.** Never coalesced to 0. A month a company did
 *    not file and a month it earned nothing are different facts, and the whole
 *    point of the universe-x-months grid in the view is to keep them distinct.
 *
 * The twelve-column contract lives in the `analytics_monthly` view, not here, so
 * the CSV export selects it wholesale rather than restating the column list.
 */

import { accessPosture, type AccessEnv } from "./access";
import { addMonths } from "./normalize";

export interface Env extends AccessEnv {
  DB: D1Database;
  /**
   * Optional on purpose. The [assets] binding only exists once web/ has been
   * built into worker/public, and the Worker has to be deployable before that -
   * the API and the cron are useful with no dashboard, and a required binding
   * would make the API's deploy depend on the frontend's build.
   */
  ASSETS?: Fetcher;
}

/**
 * Dec 2025 is fetched as a shoulder month for two reasons that only matter at
 * the edges: the per-company MOPS endpoint carries no 上月營收, so Jan 2026 has
 * no MoM without it, and Jan 2026's prior_month_yoy_pct needs Dec's own YoY.
 * It is real data and queryable via ?from=2025-12, but it is not part of the
 * requested Jan-Jul window, so it is excluded by default.
 */
export const DEFAULT_FROM = "2026-01";

const MONTH_RE = /^\d{4}-\d{2}$/;
const TICKER_RE = /^\d{4}[A-Z]?$/;

/** Metrics the heatmap will aggregate. A closed set - these reach a SQL column name. */
const HEATMAP_METRICS = new Set([
  "yoy_acceleration_ppt",
  "yoy_pct",
  "mom_pct",
  "cumulative_yoy_pct",
]);

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (path === "/api/health") {
      // An unhealthy answer must not be a 200, and must never be cached: a
      // monitor that only reads the status code would otherwise see green on an
      // empty database, and json() stamps every 200 as public max-age=300, so
      // the green would then be replayed for five minutes after a real recovery.
      const body = await health(env);
      return json(body, body.ok ? 200 : 503);
    }
    if (path === "/api/meta") return json(await meta(env));
    if (path === "/api/analytics") return json(await analytics(env, url));
    if (path === "/api/heatmap") {
      const body = await heatmap(env, url);
      return json(body, "error" in body ? 400 : 200);
    }
    if (path === "/api/quality") return json(await quality(env));
    if (path === "/api/export.csv") return exportCsv(env, url);

    const company = path.match(/^\/api\/company\/([^/]+)$/);
    if (company) {
      const body = await companyDetail(env, decodeURIComponent(company[1]));
      // Distinguish "you asked for a ticker that is not a ticker" from "that
      // ticker is not in this universe" - a 200 for either meant the dashboard
      // cached a not-found for five minutes and rendered it as an empty company.
      const notFound = "error" in body && String(body.error).startsWith("unknown ticker");
      return json(body, "error" in body ? (notFound ? 404 : 400) : 200);
    }

    return json({ error: "not found", path }, 404);
  } catch (err) {
    if (err instanceof BadFilterError) {
      return json({ error: "invalid filter", ...err.detail }, 400);
    }
    throw err;
  }
}

// ------------------------------------------------------------------ /health --

async function health(env: Env) {
  const out: Record<string, unknown> = {
    ok: true,
    service: "taiwan-semicon-revenue-tracker",
  };
  try {
    const row = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM universe)     AS universe_n,
              (SELECT COUNT(*) FROM raw_revenue)  AS raw_n,
              (SELECT MAX(month) FROM raw_revenue) AS latest_month`,
    ).first<{ universe_n: number; raw_n: number; latest_month: string | null }>();
    out.d1 = { bound: true, ...row };
    // Honest health: bound-but-empty is not healthy, and a green check on an
    // empty database is exactly the thing that gets deployed and forgotten.
    out.ok = (row?.raw_n ?? 0) > 0;
    if (!out.ok) out.hint = "schema present but no revenue rows - seed not loaded";
  } catch (err) {
    out.ok = false;
    out.d1 = { bound: false, error: errText(err) };
  }
  return out;
}

// -------------------------------------------------------------------- /meta --

async function meta(env: Env) {
  const [universe, months, sources, freshness, findings] = await env.DB.batch<any>([
    env.DB.prepare(
      `SELECT ticker, display_name, name_zh, bucket, tier, market_hint, status,
              successor, thesis, notes, sort_order
         FROM universe ORDER BY sort_order, ticker`,
    ),
    env.DB.prepare(`SELECT month FROM month_spine ORDER BY month_idx`),
    env.DB.prepare(
      `SELECT source_id, COUNT(*) AS rows_n, MIN(month) AS first_month,
              MAX(month) AS last_month, MAX(last_seen_utc) AS last_seen_utc
         FROM raw_revenue GROUP BY source_id ORDER BY source_id`,
    ),
    env.DB.prepare(
      // COUNT(DISTINCT ticker), not COUNT(*): raw_revenue is keyed
      // (source_id, month, ticker), so a month held by two feeds counted every
      // company once per feed. Today every 2026-07 row is mops_company so the
      // figure looks right, but the first cron run that writes _L (31) and _O
      // (5) alongside would have reported 72 of 36 names filed.
      `SELECT month, COUNT(DISTINCT ticker) AS tickers_with_data,
              MAX(last_seen_utc) AS last_seen_utc
         FROM raw_revenue WHERE revenue_month IS NOT NULL
        GROUP BY month ORDER BY month_idx`,
    ),
    env.DB.prepare(
      `SELECT severity, code, COUNT(*) AS n FROM quality_findings
        GROUP BY severity, code ORDER BY
          CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END, code`,
    ),
  ]);

  const allMonths: string[] = months.results.map((r: any) => r.month);
  const buckets = dedupeInOrder(universe.results.map((r: any) => r.bucket));

  return {
    universe: universe.results,
    buckets,
    tiers: [1, 2],
    months: allMonths,
    // The window the dashboard opens on, vs everything queryable.
    default_from: DEFAULT_FROM,
    shoulder_months: allMonths.filter((m) => m < DEFAULT_FROM),
    latest_month: allMonths.length ? allMonths[allMonths.length - 1] : null,
    sources: sources.results,
    freshness: freshness.results,
    findings_by_code: findings.results,
    access: accessPosture(env),
    // Stated once, here, so no consumer has to guess at the scale.
    units: {
      revenue: "TWD thousands",
      percentages: "percent",
      acceleration: "percentage points",
    },
  };
}

// --------------------------------------------------------------- /analytics --

interface Filters {
  from: string;
  to: string | null;
  tickers: string[];
  buckets: string[];
  tiers: number[];
  onlyWithData: boolean;
}

/**
 * Thrown when a filter parameter was supplied but nothing in it survived
 * validation. See readFilters.
 */
export class BadFilterError extends Error {
  constructor(readonly detail: { parameter: string; supplied: string; expected: string }) {
    super(`invalid ${detail.parameter}: ${detail.supplied}`);
    this.name = "BadFilterError";
  }
}

/**
 * Parse the filter parameters, REJECTING rather than silently discarding.
 *
 * Dropping an invalid value used to widen the answer instead of narrowing it:
 * whereFor only emits an IN clause for a non-empty list, so a filter that
 * validated to nothing became no filter at all. Live, before this change,
 * `?tickers=2330.TW` (a plausible pasted Yahoo symbol) returned all 37 names
 * rather than one, and `?tiers=3` did the same - the caller asked for a subset
 * and was handed the universe with a 200 and no indication anything was ignored.
 *
 * Worse, it was inconsistent in the dangerous direction: an unvalidated field
 * like `buckets` matched nothing and correctly returned 0 rows, so the same
 * class of typo narrowed one filter to empty and widened another to everything.
 *
 * A filter whose meaning could not be honoured is a client error, so it is one.
 */
function readFilters(url: URL): Filters {
  const q = url.searchParams;

  const parse = <T>(
    parameter: string,
    map: (raw: string) => T | null,
    expected: string,
  ): T[] => {
    const raw = q.get(parameter);
    const supplied = list(raw);
    // Absent, or present-but-empty (`?tickers=`), both mean "no filter".
    if (!supplied.length) return [];
    const kept = supplied.map(map).filter((v): v is T => v !== null);
    if (kept.length !== supplied.length) {
      throw new BadFilterError({ parameter, supplied: raw ?? "", expected });
    }
    return kept;
  };

  const from = q.get("from");
  if (from !== null && from !== "" && month(from) === null) {
    throw new BadFilterError({ parameter: "from", supplied: from, expected: "YYYY-MM" });
  }
  const to = q.get("to");
  if (to !== null && to !== "" && month(to) === null) {
    throw new BadFilterError({ parameter: "to", supplied: to, expected: "YYYY-MM" });
  }

  return {
    from: month(from) ?? DEFAULT_FROM,
    to: month(to),
    tickers: parse("tickers", (t) => (TICKER_RE.test(t) ? t : null), "4 digits, optionally + one A-Z"),
    buckets: list(q.get("buckets")),
    tiers: parse(
      "tiers",
      (t) => (t === "1" || t === "2" ? Number(t) : null),
      "1 or 2",
    ),
    onlyWithData: q.get("only_with_data") === "1",
  };
}

/**
 * Shared WHERE builder. Returns SQL fragments plus the bindings, in order.
 *
 * `revenueCol` exists because the two views name the same figure differently:
 * `analytics_monthly` renames it to the brief's `revenue_twd_thousands`, while
 * `analytics_base` keeps the raw-layer name `revenue_month`.
 */
function whereFor(
  f: Filters,
  opts: { prefix?: string; revenueCol?: string } = {},
): { sql: string; binds: unknown[] } {
  const { prefix = "", revenueCol = "revenue_twd_thousands" } = opts;
  const col = (name: string) => (prefix ? `${prefix}.${name}` : name);
  const clauses: string[] = [`${col("month")} >= ?`];
  const binds: unknown[] = [f.from];

  if (f.to) {
    clauses.push(`${col("month")} <= ?`);
    binds.push(f.to);
  }
  if (f.tickers.length) {
    clauses.push(`${col("ticker")} IN ${inClause(f.tickers.length)}`);
    binds.push(...f.tickers);
  }
  if (f.buckets.length) {
    clauses.push(`${col("bucket")} IN ${inClause(f.buckets.length)}`);
    binds.push(...f.buckets);
  }
  if (f.tiers.length) {
    clauses.push(`${col("tier")} IN ${inClause(f.tiers.length)}`);
    binds.push(...f.tiers);
  }
  if (f.onlyWithData) clauses.push(`${col(revenueCol)} IS NOT NULL`);

  return { sql: clauses.join(" AND "), binds };
}

/**
 * The twelve columns, ordered in supply-chain sequence.
 *
 * `a.*` is exactly the brief's twelve columns because that is what the view
 * defines - restating them would be a second place to get the order wrong. The
 * join to `universe` exists ONLY to reach `sort_order`, which the view
 * deliberately does not expose: buckets have to come out in chain order (silicon
 * -> packaging -> substrate -> ...), and alphabetising them would destroy the one
 * reading the whole tracker is built around. Relying on the view's own internal
 * ORDER BY would work today but is not guaranteed to survive query flattening.
 */
const TWELVE_COLUMN_SELECT =
  "SELECT a.* FROM analytics_monthly a JOIN universe u USING (ticker)";
const TWELVE_COLUMN_ORDER = "ORDER BY u.sort_order, a.ticker, a.month";

async function analytics(env: Env, url: URL) {
  const f = readFilters(url);
  const { sql, binds } = whereFor(f, { prefix: "a" });
  // Ordering by month text is safe: 'YYYY-MM' sorts lexicographically.
  const rows = await env.DB.prepare(
    `${TWELVE_COLUMN_SELECT} WHERE ${sql} ${TWELVE_COLUMN_ORDER}`,
  )
    .bind(...binds)
    .all();

  return { filters: f, count: rows.results.length, rows: rows.results };
}

// ----------------------------------------------------------------- /heatmap --

/**
 * Bucket-level aggregation.
 *
 * Default is REVENUE-WEIGHTED: sum(revenue) / sum(prior-year revenue) - 1 across
 * the bucket's members, i.e. the bucket treated as one portfolio. An equal-
 * weighted mean of member percentages is dominated by the smallest company in
 * the bucket, which is the wrong signal for "is this stage of the chain
 * inflecting" - a 200% move at a NT$2bn name is not comparable to a 40% move at
 * TSMC.
 *
 * Both legs must be present for a member to count, and `members` is returned so
 * a change in bucket composition between months is visible rather than silently
 * changing the denominator. Median is not offered: buckets hold 1-5 names, where
 * a median is noisier than either alternative and harder to explain.
 */
async function heatmap(env: Env, url: URL) {
  const f = readFilters(url);
  const metric = url.searchParams.get("metric") ?? "yoy_acceleration_ppt";
  if (!HEATMAP_METRICS.has(metric)) {
    return {
      error: `unknown metric ${metric}`,
      allowed: [...HEATMAP_METRICS],
    };
  }
  const group = url.searchParams.get("group") === "ticker" ? "ticker" : "bucket";
  const agg = url.searchParams.get("agg") === "equal" ? "equal" : "weighted";

  if (group === "ticker") {
    // Per-ticker there is nothing to aggregate: the metric is the metric.
    const { sql, binds } = whereFor(f, { prefix: "a" });
    const rows = await env.DB.prepare(
      `SELECT a.ticker, a.company_name, a.bucket, a.tier, a.month,
              a.${metric} AS value, a.revenue_twd_thousands AS revenue
         FROM analytics_monthly a JOIN universe u USING (ticker)
        WHERE ${sql} ORDER BY u.sort_order, a.ticker, a.month`,
    )
      .bind(...binds)
      .all();
    return { group, metric, agg: "none", filters: f, cells: rows.results };
  }

  // Aggregate over ONE MONTH MORE than the window shows, then drop it at the end.
  //
  // Acceleration at the bucket level is a difference of two consecutive monthly
  // aggregates, so the first displayed month needs the month before it to exist
  // inside the CTE. Filtering to `from` first is what made January null for every
  // stage while the per-ticker view - whose LAG runs over the whole series - had a
  // value for it. That is exactly what the Dec 2025 shoulder month was fetched
  // for; the aggregate has to reach for it too.
  const { sql, binds } = whereFor(
    { ...f, from: addMonths(f.from, -1) },
    { prefix: "b", revenueCol: "revenue_month" },
  );
  // Aggregate per bucket-month from the LEVELS, then difference consecutive
  // months for acceleration - the same recompute-from-integers rule the
  // per-ticker view follows, applied one level up.
  //
  // Every ratio has its numerator and denominator summed over the SAME member
  // set, via paired conditional aggregates. Summing all revenue over one set and
  // all prior-year revenue over another is the failure mode here: it silently
  // reports a bucket as growing because a member with no prior-year figure was
  // counted in the numerator only. Hence a `members_*` count per ratio - and the
  // ratio is emitted only when the set is non-empty.
  const rows = await env.DB.prepare(
    `WITH per_bucket AS (
       SELECT b.bucket, b.month, b.month_idx,
              SUM(CASE WHEN b.revenue_month IS NOT NULL THEN 1 ELSE 0 END) AS members,
              SUM(b.revenue_month) AS revenue,

              -- Each pair's predicate is TEXTUALLY IDENTICAL to its members_*
              -- counter, which is the only way the invariant above is actually
              -- enforced rather than merely asserted. Gating the denominator on
              -- a weaker predicate than the numerator is what breaks it: SUM
              -- skips a NULL numerator silently while the denominator still
              -- counts that member, so the ratio is computed over two different
              -- sets and the members_* count describes only one of them.
              --
              -- MoM was the live case. analytics_base is universe CROSS JOIN
              -- month_spine, and prev_revenue is a LAG over that dense grid, so
              -- it survives on a row where revenue_month is NULL - a company
              -- that filed last month but has not filed this one landed in
              -- mom_den alone. A bucket with A (1,000,000 -> 1,100,000) and B
              -- (500,000, not yet filed) reported -26.67% instead of +10.00%.
              -- That is the normal state between the 11th and 14th cron runs,
              -- which exist precisely to sweep up late filers.
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN b.revenue_month END)     AS yoy_num,
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN b.revenue_yoy_month END) AS yoy_den,
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN 1 ELSE 0 END) AS members_yoy,

              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN b.revenue_month END) AS mom_num,
              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN b.prev_revenue END)  AS mom_den,
              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN 1 ELSE 0 END) AS members_mom,

              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN b.cum_revenue END)       AS cum_num,
              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN b.cum_revenue_prior END) AS cum_den,
              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN 1 ELSE 0 END) AS members_cum,

              AVG(b.yoy_pct) AS yoy_equal,
              AVG(b.mom_pct) AS mom_equal
         FROM analytics_base b
        WHERE ${sql}
        GROUP BY b.bucket, b.month, b.month_idx
       HAVING members > 0
     ),
     calc AS (
       SELECT p.*,
         CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
              THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END AS yoy_weighted,
         CASE WHEN p.members_mom > 0 AND p.mom_den > 0
              THEN ROUND(100.0 * (p.mom_num * 1.0 / p.mom_den - 1.0), 2) END AS mom_weighted,
         CASE WHEN p.members_cum > 0 AND p.cum_den > 0
              THEN ROUND(100.0 * (p.cum_num * 1.0 / p.cum_den - 1.0), 2) END AS cum_yoy_weighted,
         LAG(p.month_idx)   OVER w AS prev_idx,
         LAG(p.members_yoy) OVER w AS prev_members_yoy,
         LAG(CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
                  THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END) OVER w
           AS prev_yoy_weighted,
         LAG(ROUND(p.yoy_equal, 2)) OVER w AS prev_yoy_equal
       FROM per_bucket p
       WINDOW w AS (PARTITION BY p.bucket ORDER BY p.month_idx)
     )
     SELECT bucket, month, revenue,
            members, members_yoy, members_mom, members_cum, prev_members_yoy,
            yoy_weighted, mom_weighted, cum_yoy_weighted,
            ROUND(yoy_equal, 2) AS yoy_equal, ROUND(mom_equal, 2) AS mom_equal,
            -- Contiguity-gated exactly as the per-ticker view gates it: across a
            -- hole, LAG would difference two non-adjacent months.
            CASE WHEN prev_idx = month_idx - 1
                 THEN ROUND(yoy_weighted - prev_yoy_weighted, 2) END
              AS acceleration_weighted,
            CASE WHEN prev_idx = month_idx - 1
                 THEN ROUND(ROUND(yoy_equal, 2) - prev_yoy_equal, 2) END
              AS acceleration_equal
       FROM calc
      WHERE month >= ?
      ORDER BY bucket, month`,
  )
    // The lookback month's own row is discarded here, after it has served as the
    // LAG for the first displayed month. Bound last because it is the last
    // placeholder in the statement text.
    .bind(...binds, f.from)
    .all();

  // Map the requested metric onto the column the aggregation produced, so the
  // client reads one `value` field regardless of which knobs were set.
  const suffix = agg === "equal" ? "equal" : "weighted";
  const pick = (r: any): number | null => {
    switch (metric) {
      case "yoy_acceleration_ppt":
        return r[`acceleration_${suffix}`] ?? null;
      case "yoy_pct":
        return r[`yoy_${suffix}`] ?? null;
      case "mom_pct":
        return r[`mom_${suffix}`] ?? null;
      case "cumulative_yoy_pct":
        // No equal-weighted variant: averaging YTD percentages across members
        // with different fiscal shapes is not a number that means anything.
        return r.cum_yoy_weighted ?? null;
      default:
        return null;
    }
  };
  const membersFor = (r: any): number =>
    metric === "mom_pct" ? r.members_mom : metric === "cumulative_yoy_pct" ? r.members_cum : r.members_yoy;

  return {
    group,
    metric,
    agg,
    filters: f,
    cells: rows.results.map((r: any) => ({
      bucket: r.bucket,
      month: r.month,
      value: pick(r),
      // The member count behind THIS metric, not behind the bucket as a whole.
      members: membersFor(r),
      members_with_revenue: r.members,
      // Surfaced so a composition change is visible next to the number it moved,
      // rather than quietly changing the denominator between two months.
      composition_changed:
        metric === "yoy_acceleration_ppt" &&
        r.prev_members_yoy != null &&
        r.prev_members_yoy !== r.members_yoy,
      revenue: r.revenue,
    })),
  };
}

// ----------------------------------------------------------------- /company --

async function companyDetail(env: Env, ticker: string) {
  if (!TICKER_RE.test(ticker)) return { error: `not a ticker: ${ticker}` };

  const [company, series, raw, history] = await env.DB.batch<any>([
    env.DB.prepare(`SELECT * FROM universe WHERE ticker = ?`).bind(ticker),
    env.DB.prepare(
      `SELECT month, revenue_month AS revenue_twd_thousands, mom_pct, yoy_pct,
              prior_month_yoy_pct, yoy_acceleration_ppt,
              cum_revenue AS cumulative_ytd_revenue_twd_thousands,
              cumulative_yoy_pct,
              revenue_yoy_month, cum_revenue_prior,
              reported_name, industry, note, source_id, market, has_data
         FROM analytics_base WHERE ticker = ? ORDER BY month_idx`,
    ).bind(ticker),
    env.DB.prepare(
      `SELECT * FROM raw_revenue WHERE ticker = ? ORDER BY month_idx, source_id`,
    ).bind(ticker),
    env.DB.prepare(
      `SELECT * FROM raw_revenue_history WHERE ticker = ?
        ORDER BY superseded_at_utc DESC LIMIT 50`,
    ).bind(ticker),
  ]);

  if (!company.results.length) return { error: `unknown ticker ${ticker}` };

  return {
    company: company.results[0],
    series: series.results,
    raw_rows: raw.results,
    // Restatements. Empty is the normal state; non-empty is the interesting one.
    restatements: history.results,
  };
}

// ----------------------------------------------------------------- /quality --

async function quality(env: Env) {
  const [coverage, gaps, findings, log, dupes] = await env.DB.batch<any>([
    // The coverage matrix, straight off the grid the view already builds.
    env.DB.prepare(
      `SELECT ticker, display_name, bucket, tier, status, month, has_data, source_id
         FROM analytics_base ORDER BY sort_order, ticker, month_idx`,
    ),
    // Interior gaps: a month with no data that has data on BOTH sides. Trailing
    // absence is a pending filing; a hole in the middle is a defect.
    env.DB.prepare(
      `WITH g AS (
         SELECT ticker, display_name, status, month, month_idx, has_data,
                LAG(has_data)  OVER w AS prev_has,
                LEAD(has_data) OVER w AS next_has
           FROM analytics_base
           WINDOW w AS (PARTITION BY ticker ORDER BY month_idx)
       )
       SELECT ticker, display_name, status, month FROM g
        WHERE has_data = 0 AND prev_has = 1 AND next_has = 1
        ORDER BY ticker, month_idx`,
    ),
    env.DB.prepare(
      `SELECT run_id, created_at_utc, severity, code, month, ticker, source_id, message
         FROM quality_findings
        ORDER BY CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
                 code, month, ticker
        LIMIT 500`,
    ),
    env.DB.prepare(
      `SELECT source_id, month, COUNT(*) AS fetches,
              SUM(ok) AS ok_n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fail_n,
              MAX(fetched_at_utc) AS last_fetch_utc
         FROM fetch_log GROUP BY source_id, month ORDER BY month, source_id`,
    ),
    // Where two surfaces both hold a (ticker, month): the rows the cross-source
    // check compares. More than one source is expected and healthy - the view
    // picks by precedence - but it should never be a surprise.
    env.DB.prepare(
      `SELECT ticker, month, COUNT(DISTINCT source_id) AS sources,
              GROUP_CONCAT(DISTINCT source_id) AS source_ids
         FROM raw_revenue GROUP BY ticker, month HAVING sources > 1
        ORDER BY month, ticker`,
    ),
  ]);

  const cells = coverage.results;
  const withData = cells.filter((c: any) => c.has_data === 1).length;
  // 6286 has no filing obligation, so counting it as missing would permanently
  // show 97.3% and train the reader to ignore the number.
  const trackable = cells.filter((c: any) => c.status !== "merged");
  const trackableWithData = trackable.filter((c: any) => c.has_data === 1).length;

  return {
    coverage: {
      cells: cells.length,
      with_data: withData,
      pct: cells.length ? round2((100 * withData) / cells.length) : null,
      trackable_cells: trackable.length,
      trackable_with_data: trackableWithData,
      trackable_pct: trackable.length
        ? round2((100 * trackableWithData) / trackable.length)
        : null,
      known_absent: cells
        .filter((c: any) => c.has_data === 0 && c.status === "merged")
        .map((c: any) => ({ ticker: c.ticker, month: c.month, status: c.status })),
    },
    matrix: cells,
    interior_gaps: gaps.results,
    findings: findings.results,
    fetch_log: log.results,
    multi_source_cells: dupes.results,
  };
}

// -------------------------------------------------------------- /export.csv --

async function exportCsv(env: Env, url: URL): Promise<Response> {
  const f = readFilters(url);
  const { sql, binds } = whereFor(f, { prefix: "a" });
  const rows = await env.DB.prepare(
    `${TWELVE_COLUMN_SELECT} WHERE ${sql} ${TWELVE_COLUMN_ORDER}`,
  )
    .bind(...binds)
    .all();

  // Column order comes from the view, which is the brief's twelve columns in the
  // specified order. The literal list is the header for an EMPTY result only -
  // a CSV with no header row is worse than one with no data rows.
  const columns = rows.results.length
    ? Object.keys(rows.results[0] as object)
    : [
        "ticker", "company_name", "bucket", "tier", "month",
        "revenue_twd_thousands", "mom_pct", "yoy_pct", "prior_month_yoy_pct",
        "yoy_acceleration_ppt", "cumulative_ytd_revenue_twd_thousands",
        "cumulative_yoy_pct",
      ];

  const lines = [columns.join(",")];
  for (const row of rows.results as Record<string, unknown>[]) {
    lines.push(columns.map((c) => csvCell(row[c])).join(","));
  }

  // The BOM is for Excel: without it, Excel reads UTF-8 CSV as the local
  // codepage and mangles every Chinese company name.
  const body = "﻿" + lines.join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="taiwan-semicon-revenue_${f.from}_${f.to ?? "latest"}.csv"`,
      "cache-control": "public, max-age=300",
    },
  });
}

/** Empty for null - NOT "0" and not "null". A blank cell reads as "no figure". */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ------------------------------------------------------------------ helpers --

/** The ONLY place a placeholder list is built. Count in, `(?,?,?)` out. */
function inClause(n: number): string {
  return `(${new Array(n).fill("?").join(",")})`;
}

function list(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function month(value: string | null): string | null {
  return value && MONTH_RE.test(value) ? value : null;
}

function dedupeInOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Monthly data. Five minutes is enough to absorb a dashboard's burst of
      // parallel widget requests without making a fresh cron run invisible.
      "cache-control": status === 200 ? "public, max-age=300" : "no-store",
    },
  });
}
