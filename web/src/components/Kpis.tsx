/**
 * The summary strip.
 *
 * Every figure states its basis - "34 of 37 filed", "n=31", "revenue-weighted". A
 * single headline number with no denominator is the easiest way to mislead on this
 * dataset, because the denominator genuinely moves month to month: companies file
 * late, and one name in the universe has no filing obligation at all.
 *
 * It used to be seven separate cards, each with its own border, radius, header rule
 * and 24px number. That is seven frames around one sentence's worth of context, and
 * on a wide screen the seven titles read as seven unrelated widgets rather than as
 * one month's summary. It is now one card whose cells are divided by hairlines -
 * which is what the borders were for - and the month, previously a tile of its own,
 * is where it belongs: in the subtitle, ahead of the figures it qualifies.
 *
 * The hairlines are the grid's own 1px gaps showing the container color through.
 * Per-cell borders would dangle at the end of a wrapped row.
 *
 * Bucket leader and laggard are read from the same heatmap response the Overview
 * chart renders, not recomputed here. Two implementations of one aggregation drift
 * apart, and the server's version is the one with the revenue weights.
 */

import { WidgetCard } from "./WidgetCard";
import { consolidatedNote } from "./AlertStrip";
import { NA, monthLabel, pct, ppt, revenue } from "../format";
import { forAggregate, forMonth, medianOf, sumRevenue, weightedYoY } from "../stats";
// Aliased. `consolidatedNote` above is about the two names that file in a
// FOREIGN CURRENCY on a consolidated basis; this one is about a name whose
// revenue is inside another tracked company's. Two different senses of the
// same English word, one line apart, is a rename waiting to be got wrong.
import { consolidationNote as doubleCountNote } from "../generated/relationships";
import { metricSpec } from "../scale";
import type { AnalyticsRow, BucketCell, HeatmapMetric, Meta } from "../types";

interface Kpi {
  label: string;
  value: string;
  basis: string;
  tone?: "up" | "down";
  /** A name rather than a number: smaller, allowed to wrap, not tabular. */
  text?: boolean;
}

/** Absent is neither up nor down, so it gets no tone rather than a neutral one. */
function tone(v: number | null): Pick<Kpi, "tone"> {
  return v === null ? {} : { tone: v >= 0 ? "up" : "down" };
}

function Cell({ label, value, basis, tone: t, text }: Kpi) {
  return (
    <div style={{ background: "var(--card-bg)", padding: "9px 12px 10px", minWidth: 0 }}>
      <div className="eyebrow">{label}</div>
      <div
        className={text ? undefined : "tnum"}
        style={{
          marginTop: 3,
          fontSize: text ? 12.5 : 19,
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: text ? undefined : "-0.015em",
          color: t === "up" ? "var(--ink-up)" : t === "down" ? "var(--ink-down)" : "var(--text-primary)",
        }}
      >
        {value}
      </div>
      <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)", lineHeight: 1.35 }}>
        {basis}
      </div>
    </div>
  );
}

