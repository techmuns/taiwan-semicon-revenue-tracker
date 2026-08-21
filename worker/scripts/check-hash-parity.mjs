/**
 * Prove that the Worker's rowHash() reproduces the Python backfill's, byte for byte.
 *
 * This is the one invariant that cannot be checked by running either half alone.
 * Rows with source_id 'mops_company' are written by BOTH the Python backfill and
 * the Worker's per-ticker repair path; if the two hashed the same filing
 * differently, every alternating write would trip the restatement trigger and
 * fill raw_revenue_history with changes that never happened - a month later, far
 * from the cause.
 *
 * So: take rows Python already hashed and wrote to D1, recompute the hash with the
 * Worker's own code, and require every one to match.
 *
 *   npx wrangler d1 execute taiwan-semicon-revenue --local --json \
 *     --command "SELECT ticker, month, company_name, industry, report_date,
 *       revenue_month, revenue_prev_month, revenue_yoy_month, src_mom_pct,
 *       src_yoy_pct, cum_revenue, cum_revenue_prior, src_cum_yoy_pct, note,
 *       row_hash FROM raw_revenue WHERE source_id='mops_company'" > rows.json
 *   node --experimental-strip-types scripts/check-hash-parity.mjs rows.json
 *
 * Node's type stripping lets this import the Worker's TypeScript directly rather
 * than a transpiled copy - a copy is exactly the thing that would silently drift.
 */

import { readFileSync } from "node:fs";
import { rowHash, canonicalJson, VALUE_COLUMNS } from "../src/normalize.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node --experimental-strip-types check-hash-parity.mjs <d1-json>");
  process.exit(2);
}

const payload = JSON.parse(readFileSync(path, "utf8"));
const rows = Array.isArray(payload) ? payload.flatMap((r) => r.results ?? []) : payload.results;
if (!rows?.length) {
  console.error(`no rows in ${path}`);
  process.exit(2);
}

let mismatches = 0;
for (const row of rows) {
  const expected = row.row_hash;
  const actual = await rowHash(row);
  if (actual !== expected) {
    mismatches += 1;
    if (mismatches <= 5) {
      const payload = {};
      for (const col of VALUE_COLUMNS) payload[col] = row[col] ?? null;
      console.error(`MISMATCH ${row.ticker} ${row.month}`);
      console.error(`  python: ${expected}`);
      console.error(`  worker: ${actual}`);
      console.error(`  canonical json: ${canonicalJson(payload)}`);
    }
  }
}

const nulls = rows.filter((r) => r.note === null).length;
const notes = rows.length - nulls;
const floats = rows.filter((r) => Number.isInteger(r.src_yoy_pct) && r.src_yoy_pct !== null).length;

console.log(`rows checked      : ${rows.length}`);
console.log(`with a 備註 note   : ${notes}   (exercises non-ASCII string escaping)`);
console.log(`integral src pct   : ${floats}   (exercises the 2.0-vs-2 float divergence)`);
console.log(mismatches ? `MISMATCHES        : ${mismatches}` : "hash parity        : all match");
process.exit(mismatches ? 1 : 0);
