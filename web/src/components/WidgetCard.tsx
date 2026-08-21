/**
 * The one card shell every data widget uses.
 *
 * There is deliberately no second visual shell in this dashboard: a widget is a
 * card, and a card looks like this. `wide` and `full` change how many grid
 * columns it spans, never how it looks.
 */

import type { CSSProperties, ReactNode } from "react";

export type Category = "markets" | "analytics" | "heatmaps" | "sector" | "tools";

const CATEGORY_COLORS: Record<Category, { bg: string; text: string; border: string }> = {
  markets: { bg: "#eff6ff", text: "#2563eb", border: "#dbeafe" },
  analytics: { bg: "#f5f3ff", text: "#7c3aed", border: "#ede9fe" },
  heatmaps: { bg: "#fff1f2", text: "#e11d48", border: "#fecdd3" },
  sector: { bg: "#f0fdfa", text: "#0d9488", border: "#99f6e4" },
  tools: { bg: "#f0fdf4", text: "#16a34a", border: "#bbf7d0" },
};

export function CategoryBadge({ category }: { category: Category }) {
  const c = CATEGORY_COLORS[category];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        padding: "2px 8px",
        borderRadius: 6,
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.text,
        whiteSpace: "nowrap",
      }}
    >
      {category}
    </span>
  );
}

export interface WidgetCardProps {
  title: string;
  subtitle?: string;
  category?: Category;
  /** Controls, shown in the header beside the badge. */
  actions?: ReactNode;
  /** Spans two grid columns where there is room - for matrices and wide tables. */
  wide?: boolean;
  /** Spans the whole grid row. */
  full?: boolean;
  /** Suppresses the hover lift. Use for anything scrollable or cell-hoverable. */
  staticCard?: boolean;
  /** Applied to the body, e.g. to let a matrix scroll horizontally. */
  bodyStyle?: CSSProperties;
  children: ReactNode;
}

export function WidgetCard({
  title,
  subtitle,
  category,
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
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--card-header-bg)",
          backdropFilter: "blur(8px)",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {title}
          </h3>
          {subtitle && (
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                color: "var(--text-hint)",
                lineHeight: 1.3,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {actions}
          {category && <CategoryBadge category={category} />}
        </div>
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
