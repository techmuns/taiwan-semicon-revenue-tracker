/**
 * Supply-chain stages as small multiples: one rebased revenue index per stage,
 * all on one shared y scale.
 *
 * Two deliberate choices.
 *
 * **Small multiples, not ten lines on one chart.** There are up to ten stages, and
 * the categorical palette has eight slots for a reason - past three or four lines a
 * shared plot is unreadable regardless of the colors. A 9th series is a facet, not a
 * new hue. Every panel shares the same y domain, which is what makes them
 * comparable; a per-panel autoscale would make a +8% stage look like a +80% one.
 *
 * **Constant-membership index.** For each month the numerator and denominator cover
 * the *same* set of companies - those with revenue in both the base month and that
 * month. Naively summing whoever filed makes the index jump when a company joins or
 * skips, which reads as a demand inflection and is nothing of the kind. The member
 * count per month is in the tooltip so a thin month is visible.
 */

import { WidgetCard } from "./WidgetCard";
import { MonthLines } from "./charts";
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

export function Buckets({ rows }: { rows: AnalyticsRow[] }) {
  const months = sortedMonths(rows);
  const byBucket = groupBy(rows, (r) => r.bucket);
  const stages = [...byBucket.entries()]
    .map(([bucket, rs]) => buildIndex(bucket, rs, months))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  if (stages.length === 0 || months.length === 0) {
    return (
      <WidgetCard title="Stage index" category="sector">
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

  return (
    <>
      {stages.map((s) => {
        const last = [...s.index].reverse().find((v) => v !== null) ?? null;
        return (
          <WidgetCard
            key={s.bucket}
            title={s.bucket}
            subtitle={
              s.baseMonth
                ? `Index · ${monthLabel(s.baseMonth)} = 100 · ${s.totalMembers} name${
                    s.totalMembers === 1 ? "" : "s"
                  }`
                : `${s.totalMembers} names · no revenue in this window`
            }
            category="sector"
            actions={
              last === null ? null : (
                <span
                  className="tnum"
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: last >= 100 ? "#a52a2a" : "var(--seq-550)",
                  }}
                  title="Latest index level against a base of 100"
                >
                  {last.toFixed(0)}
                </span>
              )
            }
          >
            {s.baseMonth === null ? (
              <EmptyState
                message="No revenue on file"
                hint="No company in this stage filed inside the selected window."
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
                height={160}
                unit=""
                domain={domain}
                refLine={100}
              />
            )}
          </WidgetCard>
        );
      })}
    </>
  );
}
