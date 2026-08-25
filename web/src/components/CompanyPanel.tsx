/**
 * One company, end to end: identity, the derived series, and the raw filings the
 * series was derived from.
 *
 * The raw table is the point of this tab. Every number on every other screen is a
 * computation; here is the as-filed row it came from, with the Chinese name the
 * company actually reported, the source feed it arrived on, and the reported
 * percentages we deliberately did not use. If a figure looks wrong anywhere else in
 * the dashboard, this is where it gets settled.
 *
 * Revenue and growth are two charts, not one chart with two y-axes. A dual axis
 * lets the author place the crossing point wherever the story needs it, which is
 * why it is the single most common way a chart lies.
 *
 * All three charts here follow the dashboard's shared graph/table mode; the control
 * that sets it is in this tab's own selector row rather than repeated in three card
 * headers, since one setting deserves one control.
 */

import type { ReactNode } from "react";
import { WidgetCard } from "./WidgetCard";
import { MonthBars, MonthLines, SERIES_COLORS } from "./charts";
import { SeriesTable } from "./tables";
import { EmptyState } from "./states";
import { StatusDot } from "./controls";
import type { ViewMode } from "./controls";
import { NA, monthLabel, pct, revenue, revenueExact, utcStamp } from "../format";
import type { CompanyDetail } from "../types";

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : NA;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--text-secondary)" }}>{children}</div>
    </div>
  );
}

