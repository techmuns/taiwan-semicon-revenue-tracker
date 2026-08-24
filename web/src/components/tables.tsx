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
import { meanOf } from "../stats";
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

/**
 * The summary column and row are set off by a 2px rule, not by a fill.
 *
 * A summary sitting flush against the last month reads as a ninth month, which is
 * the one thing it must not read as. A rule says "different kind of number" using
 * the table's own hairline system, and costs no ink that the values are competing
 * with. The figure itself is one weight heavier - the same signal the sorted
 * column already uses in the Data table.
 */
const SUMMARY_EDGE = "2px solid var(--border-solid)";

/** The mean's basis, spelled out. `n` is the honest part: a mean of 3 of 8 months is not a mean of 8. */
function meanTitle(n: number, missing: number, what: string): string {
  if (n === 0) return `No month in view has ${what}, so there is nothing to average.`;
  return (
    `Mean of the ${n} month${n === 1 ? "" : "s"} in view that have ${what}` +
    (missing > 0
      ? `. ${missing} absent month${missing === 1 ? " is" : "s are"} excluded from both the sum and the divisor - never counted as zero.`
      : ".")
  );
}

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
  average = true,
}: {
  months: string[];
  rows: HeatRow[];
  metric: HeatmapMetric;
  rowHeader?: string;
  onRowClick?: (key: string) => void;
  maxHeight?: number;
  /** The trailing per-row mean across the months in view. */
  average?: boolean;
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
                // Pinned for the same reason as the heatmap's - see Heatmap.tsx.
                style={{
                  ...HEAD,
                  left: 0,
                  zIndex: 3,
                  textAlign: "left",
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
              {average && (
                <th
                  scope="col"
                  title={`Mean ${spec.label.toLowerCase()} across the months in view, per row. Absent months are excluded from the divisor, never counted as zero.`}
                  style={{
                    ...HEAD,
                    right: 0,
                    zIndex: 3,
                    textAlign: "right",
                    minWidth: 58,
                    borderLeft: SUMMARY_EDGE,
                    color: "var(--text-secondary)",
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
                {avg && (
                  <td
                    title={meanTitle(avg.n, avg.missing, `a ${spec.label.toLowerCase()} value`)}
                    style={{
                      padding: "3px 8px",
                      height: 22,
                      textAlign: "right",
                      fontWeight: 600,
                      borderLeft: SUMMARY_EDGE,
                      borderBottom: "1px solid var(--grid-line)",
                      background: "var(--chart-surface)",
                      position: "sticky",
                      right: 0,
                      zIndex: 1,
                      color: isMissing(avg.value) ? "var(--text-hint)" : "var(--text-primary)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {isMissing(avg.value) ? (
                      <Absent />
                    ) : (
                      <>
                        {(avg.value as number) > 0 ? "+" : ""}
                        {(avg.value as number).toFixed(1)}
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
      <TableFoot
        unit={spec.unit}
        note={`${spec.label}, signed`}
        {...(anyFlag ? { footnote: "† bucket membership changed vs the prior month" } : {})}
        {...(average
          ? { summaryNote: "Avg is the mean over the months in view that have a value" }
          : {})}
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
  /**
   * A caveat appended to the Average cell's tooltip.
   *
   * Exists for the cumulative series. The mean of a column that ratchets up and
   * then resets each January is arithmetically correct and analytically close to
   * meaningless: it depends almost entirely on where the window happens to start.
   * The number is still shown - hiding a figure the reader asked for teaches them
   * the table is editorialising - but it does not get to be quoted uncaveated.
   */
  averageNote?: string | undefined;
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
  average = true,
}: {
  months: string[];
  series: TableSeries[];
  maxHeight?: number;
  /** Printed in the footer. Omit when each cell already carries its own unit. */
  unit?: "ppt" | "%" | undefined;
  note?: string | undefined;
  /**
   * The trailing per-series mean. This table is the transpose of the matrix - months
   * run DOWN, series run ACROSS - so the summary is a row rather than a column. It is
   * the same operation over the same axis: the mean of one series across time.
   */
  average?: boolean;
}) {
  const means = average ? series.map((s) => meanOf(s.values.slice(0, months.length))) : null;

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
          {means && (
            // In the <tfoot> rather than as a last <tbody> row, so a screen reader
            // and a copy-paste both carry "this one is not a month".
            <tfoot>
              <tr>
                <th
                  scope="row"
                  style={{
                    position: "sticky",
                    left: 0,
                    bottom: 0,
                    zIndex: 2,
                    background: "var(--chart-surface)",
                    textAlign: "left",
                    padding: "4px 8px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    borderRight: "1px solid var(--grid-line)",
                    borderTop: SUMMARY_EDGE,
                    whiteSpace: "nowrap",
                  }}
                >
                  Average
                </th>
                {series.map((s, i) => {
                  const agg = means[i];
                  const v = agg ? agg.value : null;
                  return (
                    <td
                      key={s.key}
                      title={
                        agg
                          ? meanTitle(agg.n, agg.missing, `a ${s.label.toLowerCase()} value`) +
                            (isMissing(v) ? "" : ` Unrounded: ${v}.`) +
                            (s.averageNote ? ` ${s.averageNote}` : "")
                          : undefined
                      }
                      style={{
                        position: "sticky",
                        bottom: 0,
                        zIndex: 1,
                        background: "var(--chart-surface)",
                        padding: "4px 8px",
                        textAlign: "right",
                        fontWeight: 600,
                        borderTop: SUMMARY_EDGE,
                        color: isMissing(v) ? "var(--text-hint)" : "var(--text-primary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {isMissing(v) ? <Absent /> : s.format(v)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {(unit || note || average) && (
        <TableFoot
          {...(unit ? { unit } : {})}
          {...(note ? { note } : {})}
          {...(average
            ? { summaryNote: "Average is the mean over the months with a value" }
            : {})}
        />
      )}
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
  summaryNote,
}: {
  unit?: "ppt" | "%";
  note?: ReactNode;
  footnote?: string;
  /** What the Avg column / Average row was computed over. */
  summaryNote?: string;
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
      {summaryNote && <span style={{ color: "var(--text-hint)" }}>{summaryNote}</span>}
      {footnote && <span style={{ color: "var(--text-hint)" }}>{footnote}</span>}
      {unit && (
        <span style={{ marginLeft: "auto", color: "var(--text-hint)" }}>
          {unit === "ppt" ? "percentage points" : "percent"}
        </span>
      )}
    </div>
  );
}
