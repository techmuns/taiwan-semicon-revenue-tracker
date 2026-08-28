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

import { useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

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
  /**
   * Lets the reader fold the body away. For reference copy - the kind of card
   * you read once and then want out of the way - rather than for data, which
   * should never need a click to be seen.
   */
  collapsible?: boolean;
  /** Only meaningful with `collapsible`. Defaults to closed. */
  defaultOpen?: boolean;
  /**
   * Take the card's natural height instead of stretching to the row. For a card
   * whose content is genuinely short - an identity strip, an empty state - where
   * stretching would draw a tall box mostly full of nothing. Use sparingly: a
   * row of stretched cards is the tidier default, and this opts one out of it.
   */
  fit?: boolean;
  /**
   * A caveat that belongs to the FIGURE, not to the page.
   *
   * Rendered as a hairline-separated last row of the card, below the body, so a
   * qualification like "totals exclude X, counting both would double-count"
   * cannot be scrolled away from the number it qualifies. Null renders nothing,
   * which is what lets a caller pass a generated note straight through without
   * a conditional at every call site.
   */
  footnote?: ReactNode;
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
  collapsible,
  defaultOpen = false,
  fit,
  footnote,
  children,
}: WidgetCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const folded = collapsible && !open;
  const natural = folded || fit;
  return (
    <div
      className={`widget-card${staticCard ? " widget-card--static" : ""}`}
      style={{
        gridColumn: full ? "1 / -1" : wide ? "span 2" : undefined,
        minWidth: 0,
        // The grid stretches its rows, which is right for a card with content.
        // A FOLDED card has none, so stretching it would draw a tall empty box
        // with a header stranded at the top of it. `height` has to be overridden
        // too: .widget-card carries `height: 100%` to fill a stretched track,
        // and that wins over alignSelf on its own.
        alignSelf: natural ? "start" : undefined,
        height: natural ? "auto" : undefined,
      }}
    >
      <div
        {...(collapsible
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-expanded": open,
              onClick: () => setOpen((v) => !v),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              },
            }
          : {})}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          /*
           * One height for every card header, whether or not it has a subtitle.
           * At 38 a title-only header sat ~8px shorter than its neighbours, so
           * across a row of cards the title baselines stepped up and down and
           * the body rules never lined up. 46 is the two-line height, so the
           * one-line headers pad to match instead of the other way round.
           */
          minHeight: 46,
          padding: "8px 12px",
          // A folded card has no body, so its header border would be a rule
          // under nothing.
          borderBottom: folded ? "none" : "1px solid var(--border)",
          background: "var(--card-header-bg)",
          flexShrink: 0,
          cursor: collapsible ? "pointer" : undefined,
          userSelect: collapsible ? "none" : undefined,
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
        {(actions || collapsible) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {actions}
            {collapsible && (
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  color: "var(--text-hint)",
                  transform: open ? "rotate(180deg)" : "none",
                  transition: "transform 0.14s cubic-bezier(0.2, 0, 0.2, 1)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2.2"
                     strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            )}
          </div>
        )}
      </div>
      {!folded && (
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
      )}
      {!folded && footnote && (
        <div
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--card-body-bg)",
            fontSize: 10,
            lineHeight: 1.4,
            color: "var(--text-hint)",
          }}
        >
          {footnote}
        </div>
      )}
    </div>
  );
}
