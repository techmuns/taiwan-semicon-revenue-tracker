/**
 * Loading / empty / error, as three components rather than three ad-hoc blocks
 * per widget.
 *
 * The distinction that matters: EMPTY means the query succeeded and matched
 * nothing (fix your filters); ERROR means the request failed (nothing is known).
 * A widget that renders an empty state on a failed fetch tells the reader the
 * data is absent when in fact it is unknown - which is the same class of mistake
 * as printing 0 for null.
 */

import type { ReactNode } from "react";
import { ApiError } from "../api";

const CENTER = {
  minHeight: 160,
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  textAlign: "center" as const,
};

/** Skeleton shaped like the widget it stands in for, not a spinner. */
export function Shimmer({
  rows = 4,
  height = 14,
  gap = 10,
  padding = 16,
}: {
  rows?: number;
  height?: number;
  gap?: number;
  padding?: number;
}) {
  return (
    <div style={{ padding, display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="shimmer"
          style={{
            height,
            // Ragged widths read as content loading; equal bars read as a pattern.
            width: `${100 - (i % 3) * 12}%`,
          }}
        />
      ))}
    </div>
  );
}

/** A block shimmer, for matrices and charts where rows would be misleading. */
export function ShimmerBlock({ height = 220 }: { height?: number }) {
  return (
    <div style={{ padding: 16 }}>
      <div className="shimmer" style={{ height, width: "100%" }} />
    </div>
  );
}

export function EmptyState({
  message,
  hint,
  icon = "◌",
}: {
  message: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div style={CENTER}>
      <div
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "var(--primary-light)",
          color: "var(--primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>{message}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--text-hint)", maxWidth: 320 }}>{hint}</div>}
    </div>
  );
}

/**
 * Error state.
 *
 * The message is the API's own `error` string, which the Worker writes to be
 * readable ("query failed", "unknown ticker 9999"). A stack trace is never shown.
 * The status and path go in the small print so a problem can be reported
 * precisely without the reader having to open devtools.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  const isApi = error instanceof ApiError;
  const message = isApi
    ? error.status === 0
      ? "Could not reach the API"
      : "The API could not answer that"
    : "Something went wrong";
  const detail = error instanceof Error ? error.message : String(error);

  return (
    <div style={CENTER} role="alert">
      <div
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "var(--error-bg)",
          color: "var(--error-red)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          fontWeight: 700,
        }}
      >
        !
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>{message}</div>
      <div style={{ fontSize: 12, color: "var(--text-hint)", maxWidth: 380 }}>{detail}</div>
      {isApi && (
        <div style={{ fontSize: 11, color: "var(--text-hint)" }}>
          {error.path}
          {error.status ? ` · HTTP ${error.status}` : ""}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 4,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--primary-text)",
            background: "var(--primary-light)",
            border: "1px solid var(--primary-border)",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The three-state wrapper.
 *
 * `data` staying visible while `loading` is true is the "refreshing" standard:
 * a filter change must not blank the screen it is refining.
 */
export function AsyncBody<T>({
  state,
  skeleton,
  empty,
  onRetry,
  children,
}: {
  state: { data: T | null; error: unknown; loading: boolean };
  skeleton?: ReactNode | undefined;
  /** Return null to render children; return a node to show an empty state. */
  empty?: ((data: T) => ReactNode | null) | undefined;
  onRetry?: (() => void) | undefined;
  children: (data: T) => ReactNode;
}) {
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={onRetry} />;
  if (!state.data) return <>{skeleton ?? <Shimmer />}</>;
  const emptyNode = empty?.(state.data);
  if (emptyNode) return <>{emptyNode}</>;
  return (
    <div style={{ position: "relative", height: "100%" }}>
      {children(state.data)}
      {state.loading && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(255,255,255,0.35)",
            pointerEvents: "none",
          }}
        />
      )}
      {state.error ? (
        // Refresh failed but stale data is still on screen. Say so rather than
        // silently showing numbers the reader will assume are current.
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--error-red)",
            background: "var(--error-bg)",
            border: "1px solid #fecaca",
            borderRadius: 6,
            padding: "2px 8px",
          }}
        >
          refresh failed — showing last good data
        </div>
      ) : null}
    </div>
  );
}
