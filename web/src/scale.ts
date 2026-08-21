/**
 * The heatmap's color scale.
 *
 * Diverging, seven bands: three per arm plus a neutral gray middle. Red is the
 * positive arm (see the note in tokens.css - Taiwanese market convention), blue
 * the negative, and the middle band is gray so "about zero" reads as "nothing
 * happening" rather than as a weak version of one sign.
 *
 * Two properties hold by construction:
 *
 *  1. **The arms are lightness-mirrored.** Band +2 and band -2 have the same
 *     OKLCH lightness and chroma, so +18ppt and -18ppt are equally loud.
 *  2. **Every band's ink clears 4.5:1 against its fill.** Measured, not guessed:
 *     the two darkest bands take white ink (8.6:1, 8.1:1) and the rest take the
 *     primary ink (4.57:1 at worst). This is what lets the cell print its own
 *     value, which is what keeps color from being the only carrier of meaning.
 *
 * Absent values are NOT a band. They get a hatched cell, because a missing
 * filing is not a small number.
 */

import type { HeatmapMetric } from "./types";

/** Band index: -3..+3, or null for absent. */
export type Band = -3 | -2 | -1 | 0 | 1 | 2 | 3 | null;

const FILL: Record<Exclude<Band, null>, string> = {
  [-3]: "var(--div-neg-3)",
  [-2]: "var(--div-neg-2)",
  [-1]: "var(--div-neg-1)",
  0: "var(--div-mid)",
  1: "var(--div-pos-1)",
  2: "var(--div-pos-2)",
  3: "var(--div-pos-3)",
};

/** White only on the two darkest bands; measured contrast, not taste. */
const INK: Record<Exclude<Band, null>, string> = {
  [-3]: "#ffffff",
  [-2]: "var(--text-primary)",
  [-1]: "var(--text-primary)",
  0: "var(--text-primary)",
  1: "var(--text-primary)",
  2: "var(--text-primary)",
  3: "#ffffff",
};

/**
 * Absolute thresholds for bands 1/2/3, per metric.
 *
 * Acceleration is in percentage POINTS and is a second difference, so it is much
 * smaller in magnitude than a growth rate - a 25ppt swing in the YoY rate is
 * enormous. Growth rates get wider bands. Fixed rather than data-derived on
 * purpose: a scale that renormalises to the current filter makes two screenshots
 * of the same company incomparable.
 */
const BREAKS: Record<HeatmapMetric, readonly [number, number, number]> = {
  yoy_acceleration_ppt: [2, 10, 25],
  yoy_pct: [5, 25, 60],
  mom_pct: [3, 15, 40],
  cumulative_yoy_pct: [5, 25, 60],
};

export interface MetricSpec {
  key: HeatmapMetric;
  label: string;
  /** Unit shown next to values. "ppt" and "%" are not interchangeable. */
  unit: "ppt" | "%";
  /** One line explaining what the number is, for the widget subtitle. */
  blurb: string;
}

export const METRICS: readonly MetricSpec[] = [
  {
    key: "yoy_acceleration_ppt",
    label: "YoY acceleration",
    unit: "ppt",
    blurb: "Change in the year-on-year growth rate vs the prior month - is growth speeding up",
  },
  {
    key: "yoy_pct",
    label: "YoY growth",
    unit: "%",
    blurb: "Revenue vs the same month a year earlier",
  },
  {
    key: "mom_pct",
    label: "MoM growth",
    unit: "%",
    blurb: "Revenue vs the prior month - seasonal, read with care",
  },
  {
    key: "cumulative_yoy_pct",
    label: "Cumulative YoY",
    unit: "%",
    blurb: "Year-to-date revenue vs the same span a year earlier",
  },
];

export function metricSpec(metric: HeatmapMetric): MetricSpec {
  return METRICS.find((m) => m.key === metric) ?? METRICS[0]!;
}

export function bandFor(value: number | null | undefined, metric: HeatmapMetric): Band {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const [b1, b2, b3] = BREAKS[metric];
  const a = Math.abs(value);
  const sign = value < 0 ? -1 : 1;
  if (a < b1) return 0;
  const magnitude = a < b2 ? 1 : a < b3 ? 2 : 3;
  return (sign * magnitude) as Band;
}

export interface CellStyle {
  background: string;
  color: string;
  /** Set for absent cells; the hatch is what says "no filing", not a color. */
  backgroundImage?: string;
}

export function cellStyle(value: number | null | undefined, metric: HeatmapMetric): CellStyle {
  const band = bandFor(value, metric);
  if (band === null) {
    return {
      background: "var(--cell-missing-bg)",
      color: "var(--cell-missing-ink)",
      // 45-degree hatch: the accessibility channel, and unmistakably not a value.
      backgroundImage:
        "repeating-linear-gradient(45deg, transparent, transparent 3px, #e8e6e0 3px, #e8e6e0 4px)",
    };
  }
  return { background: FILL[band], color: INK[band] };
}

export interface LegendStop {
  band: Exclude<Band, null>;
  fill: string;
  ink: string;
  label: string;
}

/** Legend stops, negative to positive, with the thresholds spelled out. */
export function legendStops(metric: HeatmapMetric): LegendStop[] {
  const [b1, b2, b3] = BREAKS[metric];
  const u = metricSpec(metric).unit;
  const stop = (band: Exclude<Band, null>, label: string): LegendStop => ({
    band,
    fill: FILL[band],
    ink: INK[band],
    label,
  });
  return [
    stop(-3, `< -${b3}`),
    stop(-2, `-${b3} to -${b2}`),
    stop(-1, `-${b2} to -${b1}`),
    stop(0, `±${b1} ${u}`),
    stop(1, `${b1} to ${b2}`),
    stop(2, `${b2} to ${b3}`),
    stop(3, `> ${b3}`),
  ];
}

// ------------------------------------------------------------- sequential --

/** Blue, light->dark, for pure magnitude (revenue). Five documented steps. */
const SEQ = [
  "var(--seq-100)",
  "var(--seq-250)",
  "var(--seq-400)",
  "var(--seq-550)",
  "var(--seq-700)",
] as const;

/**
 * Magnitude -> sequential step, on a log scale.
 *
 * Revenue across this universe spans four orders of magnitude (a NT$300m
 * substrate maker next to TSMC). Linear binning would put 35 of 37 companies in
 * the lightest step and tell the reader nothing.
 */
export function sequentialFill(
  value: number | null | undefined,
  maxValue: number,
): string | null {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) return null;
  if (maxValue <= 0) return null;
  const t = Math.log10(value + 1) / Math.log10(maxValue + 1);
  const idx = Math.min(SEQ.length - 1, Math.max(0, Math.floor(t * SEQ.length)));
  return SEQ[idx] ?? null;
}