export function Kpis({
  rows,
  meta,
  bucketCells,
  latestMonth,
  metric,
  filtered = false,
}: {
  rows: AnalyticsRow[];
  meta: Meta | null;
  bucketCells: BucketCell[] | null;
  latestMonth: string | null;
  /**
   * Which metric `bucketCells` carries. Required, because the fastest/slowest
   * basis used to hardcode "ppt" while the cells come from the metric-selectable
   * bucket heatmap - so choosing YoY growth, MoM growth or Cumulative YoY
   * labelled a percentage as percentage points, which on this dashboard are two
   * different quantities (a rate versus the change in that rate).
   */
  metric: HeatmapMetric;
  /** Whether a stage/tier filter is narrowing `rows`. See the subtitle below. */
  filtered?: boolean;
}) {
  const monthRows = forMonth(rows, latestMonth);
  const universeN = meta?.universe.length ?? 0;
  const trackable = meta?.universe.filter((u) => u.status === "active").length ?? 0;
  const note = consolidatedNote(meta?.alerts);
  const dedupe = doubleCountNote();
  const spec = metricSpec(metric);
  /** The stage cells are in the metric's own unit, which is not always ppt. */
  const stageValue = (v: number | null) => (spec.unit === "ppt" ? ppt(v) : pct(v));

  // SUMS ONLY. Wiwynn's revenue is already inside Wistron's reported figure, so
  // adding both counted it twice - 4.55% too high on the universe total. The
  // medians below deliberately keep every filer: a median counts each company
  // once, so it is not the same arithmetic and not the same error, and dropping
  // a real filer out of a median would be a fresh one.
  const summable = forAggregate(monthRows);
  const total = sumRevenue(summable);
  const wYoY = weightedYoY(summable);
  // The FILING count, which is not the summed count: a de-duplicated company
  // still filed. Using total.n in the subtitle would have reported "35 of 36
  // trackable filed" on a month where all 36 did, turning a correctness fix
  // into a phantom coverage failure.
  const filedN = monthRows.filter((r) => r.revenue_twd_thousands !== null).length;
  const deduped = filedN - total.n;
  const t1 = monthRows.filter((r) => r.tier === 1);
  const t1Yoy = medianOf(t1, (r) => r.yoy_pct);
  const accel = medianOf(monthRows, (r) => r.yoy_acceleration_ppt);

  // Leader/laggard from the server's revenue-weighted bucket aggregate.
  const latestCells = (bucketCells ?? []).filter(
    (c) => c.month === latestMonth && c.value !== null,
  );
  const sorted = [...latestCells].sort((a, b) => (b.value as number) - (a.value as number));
  const leader = sorted[0];
  const laggard = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;

  const kpis: Kpi[] = [
    {
      label: "Universe revenue",
      value: revenue(total.value),
      basis:
        `sum of ${total.n} filings` +
        (total.missing ? ` · ${total.missing} absent` : "") +
        (deduped > 0 ? ` · ${deduped} inside another filer` : ""),
    },
    {
      label: "Universe YoY",
      value: pct(wYoY.value),
      basis: `revenue-weighted · n=${wYoY.n}`,
      ...tone(wYoY.value),
    },
    {
      label: "Tier-1 median YoY",
      value: pct(t1Yoy.value),
      basis: `median of ${t1Yoy.n} tier-1 names`,
      ...tone(t1Yoy.value),
    },
    {
      label: "Median acceleration",
      value: ppt(accel.value),
      basis: `median of ${accel.n} names · change in YoY rate`,
      ...tone(accel.value),
    },
    {
      label: "Fastest stage",
      value: leader ? leader.bucket : NA,
      basis: leader
        ? `${stageValue(leader.value)} · ${leader.members_with_revenue} filed, ${leader.members} comparable`
        : "no stage has a value this month",
      text: true,
    },
    {
      label: "Slowest stage",
      value: laggard ? laggard.bucket : NA,
      basis: laggard
        ? `${stageValue(laggard.value)} · ${laggard.members_with_revenue} filed, ${laggard.members} comparable`
        : "needs two or more stages",
      text: true,
    },
  ];

  return (
    <div style={{ marginBottom: "var(--grid-gap)" }}>
      <WidgetCard
        title="Summary"
        subtitle={
          latestMonth
            ? filtered
              // `total.n` counts filings among the FILTERED rows, while
              // `trackable`/`universeN` come from the unfiltered /api/meta. Read
              // as one fraction that said "3 of 36 trackable filed" when 33 names
              // were merely filtered out, which reads as a filing failure.
              ? `${monthLabel(latestMonth)} · ${filedN} filed in the current filter · ` +
                `${trackable} trackable of ${universeN} in universe`
              : `${monthLabel(latestMonth)} · ${filedN} of ${trackable} trackable filed · ${universeN} in universe`
            : "no data loaded"
        }
        full
        staticCard
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
            // The gaps ARE the hairlines: the container color shows through them.
            gap: 1,
            background: "var(--border)",
          }}
        >
          {kpis.map((k) => (
            <Cell key={k.label} {...k} />
          ))}
        </div>
        {/* Universe revenue is a SUM, and two of the names summed into it file
            consolidated in a foreign currency. That caveat used to be visible
            only if you opened those two companies - which is not where anyone
            would misread it. It belongs against the total. */}
        {[dedupe, note].filter(Boolean).map((line) => (
          <div
            key={line as string}
            style={{
              padding: "6px 12px",
              borderTop: "1px solid var(--border)",
              fontSize: 10,
              color: "var(--text-hint)",
            }}
          >
            {line}
          </div>
        ))}
      </WidgetCard>
    </div>
  );
}
