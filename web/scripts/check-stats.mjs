/**
 * Executable assertions over src/stats.ts - the client-side arithmetic.
 *
 * Every aggregate a reader sees on the Overview and Insights tabs passes through
 * this module, and it is the one layer with no test coverage at all: the Python
 * suite cannot reach it, and `tsc` only proves the types line up, not that a
 * zero MAD yields null instead of Infinity or that an empty sum stays null
 * instead of becoming 0. Three of the defects found in the last audit pass were
 * in exactly this kind of code.
 *
 * NO NEW DEPENDENCY. esbuild is already present (vite's own), so the module is
 * bundled to a temp file and imported. That keeps this repo's one deliberate
 * property - a front end with no test framework - while still testing the maths.
 *
 * The rules being defended, all of them stated in stats.ts' own docstring:
 *   - NULL is never coalesced to 0; an empty basis yields null, not zero
 *   - medians, not means, for growth rates
 *   - aggregate growth is revenue-weighted FROM LEVELS, never an average of rates
 *   - every aggregate reports the n it was computed over
 *   - no division can produce Infinity or NaN
 *
 * Run: node scripts/check-stats.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const out = mkdtempSync(join(tmpdir(), "twrev-stats-"));

let stats;
try {
  const bundle = join(out, "stats.mjs");
  execFileSync(
    join(web, "node_modules", ".bin", "esbuild"),
    [join(web, "src", "stats.ts"), "--bundle", "--format=esm", "--platform=node",
     `--outfile=${bundle}`, "--log-level=error"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  stats = await import(pathToFileURL(bundle).href);
} catch (err) {
  console.error("could not bundle src/stats.ts:", err.message);
  process.exit(1);
}

const { median, medianOf, sumRevenue, weightedYoY, meanOf, mad, standouts,
        forAggregate, movers, rebase, forMonth, groupBy, sortedMonths } = stats;

let failures = 0;
const ok = (name, cond, note = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${note ? "   " + note : ""}`);
};
const group = (name) => console.log(`\n${name}`);

/** A full AnalyticsRow with every metric absent, so each case sets only what it means. */
const row = (o) => ({
  ticker: "0000", company_name: "X", bucket: "B", tier: 1, month: "2026-07",
  revenue_twd_thousands: null, mom_pct: null, yoy_pct: null, prior_month_yoy_pct: null,
  yoy_acceleration_ppt: null, cumulative_ytd_revenue_twd_thousands: null,
  cumulative_yoy_pct: null, ...o,
});

group("median / medianOf");
ok("empty -> null", median([]) === null);
ok("even count averages the middle two", median([1, 2, 3, 4]) === 2.5);
ok("does not assume sorted input", median([5, 1, 3]) === 3);
ok("does not mutate its argument", (() => {
  const a = [3, 1, 2]; median(a); return a[0] === 3;
})());
ok("NaN leaves the basis", medianOf([row({ yoy_pct: NaN }), row({ yoy_pct: 4 })], (r) => r.yoy_pct).n === 1);
ok("all-null -> null value, n 0, missing counted", (() => {
  const a = medianOf([row({}), row({})], (r) => r.yoy_pct);
  return a.value === null && a.n === 0 && a.missing === 2;
})());

group("sumRevenue - an empty sum is not zero");
ok("empty -> null", sumRevenue([]).value === null);
ok("all-null -> null", sumRevenue([row({}), row({})]).value === null);
ok("a genuine zero stays 0", sumRevenue([row({ revenue_twd_thousands: 0 })]).value === 0);
ok("missing is counted separately", (() => {
  const a = sumRevenue([row({ revenue_twd_thousands: 5 }), row({})]);
  return a.value === 5 && a.n === 1 && a.missing === 1;
})());

group("weightedYoY - from levels, never an average of rates");
const wy = (rows) => weightedYoY(rows);
ok("yoy = -100 skipped: the prior would be infinite", wy([row({ revenue_twd_thousands: 100, yoy_pct: -100 })]).n === 0);
ok("yoy < -100 skipped", wy([row({ revenue_twd_thousands: 100, yoy_pct: -150 })]).n === 0);
ok("empty -> null", wy([]).value === null);
ok("a row missing either operand is skipped, so numerator and denominator match", (() => {
  const a = wy([row({ revenue_twd_thousands: 110, yoy_pct: 10 }), row({ revenue_twd_thousands: 200 })]);
  return a.n === 1 && Math.abs(a.value - 10) < 1e-9;
})());
ok("weights by level: 110@+10% and 200@+100% -> 55%, not the 55% mean by luck", (() => {
  // Both priors reconstruct to 100, so this is 310/200 - 1. Deliberately a case
  // where the level-weighted and rate-averaged answers differ:
  const level = wy([row({ revenue_twd_thousands: 110, yoy_pct: 10 }), row({ revenue_twd_thousands: 200, yoy_pct: 100 })]);
  const rateMean = (10 + 100) / 2;
  return Math.abs(level.value - 55) < 1e-9 && Math.abs(rateMean - 55) < 1e-9;
})(), "(both are 55 here; the next case separates them)");
ok("level-weighting differs from rate-averaging when sizes differ", (() => {
  // 1000 growing 1% and 10 growing 100%: rate mean 50.5%, level-weighted ~1.98%.
  const level = wy([row({ revenue_twd_thousands: 1010, yoy_pct: 1 }), row({ revenue_twd_thousands: 20, yoy_pct: 100 })]);
  return level.value > 1.5 && level.value < 2.5;
})());

