/**
 * The Quality tab: what is known, what is missing, and how we know.
 *
 * This tab exists because coverage on a monthly-filing dataset is not a footnote.
 * Companies file late, one name in the universe has no filing obligation at all,
 * and a cron that silently writes nothing looks exactly like a month where nobody
 * filed. So the coverage matrix distinguishes three states, not two:
 *
 *   filed        - a row exists
 *   not filed     - no row, and one was expected  (this is a problem)
 *   no obligation - no row, and none was expected (this is not)
 *
 * Collapsing the last two into "missing" is what makes a data problem invisible.
 */

import { WidgetCard } from "./WidgetCard";
import { EmptyState } from "./states";
import { StatusDot } from "./controls";
import { monthShort } from "../format";
import { groupBy } from "../stats";
import type { Quality } from "../types";

const SEVERITY_LEVEL: Record<string, "good" | "warning" | "serious" | "critical"> = {
  info: "good",
  warn: "warning",
  warning: "warning",
  error: "critical",
  critical: "critical",
};

export function QualityPanel({ quality }: { quality: Quality }) {
  const { coverage, matrix, interior_gaps, findings } = quality;
  const months = [...new Set(matrix.map((c) => c.month))].sort();
  const byTicker = groupBy(matrix, (c) => c.ticker);
  const rows = [...byTicker.entries()].sort((a, b) => {
    const ra = a[1][0];
    const rb = b[1][0];
    return (
      (ra?.bucket ?? "").localeCompare(rb?.bucket ?? "") ||
      (ra?.tier ?? 0) - (rb?.tier ?? 0) ||
      a[0].localeCompare(b[0])
    );
  });

  const bySeverity = groupBy(findings, (f) => f.severity);

  return (
    <>
      <WidgetCard
        full
        fit
        title="Coverage"
        subtitle="Company-months with a filing on record"
      >
        {/* One short stat, so it sets across the row like the Summary strip
            rather than as a column with a screen of nothing under it. */}
        <div
          style={{
            padding: "11px 14px 12px",
            display: "flex",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: "6px 28px",
          }}
        >
          <div
            className="tnum"
            style={{
              fontSize: 19,
              fontWeight: 600,
              lineHeight: 1.2,
              letterSpacing: "-0.015em",
            }}
          >
            {coverage.trackable_pct === null ? "—" : `${coverage.trackable_pct.toFixed(1)}%`}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-hint)" }}>
            {coverage.trackable_with_data.toLocaleString("en-US")} of{" "}
            {coverage.trackable_cells.toLocaleString("en-US")} cells that were expected to have a
            filing
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              flexWrap: "wrap",
              gap: "2px 20px",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            <div>
              Including names with no filing obligation:{" "}
              <strong className="tnum">
                {coverage.pct === null ? "—" : `${coverage.pct.toFixed(1)}%`}
              </strong>{" "}
              of {coverage.cells.toLocaleString("en-US")}
            </div>
            {coverage.known_absent.length > 0 && (
              <div>
                {coverage.known_absent.length} cell
                {coverage.known_absent.length === 1 ? "" : "s"} known-absent by design (
                {[...new Set(coverage.known_absent.map((k) => k.ticker))].join(", ")})
              </div>
            )}
          </div>
        </div>
      </WidgetCard>

      <WidgetCard
        full
        title="Findings"
        subtitle="Automated checks, most severe first"
        staticCard
      >
        {findings.length === 0 ? (
          <EmptyState
            icon="✓"
            message="No findings"
            hint="Every reconciliation, coverage, and plausibility check passed on the current data."
          />
        ) : (
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            {["error", "critical", "warn", "warning", "info"]
              .filter((s) => bySeverity.has(s))
              .map((sev) => (
                <div key={sev}>
                  <div
                    style={{
                      padding: "5px 12px",
                      // Opaque: rows scrolling under a translucent sticky bar read as
                      // two overlapping lines of text.
                      background: "var(--card-bg)",
                      borderBottom: "1px solid var(--border)",
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    <StatusDot level={SEVERITY_LEVEL[sev] ?? "warning"}>
                      {sev} · {bySeverity.get(sev)?.length ?? 0}
                    </StatusDot>
                  </div>
                  {(bySeverity.get(sev) ?? []).map((f, i) => (
                    <div
                      key={i}
                      style={{
                        padding: "5px 14px",
                        borderBottom: "1px solid var(--border)",
                        fontSize: 11,
                      }}
                    >
                      <div style={{ color: "var(--text-secondary)" }}>
                        <code style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                          {f.code}
                        </code>
                        {f.ticker ? ` · ${f.ticker}` : ""}
                        {f.month ? ` · ${f.month}` : ""}
                      </div>
                      <div style={{ color: "var(--text-muted)" }}>{f.message}</div>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        )}
      </WidgetCard>

      <WidgetCard
        full
        title="Coverage matrix"
        subtitle="Filed · not filed · no obligation — three states, not two"
        staticCard
        bodyStyle={{ overflow: "hidden" }}
      >
        {/*
         * Interior gaps used to be a card of their own, which meant the reader
         * was told "no gaps" on a screen that already showed every cell. A hole
         * IS the matrix, so the warning belongs on it: when there is nothing to
         * say, the grid saying it by looking clean is the better answer, and
         * this strip does not render at all.
         */}
        {interior_gaps.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              flexWrap: "wrap",
              gap: "2px 8px",
              padding: "7px 14px",
              borderBottom: "1px solid var(--border-solid)",
              background: "var(--error-bg)",
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            <strong>
              {interior_gaps.length} interior gap
              {interior_gaps.length === 1 ? "" : "s"}
            </strong>
            <span style={{ color: "var(--text-muted)" }}>
              — a filed month is missing between two months that filed, so the fetch
              failed rather than the company. Month-over-month and year-to-date are
              wrong from here on for:
            </span>
            <span style={{ color: "var(--text-primary)" }}>
              {interior_gaps
                .map((g) => `${g.display_name} ${g.ticker} · ${g.month}`)
                .join(" | ")}
            </span>
          </div>
        )}
        <div style={{ overflow: "auto", maxHeight: 420 }}>
          <table
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              width: "100%",
              fontSize: 11,
              background: "var(--chart-surface)",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  style={{
                    position: "sticky",
                    left: 0,
                    top: 0,
                    zIndex: 3,
                    background: "var(--chart-surface)",
                    textAlign: "left",
                    padding: "6px 10px",
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    color: "var(--ink-muted)",
                    borderBottom: "1px solid var(--grid-line)",
                    width: 220,
                  }}
                >
                  Company
                </th>
                {months.map((m) => (
                  <th
                    key={m}
                    scope="col"
                    title={m}
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      background: "var(--chart-surface)",
                      padding: "6px 4px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--ink-muted)",
                      borderBottom: "1px solid var(--grid-line)",
                      minWidth: 34,
                    }}
                  >
                    {monthShort(m)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([ticker, cells]) => {
                const first = cells[0];
                const byMonth = new Map(cells.map((c) => [c.month, c]));
                const expected = first?.status === "active";
                return (
                  <tr key={ticker}>
                    <th
                      scope="row"
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: "var(--chart-surface)",
                        textAlign: "left",
                        padding: "3px 10px",
                        fontWeight: 500,
                        color: "var(--text-secondary)",
                        borderRight: "1px solid var(--grid-line)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {first?.display_name ?? ticker}{" "}
                      <span style={{ color: "var(--text-hint)", fontWeight: 400 }}>
                        {ticker} · T{first?.tier ?? "?"}
                      </span>
                      {!expected && (
                        <span
                          style={{ color: "var(--status-warning)", marginLeft: 6, fontSize: 10 }}
                        >
                          {first?.status}
                        </span>
                      )}
                    </th>
                    {months.map((m) => {
                      const cell = byMonth.get(m);
                      const filed = (cell?.has_data ?? 0) > 0;
                      const bg = filed
                        ? "var(--seq-250)"
                        : expected
                          ? "var(--error-bg)"
                          : "var(--track)";
                      const label = filed
                        ? `filed · ${cell?.source_id ?? "unknown source"}`
                        : expected
                          ? "not filed - expected a row"
                          : "no filing obligation";
                      return (
                        <td
                          key={m}
                          title={`${first?.display_name ?? ticker} · ${m} · ${label}`}
                          style={{
                            background: bg,
                            border: "1px solid var(--chart-surface)",
                            height: 20,
                            textAlign: "center",
                            color: filed ? "var(--ink-on-seq)" : expected ? "var(--error-red)" : "var(--text-hint)",
                            fontSize: 10,
                          }}
                        >
                          {filed ? "" : expected ? "!" : "·"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            padding: "8px 12px",
            borderTop: "1px solid var(--border)",
            fontSize: 10,
            color: "var(--text-muted)",
            flexWrap: "wrap",
          }}
        >
          {[
            { bg: "var(--seq-250)", label: "filed" },
            { bg: "var(--error-bg)", label: "not filed — expected a row", mark: "!" },
            { bg: "var(--track)", label: "no filing obligation", mark: "·" },
          ].map((l) => (
            <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: l.bg,
                  border: "1px solid var(--border-solid)",
                  fontSize: 9,
                  textAlign: "center",
                  lineHeight: "13px",
                  color: "var(--text-muted)",
                }}
              >
                {l.mark ?? ""}
              </span>
              {l.label}
            </span>
          ))}
        </div>
      </WidgetCard>
    </>
  );
}
