/**
 * The table forms of the charts.
 *
 * Every widget that draws a chart can draw itself as a table of numbers instead,
 * and the toggle that switches between them lives in the widget header. Two
 * reasons this is a first-class view rather than an export:
 *
 *  1. **It is the accessibility relief the palette validator asks for.** The third
 *     categorical slot (aqua) sits at 2.8:1 against the white card surface, under
 *     the 3:1 guide. A contrast WARN is not dismissable - it obligates visible
 *     labels or a table view. The charts carry direct labels at each series' last
 *     real point; this file is the other half.
 *  2. **A number you are going to quote should be read, not estimated.** Off an
 *     axis you can tell that packaging accelerated more than substrate. You cannot
 *     tell whether it was 11.4ppt or 12.1ppt.
 *
 * Both components take exactly the same data the chart takes - `HeatRow[]` for the
 * matrix, the same aligned value arrays for the series - so the two views cannot
 * disagree. Two implementations of one aggregation drift apart; one aggregation
 * with two renderers cannot.
 *
 * No fills. The heatmap's job is to find the hot corner of a 37x8 grid at a
 * glance, which is what color is for; the table's job is to be read, and a value
 * on a saturated ground is harder to read, not easier. What the table keeps is
 * everything color was a second encoding OF: the sign, the magnitude, the em dash
 * for absent, the caveat flag.
 */

import type { CSSProperties, ReactNode } from "react";
import { NA, isMissing, monthLabel, monthShort } from "../format";
import { metricSpec } from "../scale";
import type { HeatmapMetric } from "../types";
import type { HeatRow } from "./Heatmap";

const HEAD: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: "var(--chart-surface)",
  padding: "6px 8px",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--ink-muted)",
  borderBottom: "1px solid var(--grid-line)",
  whiteSpace: "nowrap",
};

/** The em dash, in hint ink so a gap reads as quieter than a number, never as one. */
function Absent() {
  return <span style={{ color: "var(--text-hint)" }}>{NA}</span>;
}

/**
 * The heatmap as numbers: same rows, same months, same order, no fills.
 *
 * Values are right-aligned tabular figures, which is the whole point of a table
 * over a matrix of colored cells - digits line up by place value, so magnitudes
 * are comparable down a column without any encoding at all.
 */
