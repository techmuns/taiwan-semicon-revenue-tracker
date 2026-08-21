/**
 * The one card shell every data widget uses.
 *
 * There is deliberately no second visual shell in this dashboard: a widget is a
 * card, and a card looks like this. `wide` and `full` change how many grid
 * columns it spans, never how it looks.
 *
 * The colored category badge that used to sit in every header is gone. It carried
 * five pastel hues - markets, analytics, heatmaps, sector, tools - which on a
 * six-widget screen put more saturated color into the chrome than the charts had
 * in their data. It also classified widgets against a taxonomy this dashboard does
 * not have: every widget here is Taiwanese monthly revenue. The header now holds
 * the title, the basis, and the controls that change what is shown, and nothing
 * else.
 */

import type { CSSProperties, ReactNode } from "react";

export interface WidgetCardProps {
  title: string;
  /** One line stating the basis of the number - the weighting, the unit, the denominator. */
  subtitle?: string;
  /** Controls that change what this widget shows. Right-aligned in the header. */
  actions?: ReactNode;
  /** Spans two grid columns where there is room - for matrices and wide tables. */
  wide?: boolean;
  /** Spans the whole grid row. */
  full?: boolean;
  /** Holds the border steady on hover. Use for anything scrollable or cell-hoverable. */
  staticCard?: boolean;
  /** Applied to the body, e.g. to let a matrix scroll horizontally. */
  bodyStyle?: CSSProperties;
  children: ReactNode;
}

export function WidgetCard({
  title,
  subtitle,
  actions,
  wide,
  full,
  staticCard,
  bodyStyle,
  children,
}: WidgetCardProps) {
  return (
    <div
      className={`widget-card${staticCard ? " widget-card--static" : ""}`}
      style={{
        gridColumn: full ? "1 / -1" : wide ? "span 2" : undefined,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          minHeight: 38,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--card-header-bg)",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 12.5,
              fontWeight: 600,
              letterSpacing: "-0.005em",
              color: "var(--text-primary)",
            }}
          >
            {title}
          </h3>
          {subtitle && (
            <p
              style={{
                margin: "1px 0 0",
                fontSize: 11,
                color: "var(--text-hint)",
                lineHeight: 1.35,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {actions}
          </div>
        )}
      </div>
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "var(--card-body-bg)",
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
