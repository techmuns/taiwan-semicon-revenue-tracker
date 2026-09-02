/**
 * Executable assertions over src/dataset.ts - the layer that replaced D1.
 *
 * Everything the Worker used to do in SQL now happens either at publish time
 * (the aggregation, by the same statement that ran on D1) or here (the
 * filtering). This file covers the second half, and one property of the first:
 * that the published heatmap is SLICED and never recomputed.
 *
 * The filter rules mirror worker/src/api.ts:whereFor. If they drift, the page
 * shows a different set of rows than the CSV download does, silently.
 *
 * Run: node scripts/check-dataset.mjs
 */

import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const out = mkdtempSync(join(tmpdir(), "twrev-dataset-"));

let ds;
try {
  const bundle = join(out, "dataset.mjs");
  await build({
    entryPoints: [join(web, "src", "dataset.ts")],
    bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error",
  });
  ds = await import(pathToFileURL(bundle).href);
} catch (err) {
  console.error("could not bundle src/dataset.ts:", err.message);
  process.exit(1);
}

const { matchesFilters, filterRows, tierKey, bucketHeatmap, tickerHeatmap, resetCache,
        UnsupportedFilterError } = ds;

let failures = 0;
const ok = (name, cond, note = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${note ? "   " + note : ""}`);
};
const group = (name) => console.log(`\n${name}`);

const F = (o = {}) => ({ from: "", to: null, tickers: [], buckets: [], tiers: [],
                         onlyWithData: false, ...o });
const row = (o = {}) => ({ ticker: "2330", company_name: "TSMC", bucket: "AI Silicon",
                           tier: 1, month: "2026-03", revenue_twd_thousands: 100,
                           mom_pct: null, yoy_pct: null, prior_month_yoy_pct: null,
                           yoy_acceleration_ppt: null,
                           cumulative_ytd_revenue_twd_thousands: null,
                           cumulative_yoy_pct: null, ...o });

group("matchesFilters - mirrors whereFor clause for clause");
ok("empty filters match everything", matchesFilters(row(), F()));
ok("from is inclusive", matchesFilters(row({ month: "2026-03" }), F({ from: "2026-03" })));
ok("before from is excluded", !matchesFilters(row({ month: "2026-02" }), F({ from: "2026-03" })));
ok("to is inclusive", matchesFilters(row({ month: "2026-03" }), F({ to: "2026-03" })));
ok("after to is excluded", !matchesFilters(row({ month: "2026-04" }), F({ to: "2026-03" })));
ok("an empty ticker list is NOT a filter", matchesFilters(row(), F({ tickers: [] })));
ok("a non-empty ticker list narrows", !matchesFilters(row(), F({ tickers: ["3324"] })));
ok("bucket filter narrows", !matchesFilters(row(), F({ buckets: ["Thermal"] })));
ok("tier filter narrows", !matchesFilters(row({ tier: 2 }), F({ tiers: [1] })));

group("onlyWithData - a filed ZERO is a filing");
ok("null revenue is excluded", !matchesFilters(row({ revenue_twd_thousands: null }),
                                               F({ onlyWithData: true })));
ok("a filed 0 SURVIVES (falsiness would have dropped a real row)",
   matchesFilters(row({ revenue_twd_thousands: 0 }), F({ onlyWithData: true })));
ok("0 is kept when the filter is off",
   matchesFilters(row({ revenue_twd_thousands: 0 }), F()));

group("filterRows");
ok("returns a new array, never mutating the caller's", (() => {
  const src = [row()];
  return filterRows(src, F()) !== src;
})());
ok("combines clauses with AND", (() => {
  const rows = [row({ ticker: "2330", tier: 1 }), row({ ticker: "3324", tier: 1, bucket: "Thermal" })];
  return filterRows(rows, F({ tiers: [1], buckets: ["Thermal"] })).length === 1;
})());

group("tierKey - {2,1} and {1,2} are the same subset");
ok("sorted", tierKey([2, 1]) === "1,2");
ok("empty means all tiers", tierKey([]) === "");
ok("single", tierKey([2]) === "2");

// ---- published heatmap: SLICED, never recomputed -------------------------
const CELLS = [
  { bucket: "AI Silicon", month: "2026-01", value: 1.5, members: 3, members_with_revenue: 3, composition_changed: false, revenue: 10 },
  { bucket: "AI Silicon", month: "2026-02", value: 2.5, members: 3, members_with_revenue: 3, composition_changed: false, revenue: 20 },
  { bucket: "Thermal",    month: "2026-01", value: 9.5, members: 4, members_with_revenue: 4, composition_changed: false, revenue: 30 },
];
const FILE = {
  generated_from: "ingest/src/twrev/sql/heatmap_bucket.sql",
  from: "2026-01",
  tier_subsets: {
    "": { "yoy_pct|weighted": { metric: "yoy_pct", agg: "weighted", agg_requested: "weighted", cells: CELLS },
          "cumulative_yoy_pct|equal": { metric: "cumulative_yoy_pct", agg: "weighted", agg_requested: "equal", cells: CELLS } },
    "1": { "yoy_pct|weighted": { metric: "yoy_pct", agg: "weighted", agg_requested: "weighted", cells: [CELLS[0]] } },
  },
  ticker_filter_unsupported: "stated",
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => FILE });

group("bucketHeatmap - values are looked up, never recalculated");
resetCache();
const hm = await bucketHeatmap(F({ from: "2026-01" }), "yoy_pct", "weighted");
ok("returns the published cells untouched",
   hm.cells.length === 3 && hm.cells[0].value === 1.5 && hm.cells[2].value === 9.5);
ok("a window slices without changing a value", (() => {
  return hm.cells.every((c) => CELLS.find((o) => o.bucket === c.bucket && o.month === c.month).value === c.value);
})());

resetCache();
const sliced = await bucketHeatmap(F({ from: "2026-02" }), "yoy_pct", "weighted");
ok("`from` drops earlier months only", sliced.cells.length === 1 && sliced.cells[0].month === "2026-02");
ok("and the surviving value is IDENTICAL", sliced.cells[0].value === 2.5,
   "(a recomputed aggregate would drift here)");

resetCache();
const bucketed = await bucketHeatmap(F({ from: "2026-01", buckets: ["Thermal"] }), "yoy_pct", "weighted");
ok("`buckets` selects rows without changing them",
   bucketed.cells.length === 1 && bucketed.cells[0].value === 9.5);

resetCache();
const t1 = await bucketHeatmap(F({ from: "2026-01", tiers: [1] }), "yoy_pct", "weighted");
ok("a tier subset reads its OWN published answers", t1.cells.length === 1);

group("bucketHeatmap - reports what it computed, not what was asked");
resetCache();
const cum = await bucketHeatmap(F({ from: "2026-01" }), "cumulative_yoy_pct", "equal");
ok("agg is the applied one", cum.agg === "weighted");
ok("agg_requested still carries the request", cum.agg_requested === "equal",
   "(labelling this 'equal' is the 70-of-70-cells defect)");

group("bucketHeatmap - refuses rather than answering wrongly");
resetCache();
ok("a ticker filter throws instead of returning the unfiltered value", await (async () => {
  try {
    await bucketHeatmap(F({ from: "2026-01", tickers: ["2330"] }), "yoy_pct", "weighted");
    return false;
  } catch (e) { return e instanceof UnsupportedFilterError; }
})());
resetCache();
ok("an unpublished tier subset throws", await (async () => {
  try {
    await bucketHeatmap(F({ from: "2026-01", tiers: [2] }), "yoy_pct", "weighted");
    return false;
  } catch (e) { return e instanceof UnsupportedFilterError; }
})());

group("tickerHeatmap - a projection, not an aggregate");
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ filters: {}, count: 2, rows: [
    row({ ticker: "2330", month: "2026-01", yoy_pct: 44.7 }),
    row({ ticker: "3324", bucket: "Thermal", month: "2026-01", yoy_pct: 12.3 }),
  ] }),
});
resetCache();
const th = await tickerHeatmap(F({ from: "2026-01" }), "yoy_pct");
ok("one cell per row, metric passed through", th.cells.length === 2 && th.cells[0].value === 44.7);
ok("agg is 'none' - there is nothing to aggregate", th.agg === "none");
resetCache();
const thF = await tickerHeatmap(F({ from: "2026-01", buckets: ["Thermal"] }), "yoy_pct");
ok("filters apply to the projection", thF.cells.length === 1 && thF.cells[0].value === 12.3);

// ---- the CSV byte contract, across two languages -------------------------
let csvmod;
{
  const bundle = join(out, "csv.mjs");
  await build({ entryPoints: [join(web, "src", "csv.ts")], bundle: true, format: "esm",
                platform: "node", outfile: bundle, logLevel: "error" });
  csvmod = await import(pathToFileURL(bundle).href);
}
const { toCsv, csvCell } = csvmod;

group("csv.ts - quoting");
ok("plain values are unquoted", csvCell("TSMC") === "TSMC");
ok("null is empty, not the string 'null'", csvCell(null) === "");
ok("undefined is empty", csvCell(undefined) === "");
ok("a comma forces quotes", csvCell("Alchip, Inc.") === '"Alchip, Inc."');
ok("an inner quote is doubled", csvCell('Auras "Tech"') === '"Auras ""Tech"""');
ok("a newline forces quotes", csvCell("a\nb") === '"a\nb"');
ok("a filed 0 is written as 0, not blank", csvCell(0) === "0");

group("csv.ts - byte-identical to the Python exporter");
// The fixture is produced by ingest/src/twrev/export.py:rows_to_csv. Two
// implementations of one documented deliverable is exactly where a silent
// divergence lives - the Python side already needed _js_number because it
// wrote an integral float as "17.0" where JavaScript writes "17".
const fixtureRows = JSON.parse(readFileSync(join(web, "fixtures", "export-parity.json"), "utf8"));
const expected = readFileSync(join(web, "fixtures", "export-parity.csv"), "utf8");
const actual = toCsv(fixtureRows);
ok("toCsv matches export.py byte for byte", actual === expected,
   actual === expected ? `(${Buffer.byteLength(actual)} bytes)` : "");
if (actual !== expected) {
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    if (actual[i] !== expected[i]) {
      console.log(`     first difference at ${i}: js=${JSON.stringify(actual.slice(i, i + 40))}`);
      console.log(`                             py=${JSON.stringify(expected.slice(i, i + 40))}`);
      break;
    }
  }
}
ok("starts with a UTF-8 BOM (or Excel mangles the Chinese names)", actual.charCodeAt(0) === 0xfeff);
ok("CRLF line endings", actual.includes("\r\n") && !/[^\r]\n/.test(actual));
ok("an integral float is '17', never '17.0'", actual.includes(",17,"));

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\ndataset.ts OK - all assertions passed");
process.exit(failures ? 1 : 0);