export function MatrixTable({
  months,
  rows,
  metric,
  rowHeader = "Group",
  onRowClick,
  maxHeight = 460,
}: {
  months: string[];
  rows: HeatRow[];
  metric: HeatmapMetric;
  rowHeader?: string;
  onRowClick?: (key: string) => void;
  maxHeight?: number;
}) {
  const spec = metricSpec(metric);
  const anyFlag = rows.some((r) => months.some((m) => r.cells[m]?.flag));

  return (
    <div>
      <div style={{ overflow: "auto", maxHeight }}>
        <table
          className="tnum"
          aria-label={`${spec.label} by ${rowHeader.toLowerCase()} and month, in ${
            spec.unit === "ppt" ? "percentage points" : "percent"
          }`}
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
                style={{ ...HEAD, left: 0, zIndex: 3, textAlign: "left", minWidth: 168 }}
              >
                {rowHeader}
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  scope="col"
                  title={monthLabel(m)}
                  style={{ ...HEAD, textAlign: "right", minWidth: 52 }}
                >
                  {monthShort(m)}
                  {m.endsWith("-01") && (
                    <span style={{ display: "block", fontSize: 9, fontWeight: 400 }}>
                      {m.slice(2, 4)}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
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
                    padding: "3px 8px",
                    fontWeight: 500,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    borderRight: "1px solid var(--grid-line)",
                    borderBottom: "1px solid var(--grid-line)",
                    whiteSpace: "nowrap",
                    cursor: onRowClick ? "pointer" : undefined,
                  }}
                >
                  {row.label}
                  {row.sublabel && (
                    <span style={{ color: "var(--text-hint)", marginLeft: 6, fontWeight: 400 }}>
                      {row.sublabel}
                    </span>
                  )}
                </th>
                {months.map((m) => {
                  const cell = row.cells[m];
                  const v = cell ? cell.value : null;
                  return (
                    <td
                      key={m}
                      title={
                        cell?.flag
                          ? `${row.label} · ${monthLabel(m)} — bucket membership changed vs the prior month`
                          : undefined
                      }
                      style={{
                        padding: "3px 8px",
                        height: 22,
                        textAlign: "right",
                        borderBottom: "1px solid var(--grid-line)",
                        color: isMissing(v) ? "var(--text-hint)" : "var(--text-primary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {isMissing(v) ? (
                        <Absent />
                      ) : (
                        <>
                          {(v as number) > 0 ? "+" : ""}
                          {(v as number).toFixed(1)}
                          {/* The caveat survives the loss of the corner mark as a
                              footnote dagger - still not a different fill. */}
                          {cell?.flag && (
                            <span style={{ color: "var(--status-warning)", fontWeight: 600 }}>†</span>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TableFoot
        unit={spec.unit}
        note={`${spec.label}, signed`}
        {...(anyFlag ? { footnote: "† bucket membership changed vs the prior month" } : {})}
      />
    </div>
  );
}

export interface TableSeries {
  key: string;
  label: string;
  /** Aligned to `months`; null is absent and prints an em dash, never a zero. */
  values: (number | null)[];
  /** Renders one cell. Pass the same formatter the chart's axis uses. */
  format: (v: number | null) => string;
  /** Full precision for the cell's title, e.g. exact thousands under an NT$bn figure. */
  exact?: ((v: number | null) => string) | undefined;
  /** The chart's color for this series, shown as a swatch beside the column head. */
  color?: string | undefined;
}

/**
 * A time series as a table: months down, one column per series.
 *
 * Chronological top to bottom, matching the chart's left-to-right, so switching
 * views does not reverse the reader's sense of direction.
 *
 * The column head carries the series swatch, which is the only place a series
 * color appears here - it is what lets a reader who switched from the chart find
 * the same line. The values themselves stay in text ink.
 */
export function SeriesTable({
  months,
  series,
  maxHeight = 320,
  unit,
  note,
}: {
  months: string[];
  series: TableSeries[];
  maxHeight?: number;
  /** Printed in the footer. Omit when each cell already carries its own unit. */
  unit?: "ppt" | "%" | undefined;
  note?: string | undefined;
}) {
  return (
    <div>
      <div style={{ overflow: "auto", maxHeight }}>
        <table
          className="tnum"
          style={{
            borderCollapse: "separate",
            borderSpacing: 0,
            width: "100%",
            fontSize: 11.5,
            background: "var(--chart-surface)",
          }}
        >
          <thead>
            <tr>
              <th scope="col" style={{ ...HEAD, left: 0, zIndex: 3, textAlign: "left" }}>
                Month
              </th>
              {series.map((s) => (
                <th key={s.key} scope="col" style={{ ...HEAD, textAlign: "right" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      justifyContent: "flex-end",
                    }}
                  >
                    {s.color && (
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: s.color,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {s.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => (
              <tr key={m}>
                <th
                  scope="row"
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                    background: "var(--chart-surface)",
                    textAlign: "left",
                    padding: "3px 8px",
                    fontSize: 11.5,
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                    borderRight: "1px solid var(--grid-line)",
                    borderBottom: "1px solid var(--grid-line)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {monthLabel(m)}
                </th>
                {series.map((s) => {
                  const v = s.values[i] ?? null;
                  const exact = s.exact && !isMissing(v) ? s.exact(v) : undefined;
                  return (
                    <td
                      key={s.key}
                      title={exact}
                      style={{
                        padding: "3px 8px",
                        textAlign: "right",
                        borderBottom: "1px solid var(--grid-line)",
                        color: isMissing(v) ? "var(--text-hint)" : "var(--text-primary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {isMissing(v) ? <Absent /> : s.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(unit || note) && <TableFoot {...(unit ? { unit } : {})} {...(note ? { note } : {})} />}
    </div>
  );
}

/**
 * The footer a table gets in place of the chart's legend or color key.
 *
 * It carries the one thing the color key was load-bearing for: the unit. "ppt"
 * and "%" are not interchangeable here - one is a growth rate, the other the
 * change in that rate - and a column of bare signed numbers does not say which.
 */
function TableFoot({
  unit,
  note,
  footnote,
}: {
  unit?: "ppt" | "%";
  note?: ReactNode;
  footnote?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        padding: "6px 12px",
        borderTop: "1px solid var(--border)",
        fontSize: 10,
        color: "var(--text-muted)",
      }}
    >
      {note && <span>{note}</span>}
      {footnote && <span style={{ color: "var(--text-hint)" }}>{footnote}</span>}
      {unit && (
        <span style={{ marginLeft: "auto", color: "var(--text-hint)" }}>
          {unit === "ppt" ? "percentage points" : "percent"}
        </span>
      )}
    </div>
  );
}
