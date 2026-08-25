/**
 * The two footnote cards that close the Overview tab.
 *
 * There used to be a third - a "Sources" card listing each feed with its row
 * count and id. It was operator plumbing, not reader information: in steady
 * state it holds exactly one row (`mops_company`), so it drew a full card to say
 * one thing, and stretched to the height of its neighbours with a quarter of a
 * screen of nothing under it. The one fact in it a reader actually needs - when
 * the feed last wrote, which is what separates "nobody filed" from "the refresh
 * has not run" - now rides in the Freshness subtitle, where it is read in the
 * same glance as the months it qualifies.
 *
 * Both cards span the full grid. A footnote that spans one column of four leaves
 * three columns of page showing beside it, which is the thing that made the
 * bottom of this tab look unfinished.
 */

import type { CSSProperties } from "react";

import { WidgetCard } from "./WidgetCard";
import { StatusDot } from "./controls";
import { freshnessLabel, monthLabel, utcStamp } from "../format";
import type { Meta } from "../types";

/** Human names for the feeds. The raw ids stay out of the reader's way now. */
const SOURCE_LABELS: Record<string, string> = {
  mops_company: "MOPS per-company filings",
  twse_openapi_p: "the TWSE OpenAPI (public issuers)",
  twse_openapi_l: "the TWSE OpenAPI (listed)",
  tpex_openapi_o: "the TPEx OpenAPI (OTC)",
};

/**
 * One line of provenance: how many rows, from where, and how long ago they were
 * written. "Written" is the write time of the row, not the month it describes -
 * a fresh write of a stale month is a different failure from no write at all.
 */
function provenance(meta: Meta, now: number): string {
  const feeds = meta.sources;
  if (feeds.length === 0) return "no feed has written yet";

  const rows = feeds.reduce((n, f) => n + f.rows_n, 0).toLocaleString("en-US");
  const stamps = feeds.map((f) => f.last_seen_utc).filter((s): s is string => !!s);
  // ISO-8601 in UTC sorts lexicographically, so max() needs no parsing.
  const newest = stamps.length ? stamps.reduce((a, b) => (a >= b ? a : b)) : null;
  const written = newest ? `written ${freshnessLabel(newest, now)}` : "never written";

  const first = feeds[0];
  return feeds.length === 1 && first
    ? `${rows} rows from ${SOURCE_LABELS[first.source_id] ?? first.source_id} · ${written}`
    : `${rows} rows from ${feeds.length} feeds · newest ${written}`;
}

/**
 * Why a month is in this list, for the two rows where that is not obvious. A
 * shoulder month appears above a subtitle promising the tracked window and
 * reads as a bug unless it says why it is there; the rest of the column is
 * deliberately blank rather than filled with "in window" on every row.
 */
function standing(month: string, meta: Meta): string {
  if (meta.shoulder_months.includes(month))
    return "shoulder month — outside the default range, carried so the first tracked month has a prior month to compare against";
  if (month === meta.latest_month) return "latest month on record";
  return "";
}

const TH: CSSProperties = {
  padding: "6px 14px",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--ink-muted)",
  borderBottom: "1px solid var(--border-solid)",
};

const TD: CSSProperties = {
  padding: "6px 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
};

export function Provenance({ meta, now }: { meta: Meta; now: number }) {
  return (
    <>
      <WidgetCard
        full
        title="Freshness"
        subtitle={`Companies with a filing, by month, newest first · ${provenance(meta, now)}`}
        staticCard
        bodyStyle={{ overflow: "auto" }}
      >
        {/* The server returns these ascending by month_idx, so rendering them
            as-is put the excluded Dec-2025 shoulder month at the top under a
            subtitle promising "newest first". Reverse a copy - never in place,
            since `meta` is shared with the rest of the dashboard. */}
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...TH, textAlign: "left", width: 130 }}>
                Month
              </th>
              <th scope="col" style={{ ...TH, textAlign: "left" }}>
                Standing
              </th>
              <th scope="col" style={{ ...TH, textAlign: "right", width: 160 }}>
                Companies filed
              </th>
              <th scope="col" style={{ ...TH, textAlign: "right", width: 200 }}>
                Last written (UTC)
              </th>
            </tr>
          </thead>
          <tbody>
            {[...meta.freshness].reverse().map((f) => (
              <tr key={f.month}>
                <th
                  scope="row"
                  style={{
                    ...TD,
                    textAlign: "left",
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                  }}
                >
                  {monthLabel(f.month)}
                </th>
                <td style={{ ...TD, textAlign: "left", color: "var(--text-hint)" }}>
                  {standing(f.month, meta)}
                </td>
                <td
                  className="tnum"
                  style={{ ...TD, textAlign: "right", color: "var(--text-muted)" }}
                >
                  {f.tickers_with_data} filed
                </td>
                <td
                  className="tnum"
                  style={{ ...TD, textAlign: "right", color: "var(--text-hint)" }}
                >
                  {utcStamp(f.last_seen_utc)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetCard>

      <WidgetCard
        full
        collapsible
        title="Method and units"
        subtitle="What the numbers mean before you quote them"
        staticCard
      >
        {/* Four independent notes, so they set as columns rather than as four
            full-bleed lines - prose at 1800px is not prose. auto-fit collapses
            to fewer columns on a narrow window without a breakpoint. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "10px 24px",
            padding: "12px 14px",
            fontSize: 11,
            lineHeight: 1.65,
            color: "var(--text-muted)",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-secondary)" }}>Revenue</strong> — {meta.units.revenue}.
            Displayed as NT$; hover any figure for the exact filed value.
          </div>
          <div>
            <strong style={{ color: "var(--text-secondary)" }}>Percentages</strong> —{" "}
            {meta.units.percentages}. Recomputed from the integer levels rather than copied from
            the filer's own percentage fields, so acceleration is exactly the difference of two
            rates and not a difference of two roundings.
          </div>
          <div>
            <strong style={{ color: "var(--text-secondary)" }}>Acceleration</strong> —{" "}
            {meta.units.acceleration}.
          </div>
          <div>
            <strong style={{ color: "var(--text-secondary)" }}>Missing values</strong> — a null
            denominator yields <strong>no value</strong>, never zero. An em dash means the figure
            does not exist; it never means zero.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            padding: "8px 14px 12px",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <StatusDot level={meta.access.public ? "warning" : "good"}>
            access: {meta.access.mode}
          </StatusDot>
          <span style={{ color: "var(--text-hint)" }}>{meta.access.note}</span>
        </div>
      </WidgetCard>
    </>
  );
}
