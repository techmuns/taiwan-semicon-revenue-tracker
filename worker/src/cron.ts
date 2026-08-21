/**
 * The monthly refresh.
 *
 * Taiwan requires monthly revenue disclosure by the 10th of the following month,
 * so the trigger fires on the 11th, 14th and 18th (UTC). The 14th and 18th exist
 * for late filers and restatements; because every write is hash-gated, a run that
 * finds nothing new is a no-op rather than a duplicate.
 *
 * THE MONTH COMES FROM THE PAYLOAD, NEVER FROM THE CLOCK
 *
 * All three feeds are latest-month snapshots carrying 資料年月. Deriving the month
 * from `new Date()` would, on a run before the filings land, file the prior
 * month's figures under the current month - a corruption with no visible symptom.
 * The clock is used for exactly one thing: deciding what month we EXPECT, so that
 * "the feed is still showing June" can be reported as the normal pre-deadline
 * state rather than as a silent nothing-happened.
 *
 * THE FEED ORDER COMES FROM D1
 *
 * `source_feed` is seeded from config/sources.yaml, which states the intent: the
 * brief's `t187ap05_P` stays first in precedence, and the precedence is config
 * rather than code. A live check found `_P` carries none of the 37 names (it is
 * the 公開發行公司 dataset), so the run walks on to the declared fallbacks and
 * records SOURCE_EMPTY - which makes the brief's endpoint behaving as observed
 * legible in the data instead of looking like a broken cron.
 */

import type { Env } from "./api";
import {
  KEY_MAP,
  RAW_COLUMNS,
  SchemaDriftError,
  normalizeRecord,
  rocToMonth,
  type RawRow,
} from "./normalize";
import { SOURCE_ID as MOPS_SOURCE_ID, parseMops, urlFor } from "./mops";

type Severity = "info" | "warn" | "error";
interface Finding {
  severity: Severity;
  code: string;
  month?: string | null;
  ticker?: string | null;
  sourceId?: string | null;
  message: string;
}

interface Feed {
  source_id: string;
  role: string;
  url: string;
  market: string | null;
  expect_min_records: number;
  expect_target_coverage: number;
  anchor_tickers: string;
  notes: string | null;
  precedence: number;
}

interface UniverseRow {
  ticker: string;
  display_name: string;
  tier: number;
  status: string;
}

export interface RefreshResult {
  run_id: string;
  cron: string;
  expected_month: string;
  months_written: string[];
  rows_upserted: number;
  feeds: { source_id: string; ok: boolean; records: number; covered: number; note?: string }[];
  repaired: string[];
  findings: Finding[];
}

const UPSERT_SQL = (() => {
  const cols = RAW_COLUMNS.join(", ");
  const vals = RAW_COLUMNS.map(() => "?").join(", ");
  // first_seen_utc is deliberately excluded from the SET clause so the original
  // sighting date survives a restatement. Identical to the Python seed's rule.
  const sets = RAW_COLUMNS.filter((c) => c !== "first_seen_utc")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return `INSERT INTO raw_revenue (${cols}) VALUES (${vals})
          ON CONFLICT (source_id, month, ticker) DO UPDATE SET ${sets}`;
})();

