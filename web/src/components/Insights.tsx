/**
 * Leaderboard: who accelerated and who decelerated in the latest month.
 *
 * Acceleration, not growth, is what is ranked. A company at a steady +45% YoY is
 * not news; a company that went from +12% to +38% is. The sparkline beside each
 * name is the YoY path over the window, so a single-month jump can be told apart
 * from a trend - a ranked list alone cannot make that distinction.
 *
 * Both directions are always shown side by side. Showing only the top would turn
 * a screen full of decelerating names into a screen that looks fine.
 */

import { WidgetCard } from "./WidgetCard";
import { Sparkline } from "./charts";
import { NA, pct, ppt } from "../format";
import { groupBy, movers, sortedMonths } from "../stats";
import { bandFor, cellStyle } from "../scale";
import type { AnalyticsRow } from "../types";

function MoverList({
  rows,
  latestRows,
  direction,
  onSelect,
}: {
  rows: AnalyticsRow[];
  latestRows: AnalyticsRow[];
  direction: "top" | "bottom";
  onSelect: (ticker: string) => void;
}) {
  const months = sortedMonths(rows);
  const byTicker = groupBy(rows, (r) => r.ticker);
  const list = movers(latestRows, (r) => r.yoy_acceleration_ppt, 8, direction);

  if (list.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--text-hint)" }}>
        No company has an acceleration figure for this month. Acceleration needs the
        prior month's YoY as well as this month's.
      </div>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <tbody>
        {list.map((m) => {
          const series = byTicker.get(m.ticker) ?? [];
          const byMonth = new Map(series.map((r) => [r.month, r]));
          const yoyPath = months.map((mo) => byMonth.get(mo)?.yoy_pct ?? null);
          const latest = byMonth.get(months[months.length - 1] ?? "");
          const style = cellStyle(m.value, "yoy_acceleration_ppt");
          const band = bandFor(m.value, "yoy_acceleration_ppt");
          return (
            <tr
              key={m.ticker}
              onClick={() => onSelect(m.ticker)}
              style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}
              title={`Open ${m.company_name}`}
            >
              <td style={{ padding: "5px 8px 5px 14px", whiteSpace: "nowrap" }}>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  {m.company_name}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-hint)" }}>
                  {m.ticker} · {m.bucket} · T{m.tier}
                </div>
              </td>
              <td style={{ padding: "5px 6px", width: 80 }}>
                <Sparkline
                  values={yoyPath}
                  color={
                    band !== null && band > 0 ? "var(--div-pos-2)" : "var(--div-neg-2)"
                  }
                />
              </td>
              <td
                className="tnum"
                style={{
                  padding: "5px 8px",
                  textAlign: "right",
                  width: 62,
                  color: "var(--text-secondary)",
                }}
                title="Year-on-year growth this month"
              >
                {latest ? pct(latest.yoy_pct) : NA}
              </td>
              <td
                className="tnum"
                style={{
                  ...style,
                  padding: "5px 10px",
                  textAlign: "right",
                  width: 78,
                  fontWeight: 600,
                }}
                title="Change in the YoY rate vs the prior month"
              >
                {ppt(m.value)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Insights({
  rows,
  latestRows,
  onSelect,
}: {
  rows: AnalyticsRow[];
  latestRows: AnalyticsRow[];
  onSelect: (ticker: string) => void;
}) {
  return (
    <>
      <WidgetCard
        title="Accelerating"
        subtitle="Biggest increase in the YoY rate · sparkline is the YoY path"
        staticCard
      >
        <MoverList rows={rows} latestRows={latestRows} direction="top" onSelect={onSelect} />
      </WidgetCard>
      <WidgetCard
        title="Decelerating"
        subtitle="Biggest decrease in the YoY rate"
        staticCard
      >
        <MoverList rows={rows} latestRows={latestRows} direction="bottom" onSelect={onSelect} />
      </WidgetCard>
    </>
  );
}
