/**
 * Zone 1. Exactly 48px, sticky, blurred white, one bottom border.
 *
 * It carries the title, the tab strip, the selected company pill, freshness, and
 * export. Nothing else - no charts, no descriptions.
 *
 * The access posture is shown here when the API reports the dashboard is open,
 * because "we left it public and forgot" is a state that has to be visible
 * somewhere the reader cannot miss.
 */

import { Segmented, TickerPill } from "./controls";
import { freshnessLabel } from "../format";
import type { Meta } from "../types";

export const TABS = [
  { value: "overview", label: "Overview", title: "Where the chain is inflecting" },
  { value: "acceleration", label: "Acceleration", title: "Company x month, YoY acceleration" },
  { value: "company", label: "Company", title: "One name, full series and raw filings" },
  { value: "buckets", label: "Buckets", title: "Supply-chain stages, rebased" },
  { value: "data", label: "Data", title: "The twelve columns, sortable, exportable" },
  { value: "quality", label: "Quality", title: "Coverage, gaps, findings, provenance" },
] as const;

export type Tab = (typeof TABS)[number]["value"];

export function Header({
  tab,
  onTab,
  meta,
  ticker,
  onClearTicker,
  exportHref,
  now,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  meta: Meta | null;
  ticker: string | null;
  onClearTicker: () => void;
  exportHref: string;
  now: number;
}) {
  const company = ticker
    ? meta?.universe.find((u) => u.ticker === ticker)?.display_name
    : undefined;
  const lastSeen = meta?.freshness?.[0]?.last_seen_utc ?? null;

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "0 24px",
        height: 48,
        background: "var(--header-bg)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--border-solid)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <h1
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          Taiwan Semi Revenue
        </h1>
        {ticker && (
          <TickerPill
            ticker={ticker}
            {...(company ? { company } : {})}
            onClear={onClearTicker}
          />
        )}
      </div>

      <Segmented
        options={TABS}
        value={tab}
        onChange={(v) => onTab(v as Tab)}
        ariaLabel="Dashboard view"
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 11,
          color: "var(--text-hint)",
          whiteSpace: "nowrap",
        }}
      >
        {meta?.access?.public && (
          <span
            title={meta.access.note}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 8px",
              borderRadius: 99,
              border: "1px solid #fde68a",
              background: "#fffbeb",
              color: "#92400e",
              fontWeight: 600,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--status-warning)",
              }}
            />
            open access
          </span>
        )}
        {meta?.latest_month && (
          <span title={`data last written ${lastSeen ?? "unknown"}`}>
            latest {meta.latest_month} · {freshnessLabel(lastSeen, now)}
          </span>
        )}
        <a
          href={exportHref}
          style={{
            height: 26,
            display: "inline-flex",
            alignItems: "center",
            padding: "0 10px",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--primary-text)",
            background: "var(--primary-light)",
            border: "1px solid var(--primary-border)",
            borderRadius: 8,
            textDecoration: "none",
          }}
        >
          Export CSV
        </a>
      </div>
    </header>
  );
}
