/**
 * Provenance, last in reading order on every tab that shows one.
 *
 * It names each feed, how many rows came from it, and when it last wrote. That is
 * the difference between "this month is empty because nobody filed" and "this month
 * is empty because the refresh has not run since August" - two states that look
 * identical on a chart and could not be more different in meaning.
 */

import { WidgetCard } from "./WidgetCard";
import { StatusDot } from "./controls";
import { freshnessLabel, monthLabel, utcStamp } from "../format";
import type { Meta } from "../types";

/** Human names for the feeds. The raw ids stay visible - they are what D1 stores. */
const SOURCE_LABELS: Record<string, string> = {
  mops_company: "MOPS per-company filing (HTML)",
  twse_openapi_p: "TWSE OpenAPI · public issuers (_P)",
  twse_openapi_l: "TWSE OpenAPI · listed (_L)",
  tpex_openapi_o: "TPEx OpenAPI · OTC (_O)",
};

export function Sources({ meta, now }: { meta: Meta; now: number }) {
  return (
    <>
      <WidgetCard
        title="Sources"
        subtitle="Which feed each row came from · precedence is config"
        staticCard
      >
        <div style={{ padding: "4px 0" }}>
          {meta.sources.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-hint)" }}>
              No rows have a source recorded yet.
            </div>
          ) : (
            meta.sources.map((s) => (
              <div
                key={s.source_id}
                style={{
                  padding: "7px 14px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                >
                  <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                    {SOURCE_LABELS[s.source_id] ?? s.source_id}
                  </span>
                  <span className="tnum" style={{ color: "var(--text-secondary)" }}>
                    {s.rows_n.toLocaleString("en-US")} rows
                  </span>
                </div>
                <div style={{ color: "var(--text-hint)", marginTop: 2 }}>
                  <code>{s.source_id}</code>
                  {s.first_month && s.last_month
                    ? ` · ${monthLabel(s.first_month)} → ${monthLabel(s.last_month)}`
                    : ""}
                  {s.last_seen_utc ? ` · written ${freshnessLabel(s.last_seen_utc, now)}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </WidgetCard>

      <WidgetCard
        title="Freshness"
        subtitle="Companies with a filing, by month, newest first"
        staticCard
      >
        {/* The server returns these ascending by month_idx, so rendering them
            as-is put the excluded Dec-2025 shoulder month at the top under a
            subtitle promising "newest first". Reverse a copy - never in place,
            since `meta` is shared with the rest of the dashboard. */}
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          {[...meta.freshness].reverse().map((f) => (
            <div
              key={f.month}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "6px 14px",
                borderBottom: "1px solid var(--border)",
                fontSize: 11,
              }}
            >
              <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
                {monthLabel(f.month)}
              </span>
              <span className="tnum" style={{ color: "var(--text-muted)" }}>
                {f.tickers_with_data} filed
              </span>
              <span style={{ color: "var(--text-hint)", minWidth: 116, textAlign: "right" }}>
                {utcStamp(f.last_seen_utc)}
              </span>
            </div>
          ))}
        </div>
      </WidgetCard>

      <WidgetCard
        collapsible
        title="Method and units"
        subtitle="What the numbers mean before you quote them"
        staticCard
      >
        <div
          style={{
            padding: "10px 14px",
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
          <div style={{ marginTop: 6 }}>
            A null denominator yields <strong>no value</strong>, never zero. An em dash means the
            figure does not exist; it never means zero.
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <StatusDot level={meta.access.public ? "warning" : "good"}>
              access: {meta.access.mode}
            </StatusDot>
            <span style={{ color: "var(--text-hint)" }}>{meta.access.note}</span>
          </div>
        </div>
      </WidgetCard>
    </>
  );
}
