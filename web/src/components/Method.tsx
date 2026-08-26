/**
 * The one footnote card that closes the Overview tab.
 *
 * Two cards used to live here and both were operator plumbing rather than
 * reader information. A "Sources" card listed each feed with its row count and
 * id - in steady state exactly one row, `mops_company`, so it spent a whole card
 * to name one feed. A "Freshness" table then listed every month with the count
 * that filed and the UTC stamp of the write, which is a cron report, not a fact
 * about revenue. What a reader needs from both of them - how current the data is
 * - is already in the header, beside the latest month, where it is read without
 * scrolling to the bottom of the page.
 *
 * The access posture went the same way. "access: open - NO ACCESS CONTROL. Set
 * DASHBOARD_KEY, or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD" is a deployment
 * instruction addressed to whoever runs the Worker, printed at the bottom of a
 * revenue dashboard. It is still reported by /api/meta and documented in the
 * runbook, which is where the person who can act on it looks.
 *
 * What survives is the part a reader genuinely needs before quoting a number:
 * the units, and what a blank cell means. It spans the full grid and folds, so
 * the tab ends on a footer bar rather than an orphan column.
 */

import { WidgetCard } from "./WidgetCard";
import type { Meta } from "../types";

export function MethodAndUnits({ meta }: { meta: Meta }) {
  return (
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
    </WidgetCard>
  );
}
