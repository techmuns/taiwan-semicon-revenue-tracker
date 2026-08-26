/**
 * The twelve columns, in the exact order the brief specifies, matching
 * /api/export.csv column for column. Anyone reconciling the CSV against the screen
 * should not have to translate between two layouts.
 *
 * Sorting puts nulls last in both directions. A null is not a small number and not
 * a large one, so it cannot be given a position on the value axis; it goes to the
 * end, and the count of them is printed above the table.
 *
 * THE AVERAGE IS A ROW, NOT A THIRTEENTH COLUMN
 *
 * This table is long-format: one row per company-month. There is no across-the-row
 * axis to average - a row's Revenue and its MoM are different units - so the summary
 * belongs at the foot of each column, which is where a column's own mean lives. It
 * also keeps the twelve-column contract with the CSV export intact, which a
 * thirteenth column would have broken for anyone reconciling the two.
 *
 * The mean is shown because it is the summary that was asked for, but each footer
 * cell also carries the MEDIAN in its tooltip, and for the growth columns the median
 * is the number to trust. This is the case stats.ts warns about: one small company
 * going from NT$2m to NT$60m is a real +2900% that drags the mean of a 37-name column
 * somewhere no company actually is. The mean of a revenue column has the mirror
 * problem - TSMC is two orders of magnitude above the median name, so the mean sits
 * above almost every row in it.
 */

import { useMemo, useState } from "react";
import { NA, isMissing, monthLabel, pct, ppt, revenue, revenueExact } from "../format";
import { meanOf, median } from "../stats";
import type { AnalyticsRow } from "../types";

type Col = {
  key: keyof AnalyticsRow;
  label: string;
  align: "left" | "right";
  render: (r: AnalyticsRow) => string;
  title?: string;
  numeric: boolean;
  exact?: (r: AnalyticsRow) => string;
  /**
   * Whether a column mean is meaningful. Off for the identity columns, and off for
   * Tier - a mean tier of 1.27 describes the filter, not the supply chain.
   */
  summarize?: boolean;
  /** A caveat appended to this column's footer tooltip. */
  summarizeNote?: string;
};

const COLS: Col[] = [
  { key: "ticker", label: "Ticker", align: "left", numeric: false, render: (r) => r.ticker },
  {
    key: "company_name",
    label: "Company",
    align: "left",
    numeric: false,
    render: (r) => r.company_name,
  },
  { key: "bucket", label: "Stage", align: "left", numeric: false, render: (r) => r.bucket },
  {
    key: "tier",
    label: "Tier",
    align: "right",
    numeric: true,
    render: (r) => String(r.tier),
    title: "1 = cleanest AI read-through, 2 = mixed or diluted",
  },
  {
    key: "month",
    label: "Month",
    align: "left",
    numeric: false,
    render: (r) => monthLabel(r.month),
  },
  {
    key: "revenue_twd_thousands",
    summarize: true,
    label: "Revenue",
    align: "right",
    numeric: true,
    render: (r) => revenue(r.revenue_twd_thousands),
    exact: (r) => revenueExact(r.revenue_twd_thousands),
    title: "Monthly net revenue, as filed (TWD thousands)",
  },
  {
    key: "mom_pct",
    summarize: true,
    label: "MoM",
    align: "right",
    numeric: true,
    render: (r) => pct(r.mom_pct),
    title: "vs the prior month · seasonal, and Lunar New Year moves between Jan and Feb",
  },
  {
    key: "yoy_pct",
    summarize: true,
    label: "YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.yoy_pct),
    title: "vs the same month a year earlier",
  },
  {
    key: "prior_month_yoy_pct",
    summarize: true,
    label: "Prior YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.prior_month_yoy_pct),
    title: "Last month's YoY rate - the baseline acceleration is measured against",
  },
  {
    key: "yoy_acceleration_ppt",
    summarize: true,
    label: "Accel",
    align: "right",
    numeric: true,
    render: (r) => ppt(r.yoy_acceleration_ppt),
    title: "YoY minus prior-month YoY, in percentage points",
  },
  {
    key: "cumulative_ytd_revenue_twd_thousands",
    summarize: true,
    summarizeNote:
      "YTD ratchets up through the year and resets each January, so the mean of this column is " +
      "largely a statement about where the month window starts. Revenue is the comparable column.",
    label: "YTD revenue",
    align: "right",
    numeric: true,
    render: (r) => revenue(r.cumulative_ytd_revenue_twd_thousands),
    exact: (r) => revenueExact(r.cumulative_ytd_revenue_twd_thousands),
    title: "Year-to-date, as filed · resets each January",
  },
  {
    key: "cumulative_yoy_pct",
    summarize: true,
    label: "YTD YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.cumulative_yoy_pct),
    title: "Year-to-date vs the same span last year",
  },
];

