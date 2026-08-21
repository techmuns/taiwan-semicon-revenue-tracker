/**
 * The KPI row.
 *
 * Every tile states its basis in the subtitle - "34 of 37 filed", "n=31",
 * "revenue-weighted". A single headline number with no denominator is the easiest
 * way to mislead on this dataset, because the denominator genuinely moves month to
 * month: companies file late, and one name in the universe has no filing
 * obligation at all.
 *
 * Bucket leader and laggard are read from the same heatmap response the Overview
 * chart renders, not recomputed here. Two implementations of one aggregation drift
 * apart, and the server's version is the one with the revenue weights.
 */

import { WidgetCard } from "./WidgetCard";
import type { ReactNode } from "react";
import { NA, monthLabel, pct, ppt, revenue } from "../format";
import { forMonth, medianOf, sumRevenue, weightedYoY } from "../stats";
import type { AnalyticsRow, BucketCell, Meta } from "../types";

function KpiCard({
  title,
  value,
  basis,
  tone,
  children,
}: {
  title: string;
  value: ReactNode;
  basis: string;
  tone?: "up" | "down";
  children?: ReactNode;
}) {
  return (
    <WidgetCard title={title}>
      <div style={{ padding: "14px 16px 12px" }}>
        <div
          className="tnum"
          style={{
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
            color:
              tone === "up"
                ? "#a52a2a"
                : tone === "down"
                  ? "var(--seq-550)"
                  : "var(--text-primary)",
          }}
        >
          {value}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-hint)" }}>{basis}</div>
        {children}
      </div>
    </WidgetCard>
  );
}

export function Kpis({
  rows,
  meta,
  bucketCells,
  latestMonth,
}: {
  rows: AnalyticsRow[];
  meta: Meta | null;
  bucketCells: BucketCell[] | null;
  latestMonth: string | null;
}) {
  const monthRows = forMonth(rows, latestMonth);
  const universeN = meta?.universe.length ?? 0;
  const trackable = meta?.universe.filter((u) => u.status === "active").length ?? 0;

  const total = sumRevenue(monthRows);
  const wYoY = weightedYoY(monthRows);
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

  return (
    <div
      style={{
        display: "grid",
        gap: "var(--grid-gap)",
        gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))",
        marginBottom: "var(--grid-gap)",
      }}
    >
      <KpiCard
        title="Latest month"
        value={latestMonth ? monthLabel(latestMonth) : NA}
        basis={
          latestMonth
            ? `${total.n} of ${trackable} trackable filed · ${universeN} in universe`
            : "no data loaded"
        }
      />

      <KpiCard
        title="Universe revenue"
        value={revenue(total.value)}
        basis={`sum of ${total.n} filings${total.missing ? ` · ${total.missing} absent` : ""}`}
      />

      <KpiCard
        title="Universe YoY"
        value={pct(wYoY.value)}
        basis={`revenue-weighted · n=${wYoY.n}`}
        {...(wYoY.value !== null ? { tone: wYoY.value >= 0 ? ("up" as const) : ("down" as const) } : {})}
      />

      <KpiCard
        title="Tier-1 median YoY"
        value={pct(t1Yoy.value)}
        basis={`median of ${t1Yoy.n} tier-1 names`}
        {...(t1Yoy.value !== null
          ? { tone: t1Yoy.value >= 0 ? ("up" as const) : ("down" as const) }
          : {})}
      />

      <KpiCard
        title="Median acceleration"
        value={ppt(accel.value)}
        basis={`median of ${accel.n} names · change in YoY rate`}
        {...(accel.value !== null
          ? { tone: accel.value >= 0 ? ("up" as const) : ("down" as const) }
          : {})}
      />

      <KpiCard
        title="Fastest stage"
        value={leader ? leader.bucket : NA}
        basis={
          leader
            ? `${ppt(leader.value)} · ${leader.members_with_revenue} of ${leader.members} filed`
            : "no bucket has a value this month"
        }
      />

      <KpiCard
        title="Slowest stage"
        value={laggard ? laggard.bucket : NA}
        basis={
          laggard
            ? `${ppt(laggard.value)} · ${laggard.members_with_revenue} of ${laggard.members} filed`
            : "needs two or more stages"
        }
      />
    </div>
  );
}
