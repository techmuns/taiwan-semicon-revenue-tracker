/**
 * Supply-chain stages as small multiples: one rebased revenue index per stage,
 * all on one shared y scale.
 *
 * Three deliberate choices.
 *
 * **Small multiples, not ten lines on one chart.** There are up to ten stages, and
 * the categorical palette has eight slots for a reason - past three or four lines a
 * shared plot is unreadable regardless of the colors. A 9th series is a facet, not a
 * new hue. Every panel shares the same y domain, which is what makes them
 * comparable; a per-panel autoscale would make a +8% stage look like a +80% one.
 *
 * **One card, ten panels - not ten cards.** These are facets of a single chart, and
 * ten card frames said otherwise: ten borders, ten radii, ten header rules and ten
 * copies of every control around what is one visualization. The panels are now
 * divided by hairlines inside one widget, which is also what lets the graph/table
 * toggle appear once instead of ten times.
 *
 * **Constant-membership index.** For each month the numerator and denominator cover
 * the *same* set of companies - those with revenue in both the base month and that
 * month. Naively summing whoever filed makes the index jump when a company joins or
 * skips, which reads as a demand inflection and is nothing of the kind. The table
 * view carries the per-month member count as its second column, so a month that is
 * thin rather than weak is visible rather than inferred.
 */

import { WidgetCard } from "./WidgetCard";
import { MonthLines } from "./charts";
import { ViewToggle } from "./controls";
import type { ViewMode } from "./controls";
import { SeriesTable } from "./tables";
import { EmptyState } from "./states";
import { monthLabel } from "../format";
import { groupBy, sortedMonths } from "../stats";
import type { AnalyticsRow } from "../types";

interface StageIndex {
  bucket: string;
  months: string[];
  index: (number | null)[];
  members: (number | null)[];
  baseMonth: string | null;
  totalMembers: number;
}

function buildIndex(bucket: string, rows: AnalyticsRow[], months: string[]): StageIndex {
  const byTicker = groupBy(rows, (r) => r.ticker);
  const revOf = new Map<string, Map<string, number>>();
  for (const [ticker, rs] of byTicker) {
    const m = new Map<string, number>();
    for (const r of rs) {
      if (r.revenue_twd_thousands !== null && r.revenue_twd_thousands > 0) {
        m.set(r.month, r.revenue_twd_thousands);
      }
    }
    revOf.set(ticker, m);
  }

  // The base is the first month where any member filed.
  const baseMonth = months.find((m) => [...revOf.values()].some((r) => r.has(m))) ?? null;
  if (!baseMonth) {
    return {
      bucket,
      months,
      index: months.map(() => null),
      members: months.map(() => null),
      baseMonth: null,
      totalMembers: byTicker.size,
    };
  }

  const index: (number | null)[] = [];
  const members: (number | null)[] = [];
  for (const m of months) {
    let now = 0;
    let base = 0;
    let n = 0;
    for (const rev of revOf.values()) {
      const a = rev.get(baseMonth);
      const b = rev.get(m);
      // Both or neither: the set is identical on each side of the ratio.
      if (a === undefined || b === undefined) continue;
      base += a;
      now += b;
      n++;
    }
    index.push(n > 0 && base > 0 ? (100 * now) / base : null);
    members.push(n > 0 ? n : null);
  }

  return { bucket, months, index, members, baseMonth, totalMembers: byTicker.size };
}

export function Buckets({
  rows,
  viz,
  onViz,
}: {
  rows: AnalyticsRow[];
  viz: ViewMode;
  onViz: (v: ViewMode) => void;
}) {
  const months = sortedMonths(rows);
  const byBucket = groupBy(rows, (r) => r.bucket);
  const stages = [...byBucket.entries()]
    .map(([bucket, rs]) => buildIndex(bucket, rs, months))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  if (stages.length === 0 || months.length === 0) {
    return (
      <WidgetCard title="Stage index" full>
        <EmptyState
          message="No rows in this window"
          hint="Widen the month range or clear the stage and tier filters."
        />
      </WidgetCard>
    );
  }

  // One shared domain across every panel. This is the whole point of the layout.
  const all = stages.flatMap((s) => s.index).filter((v): v is number => v !== null);
  const lo = all.length ? Math.min(...all, 100) : 90;
  const hi = all.length ? Math.max(...all, 100) : 110;
  const padSpan = Math.max(2, (hi - lo) * 0.1);
  const domain = [lo - padSpan, hi + padSpan] as const;

  const base = stages.find((s) => s.baseMonth)?.baseMonth ?? null;

  return (
    <WidgetCard
      title="Stage index"
      subtitle={
        base
          ? `Rebased revenue · ${monthLabel(base)} = 100 · constant membership · one shared scale`
          : "Rebased revenue · no revenue in this window"
      }
      full
      staticCard
      actions={<ViewToggle value={viz} onChange={onViz} />}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(268px, 1fr))",
          // The gaps are the panel dividers - one hairline system, no per-panel frames.
          gap: 1,
          background: "var(--border)",
        }}
      >
        {stages.map((s) => (
          <StagePanel key={s.bucket} stage={s} viz={viz} domain={domain} />
        ))}
      </div>
    </WidgetCard>
  );
}

function StagePanel({
  stage: s,
  viz,
  domain,
}: {
  stage: StageIndex;
  viz: ViewMode;
  domain: readonly [number, number];
}) {
  const last = [...s.index].reverse().find((v) => v !== null) ?? null;

  return (
    <div style={{ background: "var(--card-bg)", padding: "8px 2px 4px", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          padding: "0 10px 4px",
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--text-primary)",
            minWidth: 0,
          }}
        >
          {s.bucket}
        </span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: "var(--text-hint)" }}>
            {s.totalMembers} name{s.totalMembers === 1 ? "" : "s"}
          </span>
          {last !== null && (
            <span
              className="tnum"
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: last >= 100 ? "var(--ink-up)" : "var(--ink-down)",
              }}
              title="Latest index level against a base of 100"
            >
              {last.toFixed(0)}
            </span>
          )}
        </span>
      </div>

      {s.baseMonth === null ? (
        <div style={{ padding: "22px 10px", fontSize: 11, color: "var(--text-hint)" }}>
          No company in this stage filed inside the selected window.
        </div>
      ) : viz === "table" ? (
        <SeriesTable
          months={s.months}
          series={[
            {
              key: s.bucket,
              label: "Index",
              values: s.index,
              format: (v) => (v as number).toFixed(1),
              color: "var(--seq-400)",
            },
            {
              key: `${s.bucket}-n`,
              label: "Names",
              values: s.members,
              format: (v) => (v as number).toFixed(0),
            },
          ]}
          maxHeight={220}
          note="100 = base month · Names is the constant-membership count"
        />
      ) : (
        <MonthLines
          months={s.months}
          series={[
            {
              key: s.bucket,
              label: s.bucket,
              color: "var(--seq-400)",
              values: s.index,
            },
          ]}
          height={150}
          unit=""
          domain={domain}
          refLine={100}
        />
      )}
    </div>
  );
}
