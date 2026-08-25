/**
 * The heatmap, used for both the bucket x month and ticker x month views.
 *
 * It is a real `<table>`, not a grid of divs. Three things fall out of that for
 * free: screen readers get row/column association, the browser's own find-in-page
 * works on the values, and the "a table view exists" accessibility requirement is
 * satisfied by the primary widget itself rather than by a separate mode.
 *
 * Every cell prints its signed value. Color is a second encoding of the same
 * number, never the only one - which is what makes the red/blue polarity safe
 * despite the convention being regional (see tokens.css).
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { NA, isMissing, monthShort } from "../format";
import { bandFor, cellStyle, legendStops, metricSpec } from "../scale";
import { meanOf } from "../stats";
import type { HeatmapMetric } from "../types";

/**
 * The summary column is set off by a 2px rule rather than a different fill.
 *
 * It carries the same metric on the same scale as the cells beside it, so it gets
 * the same color encoding - that is exactly what makes it readable in the same
 * glance. What it must not do is read as a ninth month, and a rule says so without
 * spending any color the values are already using.
 */
const SUMMARY_EDGE = "2px solid var(--border-solid)";

export interface HeatCellData {
  value: number | null;
  /** Extra tooltip lines - revenue, member counts, whatever the view knows. */
  detail?: ReactNode;
  /** Marks a caveat on this cell (bucket membership changed vs the prior month). */
  flag?: boolean;
}

export interface HeatRow {
  key: string;
  label: string;
  sublabel?: string;
  cells: Record<string, HeatCellData | undefined>;
}

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