export async function runRefresh(env: Env, cron = "manual"): Promise<RefreshResult> {
  const nowUtc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const runId = `cron-${nowUtc}`;
  const findings: Finding[] = [];

  const [feedsRes, universeRes, configRes] = await env.DB.batch<any>([
    env.DB.prepare(`SELECT * FROM source_feed ORDER BY precedence`),
    env.DB.prepare(`SELECT ticker, display_name, tier, status FROM universe ORDER BY sort_order`),
    env.DB.prepare(`SELECT key, value FROM source_config`),
  ]);

  const feeds = feedsRes.results as Feed[];
  const universe = universeRes.results as UniverseRow[];
  const config = Object.fromEntries(
    (configRes.results as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );

  if (!feeds.length || !universe.length) {
    // Refusing to guess is the point: a Worker with a hardcoded fallback list
    // would appear to work while silently ignoring config/sources.yaml.
    const message =
      `source_feed has ${feeds.length} rows and universe has ${universe.length} - ` +
      `apply ingest/out/seed.sql before the cron can run`;
    await writeFindings(env, runId, nowUtc, [
      { severity: "error", code: "NOT_SEEDED", message },
    ]);
    throw new Error(message);
  }

  const expectedMonth = latestExpectedMonth(new Date(nowUtc));
  const result: RefreshResult = {
    run_id: runId,
    cron,
    expected_month: expectedMonth,
    months_written: [],
    rows_upserted: 0,
    feeds: [],
    repaired: [],
    findings,
  };

  const trackable = universe.filter((u) => u.status !== "merged");
  const trackableSet = new Set(trackable.map((u) => u.ticker));
  const monthsWritten = new Set<string>();
  const covered = new Set<string>();

  // ------------------------------------------------------ walk the feeds --
  for (const feed of feeds) {
    const outcome = await ingestFeed(env, feed, {
      runId, nowUtc, expectedMonth, trackableSet, findings,
    });
    result.feeds.push({
      source_id: feed.source_id,
      ok: outcome.ok,
      records: outcome.records,
      covered: outcome.covered.length,
      note: outcome.note,
    });
    result.rows_upserted += outcome.rows;
    if (outcome.month) monthsWritten.add(outcome.month);
    for (const t of outcome.covered) covered.add(t);
  }

  // -------------------------------------------------- repair what is left --
  // Only for the month the feeds actually spoke about. Repairing a month nobody
  // published would be 37 pointless requests returning 查無需求資料.
  const month = monthsWritten.size === 1 ? [...monthsWritten][0] : null;
  if (month) {
    const missing = await missingTickers(env, month, trackable);
    // Tier 1 only. Tier 2 is a control group; spending the cron's subrequest
    // budget repairing it would risk the names the thesis actually rests on.
    const repairable = missing.filter((u) => u.tier === 1);
    if (missing.length) {
      findings.push({
        severity: repairable.length ? "warn" : "info",
        code: "MISSING_TICKER_MONTH",
        month,
        message:
          `${missing.length} trackable name(s) absent after all feeds: ` +
          missing.map((u) => `${u.ticker} ${u.display_name} (tier ${u.tier})`).join(", ") +
          (repairable.length ? `; repairing ${repairable.length} tier-1 via MOPS` : ""),
      });
    }
    for (const u of repairable) {
      const repaired = await repairOne(env, u, month, config, { runId, nowUtc, findings });
      if (repaired) {
        result.repaired.push(u.ticker);
        result.rows_upserted += 1;
        covered.add(u.ticker);
      }
    }
  } else if (monthsWritten.size > 1) {
    findings.push({
      severity: "error",
      code: "MULTI_MONTH_RUN",
      message:
        `feeds reported different months (${[...monthsWritten].join(", ")}) - ` +
        `skipping the repair pass, since which month is authoritative is ambiguous`,
    });
  }

  // ----------------------------------------------------- quality checks --
  if (month) {
    findings.push(...(await crossSourceCheck(env, month)));
    findings.push(...(await plausibilityCheck(env, month)));
  }

  result.months_written = [...monthsWritten].sort();
  await writeFindings(env, runId, nowUtc, findings, month);

  const errors = findings.filter((f) => f.severity === "error").length;
  console.log(
    `cron ${cron} run=${runId} month=${month ?? "none"} rows=${result.rows_upserted} ` +
      `covered=${covered.size}/${trackable.length} repaired=${result.repaired.length} ` +
      `findings=${findings.length} errors=${errors}`,
  );
  return result;
}

// ------------------------------------------------------------- one feed --

interface FeedContext {
  runId: string;
  nowUtc: string;
  expectedMonth: string;
  trackableSet: Set<string>;
  findings: Finding[];
}

interface FeedOutcome {
  ok: boolean;
  records: number;
  rows: number;
  covered: string[];
  month: string | null;
  note?: string;
}

async function ingestFeed(env: Env, feed: Feed, ctx: FeedContext): Promise<FeedOutcome> {
  const { findings } = ctx;
  const empty: FeedOutcome = { ok: false, records: 0, rows: 0, covered: [], month: null };

  let body: string;
  let status = 0;
  try {
    const resp = await fetch(feed.url, {
      headers: { accept: "application/json" },
      // The feeds are monthly snapshots; Cloudflare's cache would happily serve a
      // stale copy across the filing deadline, which is the one moment it matters.
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    status = resp.status;
    body = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      severity: "error", code: "FETCH_FAILED", sourceId: feed.source_id,
      message: `${feed.source_id}: ${message} (${feed.url})`,
    });
    await logFetch(env, {
      source_id: feed.source_id, month: null, ticker: null, url: feed.url,
      http_status: status, byte_len: 0, sha256: null, rows_parsed: 0,
      ok: 0, error: message, fetched_at_utc: ctx.nowUtc,
    });
    return empty;
  }

  let records: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    records = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      severity: "error", code: "BAD_BODY", sourceId: feed.source_id,
      message: `${feed.source_id}: ${message} (${body.length} bytes)`,
    });
    await logFetch(env, {
      source_id: feed.source_id, month: null, ticker: null, url: feed.url,
      http_status: status, byte_len: body.length, sha256: await sha256(body),
      rows_parsed: 0, ok: 0, error: message, fetched_at_utc: ctx.nowUtc,
    });
    return empty;
  }

  if (records.length < feed.expect_min_records) {
    // A partial publication looks exactly like a complete one, so the only
    // defence is knowing roughly how many records to expect.
    findings.push({
      severity: "warn", code: "RECORD_COUNT_LOW", sourceId: feed.source_id,
      message:
        `${feed.source_id}: ${records.length} records, expected at least ` +
        `${feed.expect_min_records} - possible partial publication`,
    });
  }

  const anchors: string[] = safeJsonArray(feed.anchor_tickers);
  const present = new Set(records.map((r) => String(r["公司代號"] ?? "").trim()));
  const missingAnchors = anchors.filter((a) => !present.has(a));
  if (missingAnchors.length) {
    findings.push({
      severity: "error", code: "ANCHOR_MISSING", sourceId: feed.source_id,
      message:
        `${feed.source_id}: anchor ticker(s) ${missingAnchors.join(", ")} absent - ` +
        `this may not be the dataset we think it is; not writing`,
    });
    await logFetch(env, {
      source_id: feed.source_id, month: null, ticker: null, url: feed.url,
      http_status: status, byte_len: body.length, sha256: await sha256(body),
      rows_parsed: 0, ok: 0, error: "ANCHOR_MISSING", fetched_at_utc: ctx.nowUtc,
    });
    return { ...empty, records: records.length };
  }

  // Filter to the universe BEFORE building rows. Load-bearing, not an
  // optimisation: `_P` carries 6-digit issuer codes (e.g. 000104) which
  // cleanTicker correctly rejects, so normalising every record would throw.
  const mine = records.filter((r) =>
    ctx.trackableSet.has(String(r["公司代號"] ?? "").trim()),
  );

  if (!mine.length) {
    const note =
      feed.expect_target_coverage === 0
        ? `covers none of the universe as expected (${records.length} records); ` +
          `continuing down the fallback chain`
        : `covers none of the universe but ${feed.expect_target_coverage} were expected`;
    findings.push({
      severity: feed.expect_target_coverage === 0 ? "info" : "error",
      code: "SOURCE_EMPTY", sourceId: feed.source_id,
      message: `${feed.source_id} (${feed.role}): ${note}`,
    });
    await logFetch(env, {
      source_id: feed.source_id, month: null, ticker: null, url: feed.url,
      http_status: status, byte_len: body.length, sha256: await sha256(body),
      rows_parsed: 0, ok: 1, error: null, fetched_at_utc: ctx.nowUtc,
    });
    return { ...empty, ok: true, records: records.length, note };
  }

  // Drift check on the keys, once per feed rather than per record.
  const sample = mine[0];
  const unknown = Object.keys(sample).filter((k) => !(k in KEY_MAP));
  if (unknown.length) {
    findings.push({
      severity: "info", code: "NEW_FEED_KEY", sourceId: feed.source_id,
      message: `${feed.source_id}: unmapped key(s) ${unknown.join(", ")} - ignored`,
    });
  }

  let month: string;
  try {
    month = rocToMonth(sample["資料年月"]);
  } catch (err) {
    findings.push({
      severity: "error", code: "BAD_MONTH", sourceId: feed.source_id,
      message: `${feed.source_id}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ...empty, records: records.length };
  }

  const monthsSeen = new Set(mine.map((r) => String(r["資料年月"] ?? "").trim()));
  if (monthsSeen.size > 1) {
    // These feeds are documented single-month snapshots. Two months voids that
    // assumption, and nothing may be persisted from a body whose month is
    // ambiguous - one of them would be filed under the wrong key.
    findings.push({
      severity: "error", code: "MULTI_MONTH_SNAPSHOT", sourceId: feed.source_id,
      message:
        `${feed.source_id}: records span ${[...monthsSeen].join(", ")} - a ` +
        `single-month snapshot was expected; not writing`,
    });
    return { ...empty, records: records.length };
  }

  if (month < ctx.expectedMonth) {
    // The normal pre-deadline state, reported so a run that legitimately wrote
    // nothing new is distinguishable from one that failed.
    findings.push({
      severity: "info", code: "MONTH_NOT_YET_PUBLISHED", month, sourceId: feed.source_id,
      message:
        `${feed.source_id}: still showing ${month}; ${ctx.expectedMonth} is expected ` +
        `by now. Re-upserting ${month} is a no-op unless it was restated.`,
    });
  }

  const rows: RawRow[] = [];
  for (const record of mine) {
    try {
      rows.push(await normalizeRecord(record, {
        sourceId: feed.source_id,
        market: feed.market,
        nowUtc: ctx.nowUtc,
      }));
    } catch (err) {
      const ticker = String(record["公司代號"] ?? "?");
      findings.push({
        severity: err instanceof SchemaDriftError ? "error" : "warn",
        code: "NORMALIZE_FAILED", month, ticker, sourceId: feed.source_id,
        message: `${feed.source_id} ${ticker}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (rows.length < feed.expect_target_coverage) {
    const got = new Set(rows.map((r) => String(r.ticker)));
    const lost = [...ctx.trackableSet].filter((t) => !got.has(t));
    findings.push({
      severity: "warn", code: "COVERAGE_DROPPED", month, sourceId: feed.source_id,
      message:
        `${feed.source_id}: covered ${rows.length} of the expected ` +
        `${feed.expect_target_coverage}. Not on this feed: ${lost.join(", ")}`,
    });
  }

  await upsert(env, rows);
  await logFetch(env, {
    source_id: feed.source_id, month, ticker: null, url: feed.url,
    http_status: status, byte_len: body.length, sha256: await sha256(body),
    rows_parsed: rows.length, ok: 1, error: null, fetched_at_utc: ctx.nowUtc,
  });

  return {
    ok: true,
    records: records.length,
    rows: rows.length,
    covered: rows.map((r) => String(r.ticker)),
    month,
  };
}

// ------------------------------------------------------- the repair path --

async function missingTickers(
  env: Env,
  month: string,
  trackable: UniverseRow[],
): Promise<UniverseRow[]> {
  const res = await env.DB.prepare(
    `SELECT DISTINCT ticker FROM raw_revenue
      WHERE month = ? AND revenue_month IS NOT NULL`,
  )
    .bind(month)
    .all<{ ticker: string }>();
  const have = new Set(res.results.map((r) => r.ticker));
  return trackable.filter((u) => !have.has(u.ticker));
}

async function repairOne(
  env: Env,
  company: UniverseRow,
  month: string,
  config: Record<string, string>,
  ctx: { runId: string; nowUtc: string; findings: Finding[] },
): Promise<boolean> {
  const template = config.backfill_url_template;
  if (!template) {
    ctx.findings.push({
      severity: "warn", code: "NO_REPAIR_TEMPLATE", month, ticker: company.ticker,
      message: "source_config has no backfill_url_template - cannot repair via MOPS",
    });
    return false;
  }
  const url = urlFor(company.ticker, month, template);
  let body = "";
  let status = 0;
  try {
    const resp = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
    status = resp.status;
    body = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const outcome = await parseMops(body, {
      ticker: company.ticker, month, nowUtc: ctx.nowUtc,
    });
    ctx.findings.push(
      ...outcome.findings.map((f) => ({
        ...f, month, ticker: company.ticker, sourceId: MOPS_SOURCE_ID,
      })),
    );
    if (outcome.row) {
      await upsert(env, [outcome.row]);
      await logFetch(env, {
        source_id: MOPS_SOURCE_ID, month, ticker: company.ticker, url,
        http_status: status, byte_len: body.length, sha256: await sha256(body),
        rows_parsed: 1, ok: 1, error: null, fetched_at_utc: ctx.nowUtc,
      });
      return true;
    }
    await logFetch(env, {
      source_id: MOPS_SOURCE_ID, month, ticker: company.ticker, url,
      http_status: status, byte_len: body.length, sha256: await sha256(body),
      rows_parsed: 0, ok: 1, error: outcome.status, fetched_at_utc: ctx.nowUtc,
    });
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const drift = err instanceof SchemaDriftError;
    ctx.findings.push({
      // Transport failure is a warn: the feed pass already succeeded for the
      // other names, and one unreachable per-company page is not a failed
      // refresh. Schema drift is an error - MOPS changed shape, and the Python
      // backfill parses the same page, so the whole backfill path is affected.
      severity: drift ? "error" : "warn",
      code: drift ? "SCHEMA_DRIFT" : "REPAIR_FAILED",
      month, ticker: company.ticker, sourceId: MOPS_SOURCE_ID,
      message: `${company.ticker} ${month}: MOPS repair failed - ${message}`,
    });
    await logFetch(env, {
      source_id: MOPS_SOURCE_ID, month, ticker: company.ticker, url,
      http_status: status, byte_len: body.length, sha256: body ? await sha256(body) : null,
      rows_parsed: 0, ok: 0, error: message, fetched_at_utc: ctx.nowUtc,
    });
    return false;
  }
}

// ---------------------------------------------------------- the checks --

/**
 * Two surfaces, one filing. Any difference in an integer LEVEL is an error.
 *
 * Percentages are deliberately not compared: the feeds carry ~15 significant
 * digits and the MOPS HTML truncates to 2dp, so a 0.01pp delta there is
 * arithmetic, not drift. Done in SQL because the comparison is a self-join over
 * rows already in D1 - pulling them into JS to compare would be slower and no
 * clearer.
 */
async function crossSourceCheck(env: Env, month: string): Promise<Finding[]> {
  const res = await env.DB.prepare(
    `SELECT a.ticker, a.source_id AS src_a, b.source_id AS src_b,
            a.revenue_month AS rev_a, b.revenue_month AS rev_b,
            a.revenue_yoy_month AS yoy_a, b.revenue_yoy_month AS yoy_b,
            a.cum_revenue AS cum_a, b.cum_revenue AS cum_b,
            a.cum_revenue_prior AS cump_a, b.cum_revenue_prior AS cump_b,
            a.company_name AS name_a, b.company_name AS name_b
       FROM raw_revenue a
       JOIN raw_revenue b
         ON a.ticker = b.ticker AND a.month = b.month AND a.source_id < b.source_id
      WHERE a.month = ?
        AND ( (a.revenue_month     IS NOT NULL AND b.revenue_month     IS NOT NULL AND a.revenue_month     <> b.revenue_month)
           OR (a.revenue_yoy_month IS NOT NULL AND b.revenue_yoy_month IS NOT NULL AND a.revenue_yoy_month <> b.revenue_yoy_month)
           OR (a.cum_revenue       IS NOT NULL AND b.cum_revenue       IS NOT NULL AND a.cum_revenue       <> b.cum_revenue)
           OR (a.cum_revenue_prior IS NOT NULL AND b.cum_revenue_prior IS NOT NULL AND a.cum_revenue_prior <> b.cum_revenue_prior)
           OR (a.company_name      IS NOT NULL AND b.company_name      IS NOT NULL AND a.company_name      <> b.company_name) )`,
  )
    .bind(month)
    .all<any>();

  const out: Finding[] = [];
  for (const r of res.results) {
    const levels: string[] = [];
    const cmp = (label: string, x: number | null, y: number | null) => {
      if (x !== null && y !== null && x !== y) {
        levels.push(`${label}: ${fmt(x)} vs ${fmt(y)}`);
      }
    };
    cmp("revenue_month", r.rev_a, r.rev_b);
    cmp("revenue_yoy_month", r.yoy_a, r.yoy_b);
    cmp("cum_revenue", r.cum_a, r.cum_b);
    cmp("cum_revenue_prior", r.cump_a, r.cump_b);

    if (levels.length) {
      out.push({
        severity: "error", code: "SOURCE_DISAGREEMENT", month, ticker: r.ticker,
        message:
          `${r.ticker} ${month}: ${r.src_a} vs ${r.src_b} - ${levels.join("; ")}. ` +
          `Same filing, two surfaces: one of the parsers is wrong.`,
      });
    }
    if (r.name_a && r.name_b && r.name_a !== r.name_b) {
      out.push({
        // Info: a rename must not break a ticker-keyed series, and the display
        // name comes from universe.yaml regardless.
        severity: "info", code: "NAME_CHANGED", month, ticker: r.ticker,
        message: `${r.ticker}: ${r.src_a} reports ${r.name_a}, ${r.src_b} reports ${r.name_b}`,
      });
    }
  }
  if (!res.results.length) {
    const overlap = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ticker FROM raw_revenue WHERE month = ?
          GROUP BY ticker HAVING COUNT(DISTINCT source_id) > 1)`,
    )
      .bind(month)
      .first<{ n: number }>();
    if (!overlap?.n) {
      // Silence must never be mistaken for agreement.
      out.push({
        severity: "info", code: "NO_OVERLAP", month,
        message:
          `${month}: no ticker has rows from two sources, so the cross-source ` +
          `check proved nothing this run`,
      });
    }
  }
  return out;
}

/**
 * Plausibility, on the authoritative rows only.
 *
 * January and February are EXCLUDED from the MoM outlier check. Lunar New Year
 * moves between them and legitimately swings monthly revenue by +/-40%; flagging
 * that every year would train the reader to ignore the report, which costs more
 * than the check gains.
 */
async function plausibilityCheck(env: Env, month: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const mm = month.slice(5);
  const lunarNewYear = mm === "01" || mm === "02";

  const res = await env.DB.prepare(
    `SELECT ticker, display_name, tier, revenue_month, mom_pct, yoy_pct,
            yoy_acceleration_ppt, source_id
       FROM analytics_base WHERE month = ? AND revenue_month IS NOT NULL`,
  )
    .bind(month)
    .all<any>();

  for (const r of res.results) {
    if (r.revenue_month <= 0) {
      out.push({
        severity: "warn", code: "NONPOSITIVE_REVENUE", month, ticker: r.ticker,
        message: `${r.ticker} ${r.display_name}: revenue_month = ${fmt(r.revenue_month)}`,
      });
    }
    if (r.yoy_pct !== null && Math.abs(r.yoy_pct) > 200) {
      out.push({
        // Warn, never error: +181.78% at 3661 in Jul 2026 is real, and is exactly
        // the signal the tracker exists to catch. It is flagged to be LOOKED AT.
        severity: "warn", code: "YOY_OUTLIER", month, ticker: r.ticker,
        message: `${r.ticker} ${r.display_name}: YoY ${r.yoy_pct}% - verify against the filing`,
      });
    }
    if (!lunarNewYear && r.mom_pct !== null && Math.abs(r.mom_pct) > 60) {
      out.push({
        severity: "warn", code: "MOM_OUTLIER", month, ticker: r.ticker,
        message: `${r.ticker} ${r.display_name}: MoM ${r.mom_pct}%`,
      });
    }
  }

  // Units. TSMC's monthly revenue in TWD thousands is 1e8..1e9; a 1000x change
  // anywhere upstream fails here first and with an unmistakable message.
  const tsmc = res.results.find((r: any) => r.ticker === "2330");
  if (tsmc && !(tsmc.revenue_month >= 1e8 && tsmc.revenue_month <= 1e9)) {
    out.push({
      severity: "error", code: "UNIT_SANITY", month, ticker: "2330",
      message:
        `2330 revenue_month = ${fmt(tsmc.revenue_month)} is outside 1e8..1e9 TWD ` +
        `thousands - the reporting unit may have changed`,
    });
  }

  out.push(...(await cumulativeConsistency(env, month)));
  return out;
}

/**
 * Month m's YTD minus month m-1's should equal month m's revenue.
 *
 * WHY THIS IS A THRESHOLD CHECK AND NOT AN EQUALITY CHECK
 *
 * Strict equality was the first implementation, and on the Feb-Jul 2026 window it
 * flagged 21 cells - every one of them noise. The pattern is unambiguous:
 *
 *   - 3661 Alchip and 6415 Silergy differ in EVERY month, 0.002%..1.16%, sign
 *     alternating. Both are -KY foreign issuers filing 合併營業收入淨額 with a USD
 *     functional currency, and the filing carries TWO 換算匯率 rows - one rate for
 *     the month, another for the cumulative period. So the TWD monthly figures
 *     cannot sum to the TWD cumulative figure by construction. A restatement does
 *     not recur monthly with alternating sign; FX translation does.
 *   - 2317, 1560, 8081 differ by exactly +/-1 thousand in scattered months:
 *     rounding at the reporting unit.
 *   - 2382 Quanta differed by 440 on NT$366bn in one month (0.0001%): a real but
 *     immaterial prior-period adjustment.
 *
 * What the check actually defends against is structural: 本年累計 and 去年累計
 * transposed by the positional parser, or a month written under the wrong key.
 * Both of those move the gap to the order of a whole month's revenue. So the
 * thresholds are set where that signal lives, and everything below is collapsed
 * into one info line - because 21 findings a month that are all accounting noise
 * is precisely how a quality report gets ignored.
 */
const CUM_ERROR_PCT = 20;
const CUM_WARN_PCT = 2;

async function cumulativeConsistency(env: Env, month: string): Promise<Finding[]> {
  const out: Finding[] = [];
  if (month.slice(5) === "01") return out; // January's YTD IS January; nothing to difference.

  const res = await env.DB.prepare(
    `WITH x AS (
       SELECT ticker, display_name, month, month_idx, cum_revenue, revenue_month,
              LAG(cum_revenue) OVER w AS prev_cum,
              LAG(month_idx)   OVER w AS prev_idx
         FROM analytics_base
        WINDOW w AS (PARTITION BY ticker ORDER BY month_idx)
     )
     SELECT ticker, display_name, cum_revenue, prev_cum, revenue_month,
            (cum_revenue - prev_cum) - revenue_month AS gap,
            ABS(100.0 * ((cum_revenue - prev_cum) - revenue_month) / revenue_month) AS gap_pct
       FROM x
      WHERE month = ? AND prev_idx = month_idx - 1
        AND cum_revenue IS NOT NULL AND prev_cum IS NOT NULL
        AND revenue_month > 0
        AND cum_revenue - prev_cum <> revenue_month
      ORDER BY gap_pct DESC`,
  )
    .bind(month)
    .all<any>();

  const noise: any[] = [];
  for (const r of res.results) {
    if (r.gap_pct < CUM_WARN_PCT) {
      noise.push(r);
      continue;
    }
    const structural = r.gap_pct >= CUM_ERROR_PCT;
    out.push({
      severity: structural ? "error" : "warn",
      code: "CUM_CONSISTENCY", month, ticker: r.ticker,
      message:
        `${r.ticker} ${r.display_name}: YTD ${fmt(r.cum_revenue)} - prior YTD ` +
        `${fmt(r.prev_cum)} = ${fmt(r.cum_revenue - r.prev_cum)}, but the month reports ` +
        `${fmt(r.revenue_month)} (gap ${fmt(r.gap)}, ${r.gap_pct.toFixed(2)}% of the month). ` +
        (structural
          ? "That is the magnitude of a transposed 本年累計/去年累計 pair or a month " +
            "written under the wrong key - check the parser before trusting this row."
          : "Large enough to be a prior-period restatement rather than FX translation."),
    });
  }

  if (noise.length) {
    const worst = noise[0];
    out.push({
      severity: "info", code: "CUM_ROUNDING", month,
      message:
        `${noise.length} cell(s) differ between YTD-differenced and reported monthly ` +
        `revenue by under ${CUM_WARN_PCT}% - consistent with FX translation on the ` +
        `consolidated -KY filers and rounding at the thousands unit. Largest: ` +
        `${worst.ticker} ${worst.display_name} ${fmt(worst.gap)} ` +
        `(${worst.gap_pct.toFixed(4)}%). Watch this count, not the individual cells.`,
    });
  }

  return out;
}

// ------------------------------------------------------------- plumbing --

async function upsert(env: Env, rows: RawRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = env.DB.prepare(UPSERT_SQL);
  // 40 statements per batch: comfortably inside D1's limits while keeping the
  // whole of a feed's 31 rows in a single round trip.
  for (let i = 0; i < rows.length; i += 40) {
    await env.DB.batch(
      rows.slice(i, i + 40).map((row) => stmt.bind(...RAW_COLUMNS.map((c) => row[c] ?? null))),
    );
  }
}

interface FetchLogEntry {
  source_id: string;
  month: string | null;
  ticker: string | null;
  url: string;
  http_status: number;
  byte_len: number;
  sha256: string | null;
  rows_parsed: number;
  ok: number;
  error: string | null;
  fetched_at_utc: string;
}

async function logFetch(env: Env, entry: FetchLogEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fetch_log (source_id, month, ticker, url, http_status, byte_len,
                            sha256, rows_parsed, ok, error, fetched_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.source_id, entry.month, entry.ticker, entry.url, entry.http_status,
      entry.byte_len, entry.sha256, entry.rows_parsed, entry.ok, entry.error,
      entry.fetched_at_utc,
    )
    .run();
}

/**
 * Findings for this month, replacing the previous cron's verdict on it.
 *
 * The scoped DELETE is what keeps three runs a month from tripling the findings
 * table - and more importantly, it means a problem FIXED by the 14th's run stops
 * being reported, rather than sitting in the Quality tab forever. Only cron-origin
 * rows are touched; the Python seed's findings are keyed by its own run_id.
 */
async function writeFindings(
  env: Env,
  runId: string,
  nowUtc: string,
  findings: Finding[],
  month?: string | null,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (month) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM quality_findings WHERE run_id LIKE 'cron-%' AND month = ?`,
      ).bind(month),
    );
  }
  const insert = env.DB.prepare(
    `INSERT INTO quality_findings
       (run_id, created_at_utc, severity, code, month, ticker, source_id, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of findings) {
    statements.push(
      insert.bind(
        runId, nowUtc, f.severity, f.code,
        f.month ?? month ?? null, f.ticker ?? null, f.sourceId ?? null, f.message,
      ),
    );
  }
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40));
  }
}

/**
 * The latest month whose filings should exist by `now`.
 *
 * Deliberately conservative on the 10th itself: filings are still arriving that
 * day, so claiming the month would report a false gap for every late filer.
 */
export function latestExpectedMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const back = now.getUTCDate() > 10 ? 1 : 2;
  const idx = y * 12 + (m - 1) - back;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

function safeJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
