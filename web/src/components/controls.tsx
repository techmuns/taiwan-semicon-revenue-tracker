/**
 * Form controls.
 *
 * Plain HTML elements, styled. A `<select>` is a `<select>`, so keyboard, mobile
 * pickers, and screen readers all work without any of it being re-implemented.
 */

import type { CSSProperties, ReactNode } from "react";
import { monthLabel } from "../format";

const CONTROL: CSSProperties = {
  height: 28,
  padding: "0 8px",
  fontSize: 12,
  color: "var(--text-secondary)",
  background: "#ffffff",
  border: "1px solid var(--border-solid)",
  borderRadius: 8,
  cursor: "pointer",
};

export function Label({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--text-hint)",
      }}
    >
      {children}
    </span>
  );
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
        background: active ? "var(--primary-light)" : "#ffffff",
        borderColor: active ? "var(--primary-border)" : "var(--border-solid)",
      }}
    >
      {children}
    </button>
  );
}

/** Segmented control - tabs, and metric pickers. Exactly one option is selected. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        background: "#f3f4f6",
        border: "1px solid var(--border-solid)",
        borderRadius: 9,
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
              height: 24,
              padding: "0 10px",
              fontSize: 12,
              fontWeight: 600,
              border: "none",
              borderRadius: 7,
              cursor: "pointer",
              color: on ? "var(--primary-text)" : "var(--text-muted)",
              background: on ? "#ffffff" : "transparent",
              boxShadow: on ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
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
              height: 24,
              padding: "0 9px",
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 99,
              cursor: "pointer",
              color: on ? "var(--primary-text)" : "var(--text-muted)",
              background: on ? "var(--primary-light)" : "#ffffff",
              border: `1px solid ${on ? "var(--primary-border)" : "var(--border-solid)"}`,
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
            height: 24,
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
          {selected.length === 0 ? `none selected = ${emptyMeans}` : ""}
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
        fontSize: 12,
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--primary)", width: 14, height: 14, cursor: "pointer" }}
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
        gap: 6,
        padding: "2px 10px",
        background: "var(--primary-light)",
        color: "var(--primary-text)",
        borderRadius: 99,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid var(--primary-border)",
      }}
    >
      <span
        style={{ width: 6, height: 6, background: "#6366f1", borderRadius: "50%" }}
        aria-hidden="true"
      />
      {ticker}
      {company && <span style={{ color: "#818cf8", fontWeight: 400 }}>· {company}</span>}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selected company"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--primary-text)",
            cursor: "pointer",
            padding: 0,
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
        style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }}
      />
      <span style={{ color: "var(--text-secondary)" }}>{children}</span>
    </span>
  );
}
