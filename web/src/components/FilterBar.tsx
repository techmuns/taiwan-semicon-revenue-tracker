/**
 * The shared filter row, above every tab's widgets.
 *
 * One row, one shared state, mirrored into the URL by App so a view can be sent
 * to someone else and arrive identical.
 *
 * Dec 2025 is selectable but not the default `from`: it exists so January's MoM
 * and acceleration have a real prior month, not as a month to read. The hint says
 * so, because a shoulder month showing up unexplained looks like a bug.
 */

import { ChipSet, Label, MonthSelect, Toggle } from "./controls";
import type { FilterState } from "../api";
import type { Meta } from "../types";

export function FilterBar({
  meta,
  filters,
  onChange,
  rowCount,
}: {
  meta: Meta | null;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  rowCount: number | null;
}) {
  const months = meta?.months ?? [];
  const buckets = meta?.buckets ?? [];
  const tiers = meta?.tiers ?? [1, 2];
  const shoulder = meta?.shoulder_months ?? [];

  const toggle = <T,>(list: readonly T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    /*
     * TWO ROWS, not one wrapping row.
     *
     * The stage filter has ten chips whose labels run to 30 characters
     * ("Legacy / Mature Node Control Group"). Sharing one flex line with the
     * month pickers, the tier chips, the toggle and the row count meant it was
     * handed whatever width was left and wrapped into three ragged lines of
     * different lengths, with the STAGE label stranded against the middle of the
     * block. Giving it its own full-width row lets it wrap evenly, and puts the
     * short controls on one tidy line above it.
     */
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "8px 12px",
        marginBottom: "var(--grid-gap)",
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
          minHeight: "var(--control-h)",
        }}
      >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Label>Months</Label>
        <MonthSelect
          months={months}
          value={filters.from}
          onChange={(v) => onChange({ ...filters, from: v ?? filters.from })}
        />
        <span style={{ color: "var(--text-hint)", fontSize: 12 }}>to</span>
        <MonthSelect
          months={months}
          value={filters.to}
          onChange={(v) => onChange({ ...filters, to: v })}
          allowAny
          anyLabel="latest"
        />
      </span>

      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Label>Tier</Label>
        <ChipSet
          options={tiers.map((t) => ({
            value: String(t),
            label: `Tier ${t}`,
            title: t === 1 ? "Cleanest AI read-through" : "Mixed or diluted signal",
          }))}
          selected={filters.tiers.map(String)}
          onToggle={(v) => onChange({ ...filters, tiers: toggle(filters.tiers, Number(v)) })}
          onClear={() => onChange({ ...filters, tiers: [] })}
          emptyMeans="both tiers"
        />
      </span>

      <Toggle
        checked={filters.onlyWithData}
        onChange={(v) => onChange({ ...filters, onlyWithData: v })}
        label="Only months with a filing"
        title="Off shows the gap explicitly; on hides rows that have no revenue at all"
      />

      <span style={{ fontSize: 11, color: "var(--text-hint)", marginLeft: "auto" }}>
        {rowCount === null ? "" : `${rowCount.toLocaleString("en-US")} rows`}
        {shoulder.length > 0 && (
          <>
            {" · "}
            <span title="Fetched so January has a real prior month for MoM and acceleration">
              {shoulder.join(", ")} is a shoulder month
            </span>
          </>
        )}
      </span>
      </div>

      {/* Row two: the stage chips, full width, with the label aligned to the
          FIRST line rather than floating against the middle of a wrapped block. */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          borderTop: "1px solid var(--border)",
          paddingTop: 8,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", height: 22, flexShrink: 0 }}>
          <Label>Stage</Label>
        </span>
        <ChipSet
          options={buckets.map((b) => ({ value: b, label: b }))}
          selected={filters.buckets}
          onToggle={(v) => onChange({ ...filters, buckets: toggle(filters.buckets, v) })}
          onClear={() => onChange({ ...filters, buckets: [] })}
          emptyMeans="all stages"
        />
      </div>
    </div>
  );
}
