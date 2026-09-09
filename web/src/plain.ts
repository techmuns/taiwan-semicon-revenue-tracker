/**
 * The page's plain-English layer.
 *
 * Every number on the Insights tab was already correct; what the tab did not do
 * was SAY anything. It printed "Most unlike the others / +5.1 MAD / somewhat
 * apart" above a table sorted on a column that was not on screen, and hung a
 * paragraph of methodology under each card in 10px gray. A reader who does not
 * already know what a median absolute deviation is - which is most readers of a
 * revenue tracker - could not tell from that screen whether anything had
 * happened at all.
 *
 * So the arithmetic stays exactly where it was, in `stats.ts`, and this module
 * turns its output into sentences. Two rules hold here:
 *
 *  - **It states what the numbers show and nothing else.** Every sentence below
 *    is assembled from values already on screen. Nothing is inferred about
 *    causes, nothing is forecast, and a claim the data cannot support ("this is
 *    significant") is not available to be built.
 *  - **The wording is metric-aware.** "Slowed" is the right word for a change in
 *    a growth RATE and the wrong word for the rate itself, and the tab's toggle
 *    switches between exactly those two kinds of number. One vocabulary table,
 *    keyed by metric, is what keeps a caption from describing the wrong thing
 *    after a toggle.
 */

import { pct, ppt } from "./format";
import { metricSpec } from "./scale";
import { scoreLabel } from "./stats";
import type { Standout } from "./stats";
import type { HeatmapMetric } from "./types";

interface Wording {
  /** What a value ABOVE the middle of the pack did. */
  up: string;
  /** What a value BELOW the middle of the pack did. */
  down: string;
  /** What a value above ZERO did - a different question from the two above. */
  positive: string;
  /** What a value below ZERO did. */
  negative: string;
  /** The axis caption over the diverging bars. */
  axis: string;
  /**
   * The two ends of the bar, as NOUNS.
   *
   * `up`/`down` are verb phrases that read as a finding ("grew fastest"), and
   * they cannot be dropped into "left is ___" - "left is grew slowest" is what
   * that produced. These say the same thing in the one grammatical slot the
   * legend has.
   */
  barLeft: string;
  barRight: string;
  /** One line saying what the ranking is on, in a reader's words. */
  meaning: string;
}

const WORDING: Record<HeatmapMetric, Wording> = {
  yoy_acceleration_ppt: {
    up: "sped up",
    down: "slowed",
    positive: "sped up",
    negative: "slowed",
    axis: "slower ← middle → faster",
    barLeft: "slowing",
    barRight: "speeding up",
    meaning:
      "how much each stage's growth rate moved since the month before — not how fast it is growing. " +
      "A stage can be growing 70% and still be slowing down.",
  },
  yoy_pct: {
    up: "grew fastest",
    down: "grew slowest",
    positive: "grew",
    negative: "shrank",
    axis: "slower ← middle → faster",
    barLeft: "slower growth",
    barRight: "faster growth",
    meaning: "how much each stage grew against the same month a year earlier.",
  },
  mom_pct: {
    up: "grew fastest",
    down: "grew slowest",
    positive: "grew",
    negative: "shrank",
    axis: "slower ← middle → faster",
    barLeft: "slower growth",
    barRight: "faster growth",
    meaning:
      "how much each stage grew against the month before. This one is seasonal — a February " +
      "dip is the Lunar New Year, not a downturn.",
  },
  cumulative_yoy_pct: {
    up: "grew fastest",
    down: "grew slowest",
    positive: "grew",
    negative: "shrank",
    axis: "slower ← middle → faster",
    barLeft: "slower growth",
    barRight: "faster growth",
    meaning:
      "how much each stage has grown so far this year against the same stretch of last year.",
  },
};

export function wordingFor(metric: HeatmapMetric): Wording {
  return WORDING[metric] ?? WORDING.yoy_acceleration_ppt;
}

export interface Read {
  /** The sentence set in the largest type on the page. */
  headline: string;
  /** One line underneath, carrying the numbers that back it. */
  detail: string;
}

/**
 * The month's finding, as two sentences.
 *
 * Returns null when there is nothing to say - fewer than two stages with a
 * value, or a spread of zero - rather than a hedged sentence. A card with no
 * finding should show an empty state, not a paragraph explaining that it has no
 * finding.
 */
export function standoutRead(
  metric: HeatmapMetric,
  ranked: readonly Standout<{ bucket: string }>[],
  median: number | null,
): Read | null {
  const top = ranked[0];
  if (!top || median === null || top.score === null) return null;

  const w = wordingFor(metric);
  const spec = metricSpec(metric);
  const fmt = (v: number | null) => (spec.unit === "ppt" ? ppt(v) : pct(v));
  const label = scoreLabel(top.score);
  const total = ranked.length;

  // Nothing broke away. Said plainly, because "the widest gap this month is
  // 1.2x" is a real and useful answer - it is the month where the chain moved
  // together - and dressing it up as a finding would be the lie.
  if (!label.apart) {
    return {
      headline: "No stage broke away this month.",
      detail:
        `All ${total} stages moved together — the furthest from the middle is only ` +
        `${(label.times ?? 0).toFixed(1)}× the usual distance between stages, which is not a story.`,
    };
  }

  const below = top.value < median;
  // Counted against ZERO, not against the median: half the stages sit either
  // side of a median by construction, so "5 of 10 went the other way" would be
  // arithmetic dressed as an observation. How many actually grew, or actually
  // sped up, is a fact about the month.
  const positive = ranked.filter((r) => r.value > 0).length;
  const wentOtherWay = below ? positive : total - positive;
  const contrast =
    wentOtherWay > total / 2 ? ` while most of the chain ${below ? w.positive : w.negative}` : "";

  return {
    headline: `${top.item.bucket} ${below ? w.down : w.up}${contrast}.`,
    detail:
      `${positive} of ${total} stages ${w.positive} this month. ` +
      `${top.item.bucket} came in at ${fmt(top.value)} against a middle of ${fmt(median)} — ` +
      `a gap ${(label.times ?? 0).toFixed(1)}× wider than usual between stages.`,
  };
}

/**
 * How a shareholding is treated, in a sentence rather than an accounting term.
 *
 * The screen only ever needs one bit from this - is the child's revenue inside
 * the parent's filing or not - and for every pair on this dashboard the answer
 * is no. The accounting term is what makes that answer checkable, so it stays,
 * as the hover title on the row rather than as the row's own words.
 */
export function treatmentTip(treatment: string): string {
  switch (treatment) {
    case "equity_method":
      return "Equity method — the parent books a share of the profit, not a share of the revenue.";
    case "fvoci":
      return "Fair value, passive — the parent holds shares and books nothing of the revenue.";
    default:
      return `${treatment} — not consolidated into the parent's revenue.`;
  }
}
