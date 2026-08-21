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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        padding: "10px 14px",
        marginBottom: 20,
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        backdropFilter: "blur(8px)",
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

      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: 1, minWidth: 280 }}>
        <Label>Stage</Label>
        <ChipSet
          options={buckets.map((b) => ({ value: b, label: b }))}
          selected={filters.buckets}
          onToggle={(v) => onChange({ ...filters, buckets: toggle(filters.buckets, v) })}
          onClear={() => onChange({ ...filters, buckets: [] })}
          emptyMeans="all stages"
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
  );
}