export function CompanyPanel({ detail, viz }: { detail: CompanyDetail; viz: ViewMode }) {
  const { company, series, raw_rows, restatements } = detail;
  const months = series.map((s) => s.month);
  const hasAny = series.some((s) => s.revenue_twd_thousands !== null);

  // Declared once so the chart and the table cannot disagree about what they show.
  const growth = [
    { key: "yoy", label: "YoY", color: SERIES_COLORS[0], values: series.map((s) => s.yoy_pct) },
    { key: "mom", label: "MoM", color: SERIES_COLORS[1], values: series.map((s) => s.mom_pct) },
    {
      key: "cum",
      label: "YTD YoY",
      color: SERIES_COLORS[2],
      values: series.map((s) => s.cumulative_yoy_pct),
    },
  ];

  return (
    <>
      <WidgetCard
        title={`${company.display_name} · ${company.ticker}`}
        {...(company.name_zh ? { subtitle: company.name_zh } : {})}
        wide
      >
        <div
          style={{
            padding: "12px 16px",
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          }}
        >
          <Field label="Stage">{company.bucket}</Field>
          <Field label="Tier">
            {company.tier === 1 ? "1 · clean read" : `${company.tier} · mixed`}
          </Field>
          <Field label="Market">{company.market_hint ?? NA}</Field>
          <Field label="Status">
            {company.status === "active" ? (
              <StatusDot level="good">active filer</StatusDot>
            ) : (
              <StatusDot level="warning">
                {company.status}
                {company.successor ? ` → ${company.successor}` : ""}
              </StatusDot>
            )}
          </Field>
          <Field label="Months with data">
            {series.filter((s) => s.has_data).length} of {series.length}
          </Field>
        </div>
        {(company.thesis || company.notes) && (
          <div
            style={{
              padding: "0 16px 14px",
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            {company.thesis && <div>{company.thesis}</div>}
            {company.notes && (
              <div style={{ marginTop: 4, color: "var(--text-hint)" }}>{company.notes}</div>
            )}
          </div>
        )}
      </WidgetCard>

      <WidgetCard
        title="Monthly revenue"
        subtitle="As filed, NT$ · a hatched stub means no filing"
      >
        {hasAny ? (
          viz === "table" ? (
            <SeriesTable
              months={months}
              series={[
                {
                  key: "rev",
                  label: "Revenue",
                  values: series.map((s) => s.revenue_twd_thousands),
                  format: revenue,
                  exact: revenueExact,
                  color: "var(--seq-400)",
                },
              ]}
              note="Hover a figure for the exact thousands as filed"
            />
          ) : (
            <MonthBars
              data={series.map((s) => ({ month: s.month, value: s.revenue_twd_thousands }))}
              format={revenue}
            />
          )
        ) : (
          <EmptyState
            message="No revenue on file"
            hint={
              company.status === "merged"
                ? `${company.display_name} stopped being a public issuer${
                    company.successor ? ` and reports inside ${company.successor}` : ""
                  }, so there is no filing obligation. This is an absence of duty, not missing data.`
                : "No month in the window has a filing for this company."
            }
          />
        )}
      </WidgetCard>

      <WidgetCard
        title="Growth rates"
        subtitle="One axis, all in percent · a gap means no comparable"
      >
        {hasAny ? (
          viz === "table" ? (
            <SeriesTable
              months={months}
              series={growth.map((g) => ({ ...g, format: (v) => pct(v, 1) }))}
              unit="%"
            />
          ) : (
            <MonthLines months={months} series={growth} />
          )
        ) : (
          <EmptyState message="Nothing to chart" hint="Growth rates need at least one filing." />
        )}
      </WidgetCard>

      <WidgetCard
        title="Year to date"
        subtitle="Cumulative revenue as filed · resets each January"
      >
        {hasAny ? (
          viz === "table" ? (
            <SeriesTable
              months={months}
              series={[
                {
                  key: "ytd",
                  label: "YTD revenue",
                  values: series.map((s) => s.cumulative_ytd_revenue_twd_thousands),
                  format: revenue,
                  exact: revenueExact,
                  color: "var(--seq-550)",
                  averageNote:
                    "Read this one with care: YTD ratchets up through the year and resets each " +
                    "January, so its mean is mostly a statement about where the window starts, " +
                    "not about the company. The monthly revenue average is the comparable figure.",
                },
              ]}
              note="Resets to the January figure each year"
            />
          ) : (
            <MonthBars
              data={series.map((s) => ({
                month: s.month,
                value: s.cumulative_ytd_revenue_twd_thousands,
              }))}
              format={revenue}
              color="var(--seq-550)"
            />
          )
        ) : (
          <EmptyState message="Nothing to chart" hint="Cumulative revenue needs a filing." />
        )}
      </WidgetCard>

      <WidgetCard
        title="As filed"
        subtitle="The raw rows every number above is derived from"
        wide
        staticCard
        bodyStyle={{ overflow: "auto" }}
      >
        {raw_rows.length === 0 ? (
          <EmptyState
            message="No raw rows"
            hint="Nothing has been persisted for this company, so there is nothing to audit."
          />
        ) : (
          <table
            className="tnum"
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}
          >
            <thead>
              <tr>
                {[
                  "Month",
                  "Source",
                  "Reported name",
                  "Mkt",
                  "Revenue",
                  "Prior month",
                  "Year ago",
                  "YTD",
                  "YTD year ago",
                  "Their YoY",
                  "Their YTD YoY",
                  "Note",
                ].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      textAlign: h === "Month" || h === "Source" ? "left" : "right",
                      padding: "6px 8px",
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--ink-muted)",
                      borderBottom: "1px solid var(--border-solid)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {raw_rows.map((r) => (
                <tr key={`${r.source_id}-${r.month}`}>
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
                    {monthLabel(r.month)}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {r.source_id}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                  >
                    {str(r["company_name"])}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                  >
                    {str(r["market"])}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                    title={revenueExact(r.revenue_month)}
                  >
                    {revenue(r.revenue_month)}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                      color: "var(--text-hint)",
                    }}
                    title="Blank on the per-company MOPS endpoint - the field does not exist there"
                  >
                    {revenue(num(r["revenue_prev_month"]))}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                  >
                    {revenue(num(r["revenue_yoy_month"]))}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                  >
                    {revenue(num(r["cum_revenue"]))}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                    }}
                  >
                    {revenue(num(r["cum_revenue_prior"]))}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                      color: "var(--text-hint)",
                    }}
                    title="The percentage the filer reported. We recompute from levels instead; this is the cross-check."
                  >
                    {pct(num(r["src_yoy_pct"]), 2)}
                  </td>
                  <td
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                      color: "var(--text-hint)",
                    }}
                  >
                    {pct(num(r["src_cum_yoy_pct"]), 2)}
                  </td>
                  {/*
                    ONE LINE, ELLIPSISED - the full text is the tooltip.

                    This wrapped freely at maxWidth 220, and a filer's 備註 can
                    run to a paragraph. One long note made its row four times the
                    height of every other, so the table read as a set of
                    mismatched blocks rather than rows. An as-filed audit table's
                    job is to line figures up; the prose is the one thing in it
                    that does not need to be read at a glance.
                  */}
                  <td
                    title={typeof r["note"] === "string" ? r["note"] : undefined}
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "left",
                      maxWidth: 240,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "var(--text-muted)",
                    }}
                  >
                    {typeof r["note"] === "string" ? r["note"] : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </WidgetCard>

      <WidgetCard
        title="Restatements"
        subtitle="Later-revised filings · superseded rows are kept, never overwritten"
        staticCard
      >
        {restatements.length === 0 ? (
          <EmptyState
            icon="✓"
            message="No restatements"
            hint="Every row for this company still matches what was first filed."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <tbody>
              {restatements.map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>
                    {monthLabel(r.month)}
                  </td>
                  <td
                    style={{
                      padding: "5px 10px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    superseded {utcStamp(r.superseded_at_utc)}
                  </td>
                  <td
                    style={{
                      padding: "5px 10px",
                      borderBottom: "1px solid var(--border)",
                      textAlign: "right",
                      color: "var(--text-muted)",
                    }}
                  >
                    {typeof r["change_reason"] === "string" ? r["change_reason"] : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </WidgetCard>
    </>
  );
}
