/**
 * The twelve columns, in the exact order the brief specifies, matching
 * /api/export.csv column for column. Anyone reconciling the CSV against the screen
 * should not have to translate between two layouts.
 *
 * Sorting puts nulls last in both directions. A null is not a small number and not
 * a large one, so it cannot be given a position on the value axis; it goes to the
 * end, and the count of them is printed above the table.
 */

import { useMemo, useState } from "react";
import { NA, isMissing, monthLabel, pct, ppt, revenue, revenueExact } from "../format";
import type { AnalyticsRow } from "../types";

type Col = {
  key: keyof AnalyticsRow;
  label: string;
  align: "left" | "right";
  render: (r: AnalyticsRow) => string;
  title?: string;
  numeric: boolean;
  exact?: (r: AnalyticsRow) => string;
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
    label: "Revenue",
    align: "right",
    numeric: true,
    render: (r) => revenue(r.revenue_twd_thousands),
    exact: (r) => revenueExact(r.revenue_twd_thousands),
    title: "Monthly net revenue, as filed (TWD thousands)",
  },
  {
    key: "mom_pct",
    label: "MoM",
    align: "right",
    numeric: true,
    render: (r) => pct(r.mom_pct),
    title: "vs the prior month · seasonal, and Lunar New Year moves between Jan and Feb",
  },
  {
    key: "yoy_pct",
    label: "YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.yoy_pct),
    title: "vs the same month a year earlier",
  },
  {
    key: "prior_month_yoy_pct",
    label: "Prior YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.prior_month_yoy_pct),
    title: "Last month's YoY rate - the baseline acceleration is measured against",
  },
  {
    key: "yoy_acceleration_ppt",
    label: "Accel",
    align: "right",
    numeric: true,
    render: (r) => ppt(r.yoy_acceleration_ppt),
    title: "YoY minus prior-month YoY, in percentage points",
  },
  {
    key: "cumulative_ytd_revenue_twd_thousands",
    label: "YTD revenue",
    align: "right",
    numeric: true,
    render: (r) => revenue(r.cumulative_ytd_revenue_twd_thousands),
    exact: (r) => revenueExact(r.cumulative_ytd_revenue_twd_thousands),
    title: "Year-to-date, as filed · resets each January",
  },
  {
    key: "cumulative_yoy_pct",
    label: "YTD YoY",
    align: "right",
    numeric: true,
    render: (r) => pct(r.cumulative_yoy_pct),
    title: "Year-to-date vs the same span last year",
  },
];

export function DataTable({
  rows,
  onSelect,
  maxHeight = 560,
}: {
  rows: AnalyticsRow[];
  onSelect: (ticker: string) => void;
  maxHeight?: number;
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
        </table>
      </div>
    </div>
  );
}