export function DataTable({
  note,
  rows,
  onSelect,
  maxHeight = 560,
}: {
  /** Caveat that qualifies the Revenue column - see consolidatedNote. */
  note?: string | null;
  rows: AnalyticsRow[];
  onSelect: (ticker: string) => void;
  maxHeight?: number | string;
}) {
  const [sortKey, setSortKey] = useState<keyof AnalyticsRow>("month");
  const [desc, setDesc] = useState(true);

  const sorted = useMemo(() => {
    const col = COLS.find((c) => c.key === sortKey);
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls last, always - they have no position on the value axis.
      const an = av === null || av === undefined;
      const bn = bv === null || bv === undefined;
      if (an && bn) return a.ticker.localeCompare(b.ticker);
      if (an) return 1;
      if (bn) return -1;
      let cmp: number;
      if (col?.numeric) cmp = Number(av) - Number(bv);
      else cmp = String(av).localeCompare(String(bv));
      if (cmp === 0) {
        cmp = a.month.localeCompare(b.month) || a.ticker.localeCompare(b.ticker);
        return desc ? -cmp : cmp;
      }
      return desc ? -cmp : cmp;
    });
    return out;
  }, [rows, sortKey, desc]);

  const nullCount = useMemo(
    () => rows.filter((r) => isMissing(r.revenue_twd_thousands)).length,
    [rows],
  );

  /**
   * One mean and one median per summarizable column, over the rows currently in
   * view - so it answers for the filters on screen, not for the whole universe.
   * `n` travels with each so the footer can state the basis rather than implying
   * every row contributed.
   */
  const summary = useMemo(() => {
    const out = new Map<
      string,
      { mean: number | null; med: number | null; n: number; missing: number }
    >();
    for (const c of COLS) {
      if (!c.summarize) continue;
      const values = rows.map((r) => r[c.key] as number | null);
      const agg = meanOf(values);
      out.set(String(c.key), {
        mean: agg.value,
        med: median(values.filter((v): v is number => v !== null && !Number.isNaN(v))),
        n: agg.n,
        missing: agg.missing,
      });
    }
    return out;
  }, [rows]);

  const leadSpan = Math.max(1, COLS.findIndex((c) => c.summarize));

  return (
    <div>
      <div
        style={{
          padding: "6px 14px",
          fontSize: 11,
          color: "var(--text-hint)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 12,
        }}
      >
        <span>{sorted.length.toLocaleString("en-US")} rows</span>
        {nullCount > 0 && (
          <span title="Company-months with no filing. Shown as an em dash, never as zero.">
            {nullCount} with no revenue filed
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>click a row to open the company</span>
      </div>
      <div style={{ overflow: "auto", maxHeight }}>
        <table
          className="tnum"
          style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}
        >
          <thead>
            <tr>
              {COLS.map((c) => {
                const on = c.key === sortKey;
                return (
                  <th
                    key={String(c.key)}
                    scope="col"
                    title={c.title}
                    onClick={() => {
                      if (on) setDesc(!desc);
                      else {
                        setSortKey(c.key);
                        setDesc(c.numeric);
                      }
                    }}
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      background: "var(--card-bg)",
                      textAlign: c.align,
                      padding: "7px 10px",
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: on ? "var(--primary-text)" : "var(--ink-muted)",
                      borderBottom: "1px solid var(--border-solid)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.label}
                    <span aria-hidden="true" style={{ marginLeft: 3, opacity: on ? 1 : 0.25 }}>
                      {on ? (desc ? "▾" : "▴") : "▾"}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={`${r.ticker}-${r.month}`}
                onClick={() => onSelect(r.ticker)}
                style={{ cursor: "pointer" }}
              >
                {COLS.map((c) => {
                  const text = c.render(r);
                  return (
                    <td
                      key={String(c.key)}
                      title={c.exact ? c.exact(r) : undefined}
                      style={{
                        textAlign: c.align,
                        padding: "4px 10px",
                        borderBottom: "1px solid var(--border)",
                        color: text === NA ? "var(--text-hint)" : "var(--text-secondary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {/* Sticky to the bottom of the scroll box: the summary of a 300-row table
              is worthless if you have to scroll to the end of it to see it. */}
          <tfoot>
            <tr>
              <th
                scope="row"
                colSpan={leadSpan}
                title="Computed over the rows matching the current filters, not over the whole universe."
                style={{
                  position: "sticky",
                  bottom: 0,
                  zIndex: 2,
                  background: "var(--card-bg)",
                  textAlign: "left",
                  padding: "6px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  borderTop: "2px solid var(--border-solid)",
                  whiteSpace: "nowrap",
                }}
              >
                Average
                <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--text-hint)" }}>
                  {sorted.length.toLocaleString("en-US")} rows in view
                </span>
              </th>
              {COLS.slice(leadSpan).map((c) => {
                const s = c.summarize ? summary.get(String(c.key)) : undefined;
                // The footer reuses the column's own renderer, so the mean of a
                // revenue column prints as NT$bn and the mean of a ppt column
                // prints as ppt. One formatter per column, never two.
                const text =
                  s && s.mean !== null
                    ? c.render({ [c.key]: s.mean } as unknown as AnalyticsRow)
                    : NA;
                return (
                  <td
                    key={String(c.key)}
                    title={
                      s
                        ? s.n === 0
                          ? `No row in view has a ${c.label} value, so there is nothing to average.`
                          : `Mean of ${s.n} row${s.n === 1 ? "" : "s"}` +
                            (s.missing > 0
                              ? `; ${s.missing} with no value excluded from the divisor, never counted as zero`
                              : "") +
                            `. Median: ${
                              s.med === null
                                ? NA
                                : c.render({ [c.key]: s.med } as unknown as AnalyticsRow)
                            } — for the growth columns the median is the number to trust, since one small company's +2900% moves the mean and not the median.` +
                            (c.summarizeNote ? ` ${c.summarizeNote}` : "")
                        : undefined
                    }
                    style={{
                      position: "sticky",
                      bottom: 0,
                      zIndex: 1,
                      background: "var(--card-bg)",
                      textAlign: c.align,
                      padding: "6px 10px",
                      fontWeight: 600,
                      borderTop: "2px solid var(--border-solid)",
                      color: text === NA ? "var(--text-hint)" : "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      {/* Under the table rather than above it: this qualifies the Revenue
          column and the Average beneath it, both of which are read last. */}
      {note && (
        <div
          style={{
            padding: "6px 12px",
            borderTop: "1px solid var(--border)",
            fontSize: 10,
            color: "var(--text-muted)",
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
