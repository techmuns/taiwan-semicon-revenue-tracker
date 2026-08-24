/**
 * The dark theme is declared under two scopes that must agree:
 *
 *   @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) { … } }
 *   :root[data-theme="dark"] { … }
 *
 * CSS gives no way to write those declarations once - a media query cannot be
 * folded into a selector list - so they are duplicated, and duplication drifts.
 * A token added to one block and forgotten in the other produces the worst kind
 * of bug here: the dashboard looks right for whoever is testing it and wrong for
 * everyone whose theme arrived by the other route.
 *
 * This asserts the two blocks declare the SAME token set with the SAME values,
 * and that every token they mention actually exists in :root - so a dark
 * override can never invent a token nothing reads.
 *
 * Run: node scripts/check-theme-parity.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "tokens.css"), "utf-8");

/** Declarations of a block, given the index of its opening brace. */
function blockAt(source, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIdx + 1, i);
    }
  }
  throw new Error("unbalanced braces in tokens.css");
}

function tokensOf(body) {
  const out = new Map();
  // Strip comments so a commented-out token is not counted as declared.
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return out;
}

function findBlock(selectorRe, label) {
  const m = selectorRe.exec(css);
  if (!m) throw new Error(`could not find the ${label} block in tokens.css`);
  return tokensOf(blockAt(css, css.indexOf("{", m.index)));
}

const root = findBlock(/^:root\s*\{/m, ":root");
const media = findBlock(/:root:where\(:not\(\[data-theme="light"\]\)\)\s*\{/, "media-query dark");
const attr = findBlock(/^:root\[data-theme="dark"\]\s*\{/m, "[data-theme=dark]");

const problems = [];

const onlyMedia = [...media.keys()].filter((k) => !attr.has(k));
const onlyAttr = [...attr.keys()].filter((k) => !media.has(k));
for (const k of onlyMedia) problems.push(`${k}: in the media block but not in [data-theme="dark"]`);
for (const k of onlyAttr) problems.push(`${k}: in [data-theme="dark"] but not in the media block`);

for (const [k, v] of media) {
  const other = attr.get(k);
  if (other !== undefined && other !== v) {
    problems.push(`${k}: media says ${v}, [data-theme="dark"] says ${other}`);
  }
}

// color-scheme is a real property, not a custom property, so it is checked apart.
for (const [label, re] of [
  ["media", /:root:where\(:not\(\[data-theme="light"\]\)\)\s*\{[^}]*color-scheme:\s*dark/],
  ["attr", /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/],
]) {
  if (!re.test(css)) problems.push(`${label} dark block is missing \`color-scheme: dark\``);
}

const orphans = [...media.keys()].filter((k) => !root.has(k));
for (const k of orphans) {
  problems.push(`${k}: overridden in dark but never declared in :root - nothing reads it`);
}

const n = media.size;
if (problems.length) {
  console.error(`theme parity FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`theme parity OK - ${n} dark tokens, identical in both scopes, all present in :root`);
