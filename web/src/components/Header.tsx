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
 * The access posture is no longer shown anywhere in the UI. "we left it public
 * and forgot" is a real state, but it is one only the deploying operator can
 * change, and they read /api/meta and the runbook rather than the header of a
 * revenue dashboard. What remains here is the Lock action, shown only in
 * shared-key mode, because that IS a reader action: it is the only way to end a
 * session on a shared machine once the cookie is set for thirty days.
 */

import { Segmented, TickerPill } from "./controls";
import { freshnessLabel } from "../format";
import { useTheme } from "../theme";
import type { Meta } from "../types";

/**
 * The theme switch.
 *
 * A bulb, lit when the dark theme is on. Icon-only, but never color-only: it
 * carries an aria-label that names the DESTINATION rather than the current state
 * ("Switch to dark theme"), which is what a screen-reader user needs to decide
 * whether to press it, plus aria-pressed for the state itself.
 *
 * Sized and bordered exactly like the Lock button beside it - 26px, hairline
 * border, 6px radius - so it joins the existing control row rather than
 * announcing itself as a new kind of thing.
 */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      style={{
        height: "var(--control-h)",
        width: "var(--control-h)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        color: dark ? "var(--status-warning)" : "var(--text-muted)",
        background: "var(--card-bg)",
        border: "1px solid var(--border-solid)",
        borderRadius: "var(--radius-control)",
        cursor: "pointer",
        transition: "var(--ease)",
        flexShrink: 0,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill={dark ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Glass, then the base band and contact - a bulb reads as a bulb only
            with the screw base, and the filled glass is the "on" signal. */}
        <path d="M9 18h6" />
        <path d="M10 21h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
      </svg>
    </button>
  );
}

export const TABS = [
  { value: "overview", label: "Overview", title: "Where the chain is inflecting" },
  { value: "insights", label: "Insights", title: "What stands out this month, and who is inside it" },
  { value: "acceleration", label: "Acceleration", title: "Company x month, YoY acceleration" },
  { value: "company", label: "Company", title: "One name, full series and raw filings" },
  { value: "buckets", label: "Buckets", title: "Supply-chain stages, rebased" },
  { value: "data", label: "Data", title: "The twelve columns, sortable, exportable" },
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
  // /api/meta orders freshness by month_idx ASCENDING, so [0] is the OLDEST
  // month - currently the excluded Dec-2025 shoulder - while this label pairs it
  // with `latest_month`. The chip therefore aged with the backfill rather than
  // with the cron, and would have kept reporting a months-old timestamp next to
  // a freshly written month. Take the entry for the month actually named, and
  // fall back to the newest row rather than the oldest.
  const freshness = meta?.freshness ?? [];
  const lastSeen =
    (meta?.latest_month
      ? freshness.find((f) => f.month === meta.latest_month)?.last_seen_utc
      : undefined) ??
    freshness[freshness.length - 1]?.last_seen_utc ??
    null;

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
        {/* The "open access" chip used to live here. Removed at the owner's
            request: it is operator information, not reader information, and it
            sat in the busiest 200px of the header competing with the freshness
            stamp and the export button on every screen.
            The Method and units card carried it for a while afterwards and has
            since dropped it too, for the same reason. The posture is not lost:
            /api/meta still reports it and the runbook documents it, which is
            where the person who can actually change it is looking. */}
        {meta?.latest_month && (
          <span
            title={`data last written ${lastSeen ?? "unknown"}`}
            // The first thing to give up width on a narrow viewport: it is the
            // only item here that is prose rather than a control.
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
          >
            latest {meta.latest_month} · {freshnessLabel(lastSeen, now)}
          </span>
        )}
        <ThemeToggle />
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
