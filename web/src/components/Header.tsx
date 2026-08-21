/**
 * Zone 1. Exactly 48px, sticky, flat white, one bottom border.
 *
 * It carries the title, the tab strip, the selected company pill, freshness, and
 * export. Nothing else - no charts, no descriptions.
 *
 * The tabs are underlined rather than a pill group. Navigation and controls should
 * not look alike: a pill strip in the header reads as another metric picker, of
 * which there are two inside the widgets below it. An underline says "you are
 * here", and it is the only thing in the header that carries the accent hue.
 *
 * The access posture is shown here when the API reports the dashboard is open,
 * because "we left it public and forgot" is a state that has to be visible
 * somewhere the reader cannot miss. In shared-key mode the posture is safe, so it
 * gets no chip - just the Lock action, which is the only way to end a session on a
 * shared machine once the cookie is set for thirty days.
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
  onLock,
  now,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  meta: Meta | null;
  ticker: string | null;
  onClearTicker: () => void;
  exportHref: string;
  onLock: () => void;
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
        padding: "0 22px",
        height: "var(--header-h)",
        background: "var(--header-bg)",
        borderBottom: "1px solid var(--border-solid)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <h1
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.01em",
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
        variant="underline"
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
              padding: "1px 7px",
              borderRadius: 4,
              border: "1px solid var(--warn-border)",
              background: "var(--warn-bg)",
              color: "var(--warn-text)",
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
            height: "var(--control-h)",
            display: "inline-flex",
            alignItems: "center",
            padding: "0 9px",
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--primary-text)",
            background: "var(--primary-light)",
            border: "1px solid var(--primary-border)",
            borderRadius: "var(--radius-control)",
            textDecoration: "none",
          }}
        >
          Export CSV
        </a>
        {meta?.access?.mode === "secret" && (
          <button
            type="button"
            onClick={onLock}
            title="Clear this browser's session cookie and ask for the key again"
            style={{
              height: "var(--control-h)",
              padding: "0 9px",
              fontSize: 11.5,
              fontWeight: 600,
              color: "var(--text-muted)",
              background: "var(--card-bg)",
              border: "1px solid var(--border-solid)",
              borderRadius: "var(--radius-control)",
              cursor: "pointer",
              transition: "var(--ease)",
            }}
          >
            Lock
          </button>
        )}
      </div>
    </header>
  );
}