group("mad / standouts - no division by a zero spread");
ok("mad of empty -> null", mad([]) === null);
ok("mad of identical values -> 0", mad([5, 5, 5]) === 0);
ok("zero MAD -> every score null, never Infinity", standouts([{ v: 5 }, { v: 5 }, { v: 5 }], (x) => x.v).ranked.every((r) => r.score === null));
ok("n = 1 -> score null", (() => {
  const a = standouts([{ v: 5 }], (x) => x.v);
  return a.n === 1 && a.ranked[0].score === null;
})());
ok("n = 0 -> median and mad null, no ranked rows", (() => {
  const a = standouts([], (x) => x.v);
  return a.n === 0 && a.median === null && a.mad === null && a.ranked.length === 0;
})());
ok("ranks by |score|, so a large negative outranks a small positive", (() => {
  const a = standouts([{ v: 1 }, { v: 2 }, { v: 3 }, { v: -40 }], (x) => x.v);
  return a.ranked[0].item.v === -40;
})());
ok("nulls and NaN leave n", standouts([{ v: 1 }, { v: null }, { v: NaN }], (x) => x.v).n === 1);
ok("every score is finite when it is not null", standouts([{ v: 1 }, { v: 2 }, { v: 90 }], (x) => x.v)
  .ranked.every((r) => r.score === null || Number.isFinite(r.score)));

group("forAggregate - the de-duplication");
ok("drops the consolidated child", forAggregate([row({ ticker: "6669" }), row({ ticker: "3231" })]).length === 1);
ok("keeps the parent", forAggregate([row({ ticker: "6669" }), row({ ticker: "3231" })])[0].ticker === "3231");
ok("returns a copy, never mutating the caller's array", (() => {
  const src = [row({ ticker: "3231" })];
  return forAggregate(src) !== src;
})());

group("rebase - never divides by zero or by a null");
ok("no positive value -> all null, baseIdx null", (() => {
  const r = rebase([null, null]);
  return r.baseIdx === null && r.indexed.every((v) => v === null);
})());
ok("skips a leading zero rather than dividing by it", (() => {
  const r = rebase([0, 5, 10]);
  return r.baseIdx === 1 && r.indexed[0] === 0 && r.indexed[2] === 200;
})());
ok("preserves nulls as nulls", rebase([5, null, 10]).indexed[1] === null);
ok("every output is finite or null", rebase([0, 0, 4]).indexed.every((v) => v === null || Number.isFinite(v)));

group("movers / forMonth / groupBy / sortedMonths");
ok("movers excludes nulls", movers([row({ yoy_acceleration_ppt: null }), row({ yoy_acceleration_ppt: 5 })], (r) => r.yoy_acceleration_ppt, 8, "top").length === 1);
ok("movers top is descending", (() => {
  const m = movers([row({ yoy_acceleration_ppt: 1 }), row({ yoy_acceleration_ppt: 9 })], (r) => r.yoy_acceleration_ppt, 8, "top");
  return m[0].value === 9;
})());
ok("movers bottom is ascending", (() => {
  const m = movers([row({ yoy_acceleration_ppt: 1 }), row({ yoy_acceleration_ppt: 9 })], (r) => r.yoy_acceleration_ppt, 8, "bottom");
  return m[0].value === 1;
})());
ok("forMonth with a null month yields nothing", forMonth([row({ month: "2026-07" })], null).length === 0);
ok("groupBy preserves first-appearance order", [...groupBy([row({ bucket: "Z" }), row({ bucket: "A" })], (r) => r.bucket).keys()].join() === "Z,A");
ok("sortedMonths dedupes and sorts", sortedMonths([row({ month: "2026-02" }), row({ month: "2026-01" }), row({ month: "2026-02" })]).join() === "2026-01,2026-02");

group("meanOf - nulls leave the divisor");
ok("empty -> null", meanOf([]).value === null);
ok("nulls do not become zeros", (() => {
  const a = meanOf([2, null, 4]);
  return a.value === 3 && a.n === 2 && a.missing === 1;
})());
ok("undefined is treated as absent", meanOf([2, undefined, 4]).n === 2);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nstats.ts OK - all assertions passed");
process.exit(failures ? 1 : 0);
