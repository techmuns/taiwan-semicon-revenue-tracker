/**
 * The per-company MOPS endpoint, in the Worker - the cron's repair path.
 *
 * This is the brief's backfill endpoint. The bulk of the backfill runs in Python
 * because 296 throttled requests do not fit a Worker, but the cron needs the same
 * endpoint for a narrow job: when a tier-1 name is still missing after every feed
 * has been walked, fetch that one ticker-month directly. A handful of requests.
 *
 * HOW THE TABLE IS LOCATED, AND WHY NOT BY POSITION
 *
 * The Python parser walks `find_all("table")` and picks the one containing
 * 營業收入淨額. HTMLRewriter is a streaming parser with no tree, so table
 * identity would have to come from nesting depth - and MOPS nests tables several
 * deep, which makes depth counting the fragile part.
 *
 * Instead this collects every table row as a list of cell strings, then finds the
 * eight expected LABELS appearing as consecutive rows:
 *
 *     本月 / 去年同期 / 增減金額 / 增減百分比 / 本年累計 / 去年累計 / 增減金額 / 增減百分比
 *
 * That is the same invariant the Python parser asserts after filtering, so both
 * halves are pinned to the same property rather than to two different heuristics.
 * It is also immune to nesting, to the malformed 備註 row that three HTML parsers
 * disagree about, and to the -KY consolidated form's extra currency and 換算匯率
 * rows - none of those can appear inside the eight-row window.
 *
 * Column 1 is the figure. On the -KY form the row is [label, TWD, functional
 * currency], so taking column 1 is load-bearing: reading column 2 would ingest
 * USD as TWD thousands and make the levels ~30x too small with no other symptom.
 * The currency sub-header is therefore asserted, exactly as in Python.
 */

import {
  SchemaDriftError,
  RAW_COLUMNS,
  cleanInt,
  cleanPct,
  cleanText,
  monthIdx,
  monthToRoc,
  rowHash,
  type RawRow,
} from "./normalize";

export const SOURCE_ID = "mops_company";

export const UNIT_ANCHOR = "單位：新台幣仟元";
export const TABLE_ANCHOR = "營業收入淨額";
const CONSOLIDATED_ANCHOR = "合併營業收入淨額";
const NTD_COLUMN_LABEL = "新台幣";
const FUNCTIONAL_CURRENCY_LABEL = "功能性貨幣";

const RE_NOT_AN_ISSUER = /公開發行公司不繼續公開發行/;
const RE_NO_DATA = /查無需求資料|查無資料|查無此公司/;
const RE_NOTE = /營收變化原因說明\s*<\/TH>\s*<TD[^>]*>([\s\S]*?)<\/TD>/i;
const RE_TAG = /<[^>]+>/g;

/** In order. The two 增減金額 and two 增減百分比 labels REPEAT - hence positional. */
const ROW_LABELS = [
  "本月", "去年同期", "增減金額", "增減百分比",
  "本年累計", "去年累計", "增減金額", "增減百分比",
] as const;

/** Position -> column. The 增減金額 rows are derived, so they self-check instead. */
const ROW_TARGETS: (string | null)[] = [
  "revenue_month", "revenue_yoy_month", null, "src_yoy_pct",
  "cum_revenue", "cum_revenue_prior", null, "src_cum_yoy_pct",
];

export type MopsStatus = "data" | "not_an_issuer" | "no_data";

export interface MopsOutcome {
  status: MopsStatus;
  ticker: string;
  month: string;
  row: RawRow | null;
  findings: Finding[];
}

export type Finding = { severity: "info" | "warn" | "error"; code: string; message: string };

export function urlFor(ticker: string, month: string, template: string): string {
  const [year, mm] = month.split("-");
  const rocYear = String(Number(year) - 1911);
  return template
    .replace("{code}", ticker)
    .replace(/\{roc_year\}/g, rocYear)
    .replace(/\{mm\}/g, mm);
}

/**
 * Split the document into rows of cell text.
 *
 * Text arrives in chunks, so every handler appends rather than assigns - a cell
 * containing an entity or a nested tag would otherwise keep only its last chunk,
 * which for a number like 415,191,699 would silently truncate it.
 */