export function Heatmap({
  months,
  rows,
  metric,
  rowHeader = "Group",
  onRowClick,
  maxHeight = 460,
  average = true,
}: {
  months: string[];
  rows: HeatRow[];
  metric: HeatmapMetric;
  rowHeader?: string;
  onRowClick?: (key: string) => void;
  maxHeight?: number | string;
  /** The trailing per-row mean across the months in view. */
  average?: boolean;
}) {
  const [tip, setTip] = useState<TipState | null>(null);
  const spec = metricSpec(metric);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ overflow: "auto", maxHeight }}>
        <table
          className="tnum"
          style={{
            borderCollapse: "separate",
            borderSpacing: 0,
            width: "100%",
            fontSize: 11,
            background: "var(--chart-surface)",
          }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  position: "sticky",
                  left: 0,
                  top: 0,
                  zIndex: 3,
                  background: "var(--chart-surface)",
                  textAlign: "left",
                  padding: "6px 10px",
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--ink-muted)",
                  borderBottom: "1px solid var(--grid-line)",
                  // Pinned, not just a minimum. Under `width: 100%` the browser
                  // hands all slack to the first column, so on a wide screen the
                  // label column grew a large empty gutter and squeezed the
                  // months into the right-hand third.
                  width: 200,
                  minWidth: 168,
                }}
              >
                {rowHeader}
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  scope="col"
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 2,
                    background: "var(--chart-surface)",
                    padding: "6px 4px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--ink-muted)",
                    borderBottom: "1px solid var(--grid-line)",
                    minWidth: 46,
                    whiteSpace: "nowrap",
                  }}
                  title={m}
                >
                  {monthShort(m)}
                  {m.endsWith("-01") && (
                    <span style={{ display: "block", fontSize: 9, fontWeight: 400 }}>
                      {m.slice(2, 4)}
                    </span>
                  )}
                </th>
              ))}
              {average && (
                <th
                  scope="col"
                  title={`Mean ${spec.label.toLowerCase()} across the months in view, per row. Absent months are excluded from the divisor, never counted as zero.`}
                  style={{
                    position: "sticky",
                    top: 0,
                    right: 0,
                    zIndex: 3,
                    background: "var(--chart-surface)",
                    padding: "6px 6px",
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid var(--grid-line)",
                    borderLeft: SUMMARY_EDGE,
                    minWidth: 52,
                    whiteSpace: "nowrap",
                  }}
                >
                  Avg
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const avg = average
                ? meanOf(months.map((m) => row.cells[m]?.value ?? null))
                : null;
              return (
              <tr key={row.key}>
                <th
                  scope="row"
                  onClick={onRowClick ? () => onRowClick(row.key) : undefined}
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                    background: "var(--chart-surface)",
                    textAlign: "left",
                    padding: "3px 10px",
                    fontWeight: 500,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    borderRight: "1px solid var(--grid-line)",
                    whiteSpace: "nowrap",
                    cursor: onRowClick ? "pointer" : undefined,
                  }}
                >
                  {/* Two lines, not one run-on. The identity is four facts -
                      name, ticker, stage, tier - and setting them as
                      "Alchip 3661 · AI Silicon · T1" made a 300px ribbon of
                      middle-grey text that the eye has to parse before it can
                      reach the numbers, which are the point. The name gets the
                      first line and the weight; the rest drops to a quiet
                      second line the reader can ignore until they need it. */}
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-primary)" }}>
                    {row.label}
                  </div>
                  {row.sublabel && (
                    <div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-hint)", marginTop: 1 }}>
                      {row.sublabel}
                    </div>
                  )}
                </th>
                {months.map((m) => {
                  const cell = row.cells[m];
                  const value = cell ? cell.value : null;
                  const style = cellStyle(value, metric);
                  const band = bandFor(value, metric);
                  return (
                    <td
                      key={m}
                      style={{
                        ...style,
                        padding: 0,
                        textAlign: "center",
                        // 2px surface gap between fills, so adjacent bands stay legible.
                        border: "1px solid var(--chart-surface)",
                        borderWidth: 1,
                        height: 30,
                        position: "relative",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: band !== null && Math.abs(band) === 3 ? 600 : 400,
                      }}
                      onPointerMove={(e) => {
                        const host = e.currentTarget.closest("div");
                        const r = host?.getBoundingClientRect();
                        setTip({
                          x: r ? e.clientX - r.left : 0,
                          y: r ? e.clientY - r.top : 0,
                          content: (
                            <>
                              <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                {row.label} · {monthShort(m)} {m.slice(0, 4)}
                              </div>
                              <div>
                                {spec.label}:{" "}
                                <strong style={{ color: "var(--text-primary)" }}>
                                  {isMissing(value)
                                    ? "no data"
                                    : `${(value as number) > 0 ? "+" : ""}${(value as number).toFixed(1)} ${spec.unit}`}
                                </strong>
                              </div>
                              {cell?.detail}
                              {cell?.flag && (
                                <div style={{ color: "var(--status-warning)" }}>
                                  membership changed vs prior month
                                </div>
                              )}
                            </>
                          ),
                        });
                      }}
                      onPointerLeave={() => setTip(null)}
                    >
                      {isMissing(value) ? (
                        <span style={{ fontSize: 10 }}>{NA}</span>
                      ) : (
                        <>
                          {(value as number) > 0 ? "+" : ""}
                          {(value as number).toFixed(Math.abs(value as number) >= 100 ? 0 : 1)}
                        </>
                      )}
                      {cell?.flag && (
                        // A caveat is a corner mark, not a different fill - the fill
                        // is spoken for by the value.
                        <span
                          aria-hidden="true"
                          style={{
                            position: "absolute",
                            top: 1,
                            right: 1,
                            width: 0,
                            height: 0,
                            borderTop: "4px solid var(--status-warning)",
                            borderLeft: "4px solid transparent",
                          }}
                        />
                      )}
                    </td>
                  );
                })}
                {avg && (
                  <td
                    style={{
                      ...cellStyle(avg.value, metric),
                      position: "sticky",
                      right: 0,
                      zIndex: 1,
                      padding: "0 4px",
                      textAlign: "center",
                      border: "1px solid var(--chart-surface)",
                      borderLeft: SUMMARY_EDGE,
                      height: 30,
                      fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                    }}
                    onPointerMove={(e) => {
                      const host = e.currentTarget.closest("div");
                      const r = host?.getBoundingClientRect();
                      setTip({
                        x: r ? e.clientX - r.left : 0,
                        y: r ? e.clientY - r.top : 0,
                        content: (
                          <>
                            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                              {row.label} · average
                            </div>
                            <div>
                              Mean {spec.label.toLowerCase()}:{" "}
                              <strong style={{ color: "var(--text-primary)" }}>
                                {isMissing(avg.value)
                                  ? "no data"
                                  : `${(avg.value as number) > 0 ? "+" : ""}${(avg.value as number).toFixed(1)} ${spec.unit}`}
                              </strong>
                            </div>
                            <div style={{ color: "var(--text-hint)" }}>
                              over {avg.n} of {months.length} month
                              {months.length === 1 ? "" : "s"} in view
                              {avg.missing > 0 ? " · absent months excluded, not zeroed" : ""}
                            </div>
                          </>
                        ),
                      });
                    }}
                    onPointerLeave={() => setTip(null)}
                  >
                    {isMissing(avg.value) ? (
                      <span style={{ fontSize: 10 }}>{NA}</span>
                    ) : (
                      <>
                        {(avg.value as number) > 0 ? "+" : ""}
                        {(avg.value as number).toFixed(
                          Math.abs(avg.value as number) >= 100 ? 0 : 1,
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {tip && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: Math.max(4, tip.x - 90),
            top: Math.max(4, tip.y + 14),
            pointerEvents: "none",
            background: "var(--card-bg)",
            border: "1px solid var(--border-solid)",
            borderRadius: "var(--radius-control)",
            boxShadow: "var(--tooltip-shadow)",
            padding: "6px 9px",
            fontSize: 12,
            lineHeight: 1.45,
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
            zIndex: 6,
          }}
        >
          {tip.content}
        </div>
      )}

      <Legend metric={metric} />
    </div>
  );
}

/**
 * The legend states the direction in words.
 *
 * Necessary, not decorative: red = up is the Taiwanese convention and the inverse
 * of the US one, so a reader who assumes wrongly would invert every reading. The
 * words are what disambiguate; the swatches only locate the thresholds.
 */
export function Legend({ metric }: { metric: HeatmapMetric }) {
  const spec = metricSpec(metric);
  const stops = legendStops(metric);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        padding: "8px 12px",
        borderTop: "1px solid var(--border)",
        fontSize: 10,
        color: "var(--text-muted)",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
        slowing
        <span aria-hidden="true"> ←</span>
      </span>
      {stops.map((s) => (
        <span key={s.band} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: s.fill,
              border: "1px solid var(--border-solid)",
            }}
          />
          <span className="tnum">{s.label}</span>
        </span>
      ))}
      <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
        <span aria-hidden="true">→ </span>
        speeding up
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            background: "var(--cell-missing-bg)",
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 3px, var(--hatch-line) 3px, var(--hatch-line) 4px)",
            border: "1px solid var(--border-solid)",
          }}
        />
        no data
      </span>
      <span style={{ marginLeft: "auto", color: "var(--text-hint)" }}>
        {spec.unit === "ppt" ? "percentage points" : "percent"}
      </span>
    </div>
  );
}
