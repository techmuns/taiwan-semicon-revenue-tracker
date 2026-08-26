/**
 * What replaced the Quality tab.
 *
 * That tab put every data-integrity signal behind a click, which meant the one
 * reader who most needed it - the one about to quote a number - was the reader
 * least likely to go looking. This strip sits above the content on EVERY tab
 * instead, and renders nothing at all when there is nothing wrong. Today that
 * is the normal state: zero interior gaps, zero error or warn findings. So the
 * dashboard looks exactly as it did until something actually breaks, and then
 * it says so where you already are.
 *
 * Deliberately not shown here: `info` findings. All 24 of them are per-company
 * colour - two consolidated filers and one merged name - and each is already
 * stated in `universe.notes` on the company itself, where it is read next to
 * that company's numbers rather than in a list of two dozen.
 */

import { StatusDot } from "./controls";
import { monthLabel } from "../format";
import type { Alerts } from "../types";

/** The consolidated-filer caveat, worded once so the two placements cannot drift. */
export function consolidatedNote(alerts: Alerts | undefined): string | null {
  const names = alerts?.consolidated ?? [];
  if (names.length === 0) return null;
  const list = names.map((c) => c.display_name).join(", ");
  return (
    `Revenue levels include ${names.length} consolidated ` +
    `filer${names.length === 1 ? "" : "s"} (${list}) reporting in a foreign ` +
    `functional currency — growth rates are unaffected.`
  );
}

function Strip({
  tone,
  children,
}: {
  tone: "error" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        gap: "2px 10px",
        padding: "7px 12px",
        marginBottom: "var(--grid-gap)",
        borderRadius: "var(--radius-card)",
        border: `1px solid var(--${tone === "error" ? "error" : "warn"}-border)`,
        background: `var(--${tone === "error" ? "error" : "warn"}-bg)`,
        fontSize: 11.5,
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </div>
  );
}

export function AlertStrip({ alerts }: { alerts: Alerts | undefined }) {
  const gaps = alerts?.interior_gaps ?? [];
  const severe = alerts?.severe_findings ?? [];
  if (gaps.length === 0 && severe.length === 0) return null;

  return (
    <>
      {gaps.length > 0 && (
        <Strip tone="error">
          <StatusDot level="critical">
            {gaps.length} missing month{gaps.length === 1 ? "" : "s"}
          </StatusDot>
          <span style={{ color: "var(--text-muted)" }}>
            A month with no filing sits between two months that filed, so the fetch
            failed rather than the company. Month-over-month and year-to-date are
            understated from that month on for:
          </span>
          <span style={{ color: "var(--text-primary)" }}>
            {gaps
              .map((g) => `${g.display_name} ${g.ticker} · ${monthLabel(g.month)}`)
              .join(" | ")}
          </span>
        </Strip>
      )}

      {severe.length > 0 && (
        <Strip tone={severe.some((f) => f.severity === "error") ? "error" : "warn"}>
          <StatusDot level={severe.some((f) => f.severity === "error") ? "critical" : "warning"}>
            {severe.length} open finding{severe.length === 1 ? "" : "s"}
          </StatusDot>
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            {severe.map((f, i) => (
              <div key={i} style={{ color: "var(--text-muted)" }}>
                <code style={{ color: "var(--text-primary)" }}>{f.code}</code>
                {f.ticker ? ` · ${f.ticker}` : ""}
                {f.month ? ` · ${f.month}` : ""} — {f.message}
              </div>
            ))}
          </div>
        </Strip>
      )}
    </>
  );
}