async function tableRows(body: string): Promise<string[][]> {
  const rows: string[][] = [];
  let cells: string[] = [];
  let buf = "";
  let inCell = false;

  const flushCell = () => {
    if (inCell) {
      cells.push(buf.replace(/　/g, " ").replace(/\s+/g, " ").trim());
      buf = "";
      inCell = false;
    }
  };
  const flushRow = () => {
    flushCell();
    if (cells.some((c) => c)) rows.push(cells);
    cells = [];
  };

  const rewriter = new HTMLRewriter()
    .on("tr", { element: (el) => { flushRow(); el.onEndTag(() => flushRow()); } })
    .on("td, th", {
      element: (el) => { flushCell(); inCell = true; el.onEndTag(() => flushCell()); },
      text: (t) => { if (inCell) buf += t.text; },
    });

  await rewriter.transform(new Response(body)).arrayBuffer();
  flushRow();
  return rows;
}

/** Find the eight expected labels as consecutive rows. Returns the window. */
function findValueRows(rows: string[][]): string[][] {
  for (let i = 0; i + ROW_LABELS.length <= rows.length; i++) {
    let matched = true;
    for (let j = 0; j < ROW_LABELS.length; j++) {
      const row = rows[i + j];
      if (row.length < 2 || row[0] !== ROW_LABELS[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return rows.slice(i, i + ROW_LABELS.length);
  }
  throw new SchemaDriftError(
    `revenue table labels not found as a consecutive run of ${ROW_LABELS.length} rows: ` +
      `expected ${ROW_LABELS.join("/")}`,
  );
}

/**
 * The hidden form echoes back the ticker and month the server actually answered
 * for. Asserting against it turns "did my URL do what I intended?" from an
 * assumption into a check - and a ticker mismatch is the most dangerous possible
 * error here, since it would file one company's revenue under another's code.
 */
function echoedFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\b[^>]*>/gi;
  for (const tag of body.match(re) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name && value !== undefined) out[name] = value.trim();
  }
  return out;
}

export async function parseMops(
  body: string,
  opts: { ticker: string; month: string; nowUtc: string },
): Promise<MopsOutcome> {
  const { ticker, month, nowUtc } = opts;
  const base = { ticker, month, row: null };

  // Both of these arrive as HTTP 200 with a short body. They are legitimate
  // "nothing to report" answers, not failures, and must not be retried.
  if (RE_NOT_AN_ISSUER.test(body)) {
    return {
      ...base, status: "not_an_issuer",
      findings: [{
        severity: "info", code: "NOT_AN_ISSUER",
        message: `${ticker} ${month}: MOPS reports 不繼續公開發行 - no filing obligation`,
      }],
    };
  }
  if (RE_NO_DATA.test(body)) {
    return {
      ...base, status: "no_data",
      findings: [{
        severity: "info", code: "NO_DATA",
        message: `${ticker} ${month}: MOPS reports 查無需求資料 - not published for this month`,
      }],
    };
  }

  const findings: Finding[] = [];
  const wantRoc = monthToRoc(month);

  const echo = echoedFields(body);
  const echoedTicker = echo.Q1V || echo.compID;
  if (echoedTicker && echoedTicker !== ticker) {
    throw new SchemaDriftError(
      `requested ${ticker} but response echoes ${echoedTicker} - check urlFor()`,
    );
  }
  if (echo.Q2V && echo.Q2V !== wantRoc) {
    throw new SchemaDriftError(
      `${ticker}: requested ${month} (${wantRoc}) but response echoes ${echo.Q2V}`,
    );
  }
  // If MOPS ever reported in 元 rather than 仟元 the figures would be 1000x off
  // with no other visible symptom, so an absent declaration is fatal.
  if (!body.includes(UNIT_ANCHOR)) {
    throw new SchemaDriftError(
      `${ticker} ${month}: ${UNIT_ANCHOR} not found - refusing to write figures ` +
        `whose scale is unconfirmed`,
    );
  }

  const rows = await tableRows(body);
  const valueRows = findValueRows(rows);

  const consolidated = body.includes(CONSOLIDATED_ANCHOR);
  if (consolidated) {
    const sub = rows.find((r) => r[0] === NTD_COLUMN_LABEL);
    if (!sub) {
      throw new SchemaDriftError(
        `${ticker} ${month}: consolidated form without the ${NTD_COLUMN_LABEL} ` +
          `sub-header - cannot prove which column is TWD`,
      );
    }
    if (!sub.slice(1).some((c) => c.includes(FUNCTIONAL_CURRENCY_LABEL))) {
      throw new SchemaDriftError(
        `${ticker} ${month}: currency sub-header is [${sub.join(" | ")}]; expected ` +
          `${NTD_COLUMN_LABEL} first, functional currency second`,
      );
    }
    findings.push({
      severity: "info", code: "CONSOLIDATED_BASIS",
      message:
        `${ticker} ${month}: reports 合併營業收入淨額 (consolidated); TWD column ` +
        `taken. Levels are not directly comparable with the standalone filers.`,
    });
  }

  const row: RawRow = {};
  for (const col of RAW_COLUMNS) row[col] = null;
  row.source_id = SOURCE_ID;
  row.market = (echo.Market || "").trim().toLowerCase() || null;
  if (row.market !== null && !["sii", "otc"].includes(String(row.market))) {
    // raw_revenue models only the two listed boards; 興櫃 would be a real change.
    findings.push({
      severity: "warn", code: "UNKNOWN_MARKET",
      message: `${ticker} ${month}: market=${row.market}`,
    });
    row.market = null;
  }
  row.month = month;
  row.month_idx = monthIdx(month);
  row.ticker = ticker;
  row.roc_yyyymm = wantRoc;
  // This endpoint carries neither 產業別 nor 出表日期, and has no 上月營收 field
  // at all - which is why mom_pct comes from the neighbouring month instead.

  const deltas: (number | null)[] = [];
  valueRows.forEach((cells, i) => {
    const target = ROW_TARGETS[i];
    const raw = cells[1];
    if (target === null) deltas.push(cleanInt(raw));
    else if (target.startsWith("src_")) row[target] = cleanPct(raw);
    else row[target] = cleanInt(raw);
  });

  const note = extractNote(body);
  if (note) row.note = note;

  findings.push(...selfCheck(row, deltas, ticker, month));

  row.first_seen_utc = nowUtc;
  row.last_seen_utc = nowUtc;
  row.row_hash = await rowHash(row);
  return { status: "data", ticker, month, row, findings };
}

/** The 備註 cell, from raw markup - its row's markup is malformed. */
function extractNote(body: string): string | null {
  const m = RE_NOTE.exec(body);
  if (!m) return null;
  return cleanText(m[1].replace(RE_TAG, " ").replace(/&nbsp;/g, " "));
}

/**
 * Verify the positional mapping against the source's own derived figures.
 *
 * The response hands us 增減金額 and 增減百分比, both functions of the levels.
 * Recomputing them is a free per-row proof that the mapping is right: if 本年累計
 * and 去年累計 were transposed, this disagrees immediately rather than months on.
 */
function selfCheck(
  row: RawRow,
  deltas: (number | null)[],
  ticker: string,
  month: string,
): Finding[] {
  const out: Finding[] = [];
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const checkDelta = (kind: string, cur: number | null, prior: number | null, reported: number | null) => {
    if (cur === null || prior === null || reported === null) return;
    if (cur - prior !== reported) {
      out.push({
        severity: "error", code: "DELTA_MISMATCH",
        message:
          `${ticker} ${month}: ${kind} ${cur} - ${prior} = ${cur - prior} but MOPS ` +
          `reports 增減金額 ${reported} - positional mapping suspect`,
      });
    }
  };
  const checkPct = (kind: string, cur: number | null, prior: number | null, reported: number | null) => {
    if (cur === null || prior === null || reported === null || prior <= 0) return;
    const recomputed = 100 * (cur / prior - 1);
    const drift = Math.abs(recomputed - reported);
    if (drift > 0.5) {
      out.push({
        severity: "error", code: "PCT_MISMATCH",
        message: `${ticker} ${month}: ${kind} recomputed ${recomputed.toFixed(2)}% vs reported ${reported.toFixed(2)}% (drift ${drift.toFixed(2)}pp)`,
      });
    } else if (drift > 0.05) {
      out.push({
        severity: "warn", code: "PCT_MISMATCH",
        message: `${ticker} ${month}: ${kind} recomputed ${recomputed.toFixed(2)}% vs reported ${reported.toFixed(2)}% (drift ${drift.toFixed(2)}pp)`,
      });
    }
  };

  checkDelta("monthly", num(row.revenue_month), num(row.revenue_yoy_month), deltas[0] ?? null);
  checkDelta("cumulative", num(row.cum_revenue), num(row.cum_revenue_prior), deltas[1] ?? null);
  checkPct("YoY", num(row.revenue_month), num(row.revenue_yoy_month), num(row.src_yoy_pct));
  checkPct("cumulative YoY", num(row.cum_revenue), num(row.cum_revenue_prior), num(row.src_cum_yoy_pct));

  const rev = num(row.revenue_month);
  if (rev !== null && rev <= 0) {
    out.push({
      severity: "warn", code: "NONPOSITIVE_REVENUE",
      message: `${ticker} ${month}: revenue_month = ${rev}`,
    });
  }
  return out;
}
