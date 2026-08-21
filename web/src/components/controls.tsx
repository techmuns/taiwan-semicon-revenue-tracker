/**
 * Form controls.
 *
 * Plain HTML elements, styled. A `<select>` is a `<select>`, so keyboard, mobile
 * pickers, and screen readers all work without any of it being re-implemented.
 */

import type { CSSProperties, ReactNode } from "react";
import { monthLabel } from "../format";

const CONTROL: CSSProperties = {
  height: "var(--control-h)",
  padding: "0 7px",
  fontSize: 11.5,
  color: "var(--text-secondary)",
  background: "var(--card-bg)",
  border: "1px solid var(--border-solid)",
  borderRadius: "var(--radius-control)",
  cursor: "pointer",
};

export function Label({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

export function Button({
  children,
  onClick,
  active,
  title,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        ...CONTROL,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        color: active ? "var(--primary-text)" : "var(--text-secondary)",
        background: active ? "var(--primary-light)" : "var(--card-bg)",
        borderColor: active ? "var(--primary-border)" : "var(--border-solid)",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Segmented control - view toggles, metric pickers, and the header's tab strip.
 * Exactly one option is selected.
 *
 * Two variants, because the two jobs read differently at a glance. `pill` is a
 * control that sets a parameter of the widget it sits in. `underline` is
 * navigation: it says which page you are on, and a pill in the header competes
 * with the pills inside the widgets for the same meaning.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = "pill",
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  variant?: "pill" | "underline";
}) {
  if (variant === "underline") {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        style={{
          display: "inline-flex",
          alignSelf: "stretch",
          gap: 2,
          // The 2px underline overlaps the header's own 1px bottom border, so the
          // selected tab reads as attached to the content rather than floating.
          marginBottom: -1,
        }}
      >
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              role="tab"
              aria-selected={on}
              type="button"
              title={o.title}
              onClick={() => onChange(o.value)}
              style={{
                padding: "0 10px",
                fontSize: 12,
                fontWeight: on ? 600 : 500,
                border: "none",
                borderBottom: `2px solid ${on ? "var(--primary)" : "transparent"}`,
                background: "transparent",
                color: on ? "var(--text-primary)" : "var(--text-muted)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "var(--ease)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        padding: 1,
        gap: 1,
        background: "var(--track)",
        border: "1px solid var(--border-solid)",
        borderRadius: "var(--radius-control)",
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            type="button"
            title={o.title}
            onClick={() => onChange(o.value)}
            style={{
              height: 22,
              padding: "0 9px",
              fontSize: 11.5,
              fontWeight: on ? 600 : 500,
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              whiteSpace: "nowrap",
              color: on ? "var(--text-primary)" : "var(--text-muted)",
              background: on ? "var(--card-bg)" : "transparent",
              transition: "var(--ease)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How a widget that has both draws itself: as a graph, or as a table of numbers.
 *
 * Graph is the default everywhere. A chart answers "what is the shape" in one
 * glance, which is the question this dashboard exists for - which stage is
 * inflecting, and in what order. The table answers the second question, "what
 * exactly is the number", and it has to stay one click away for two independent
 * reasons: the aqua series color sits at 2.8:1 against the card surface, under the
 * 3:1 guide, and the relief the palette validator asks for is direct labels plus a
 * table view; and a figure that is going to be quoted should be read as a figure,
 * not estimated off an axis.
 */
export type ViewMode = "chart" | "table";

/**
 * One mode for the whole dashboard, not one per card.
 *
 * The control is drawn in the header of each widget that has both forms - which is
 * where you are looking when you want to switch - but it sets a single shared
 * value that lives in the URL. So a link carries the reader's choice, and a screen
 * is never half graphs and half tables, which is the state that makes two widgets
 * side by side impossible to compare. The title text says so, because a control
 * with effects outside its own card has to admit it.
 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <Segmented
      options={[
        {
          value: "chart" as ViewMode,
          label: "Graph",
          title: "Draw every chart on this dashboard as a graph",
        },
        {
          value: "table" as ViewMode,
          label: "Table",
          title: "Draw every chart on this dashboard as a table of numbers",
        },
      ]}
      value={value}
      onChange={onChange}
      ariaLabel="Draw as a graph or a table"
    />
  );
}

export function MonthSelect({
  months,
  value,
  onChange,
  allowAny,
  anyLabel = "latest",
}: {
  months: string[];
  value: string | null;
  onChange: (v: string | null) => void;
  allowAny?: boolean;
  anyLabel?: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      style={CONTROL}
    >
      {allowAny && <option value="">{anyLabel}</option>}
      {months.map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** Multi-select as chips. Nothing selected means no filter, which is stated. */
export function ChipSet({
  options,
  selected,
  onToggle,
  onClear,
  emptyMeans = "all",
}: {
  options: readonly { value: string; label: string; title?: string }[];
  selected: readonly string[];
  onToggle: (v: string) => void;
  onClear?: () => void;
  emptyMeans?: string;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
            style={{
              height: 22,
              padding: "0 8px",
              fontSize: 11,
              fontWeight: on ? 600 : 500,
              borderRadius: 4,
              cursor: "pointer",
              whiteSpace: "nowrap",
              color: on ? "var(--primary-text)" : "var(--text-muted)",
              background: on ? "var(--primary-light)" : "var(--card-bg)",
              border: `1px solid ${on ? "var(--primary-border)" : "var(--border-solid)"}`,
              transition: "var(--ease)",
            }}
          >
            {o.label}
          </button>
        );
      })}
      {selected.length > 0 && onClear ? (
        <button
          type="button"
          onClick={onClear}
          style={{
            height: 22,
            padding: "0 6px",
            fontSize: 11,
            border: "none",
            background: "transparent",
            color: "var(--text-hint)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          clear
        </button>
      ) : (
        <span style={{ fontSize: 11, color: "var(--text-hint)" }}>
          {selected.length === 0 ? `all ${emptyMeans}` : ""}
        </span>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <label
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--primary)", width: 13, height: 13, cursor: "pointer" }}
      />
      {label}
    </label>
  );
}

/** The indigo ticker pill from the house standard. Shown only when one is selected. */
export function TickerPill({
  ticker,
  company,
  onClear,
}: {
  ticker: string;
  company?: string;
  onClear?: () => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 4px 1px 8px",
        background: "var(--primary-light)",
        color: "var(--primary-text)",
        borderRadius: 4,
        fontSize: 11.5,
        fontWeight: 600,
        border: "1px solid var(--primary-border)",
      }}
    >
      {ticker}
      {company && <span style={{ fontWeight: 400 }}>{company}</span>}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selected company"
          title="Clear selected company"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--primary-text)",
            cursor: "pointer",
            padding: "0 3px",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A small status dot + word. Status color never appears without the word. */
export function StatusDot({
  level,
  children,
}: {
  level: "good" | "warning" | "serious" | "critical";
  children: ReactNode;
}) {
  const color = `var(--status-${level})`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }}
      />
      <span style={{ color: "var(--text-secondary)" }}>{children}</span>
    </span>
  );
}
