/**
 * Hand-rolled SVG charts.
 *
 * No chart library. Three reasons, in order of weight:
 *
 *  1. **Nulls.** Every library's default is to interpolate across a missing point
 *     or to treat it as zero. Both invent revenue that was never filed. Here a
 *     null breaks the line and leaves the bar slot hatched, by construction.
 *  2. **Mark specs.** 2px lines, a 4px rounded data-end anchored to the baseline,
 *     a 2px surface gap between adjacent bars, ≥8px hover markers, recessive
 *     hairline grid. Getting these out of a library is more work than drawing them.
 *  3. **One axis, always.** There is no dual-axis escape hatch in this module, so
 *     nobody can add one. Revenue and growth rates are different scales and get
 *     different charts.
 *
 * Series colors are the validated categorical slots in fixed order (blue,
 * orange, aqua) - assigned by identity, never by rank, so filtering a series out
 * never repaints the survivors. Aqua sits at 2.74:1 against the surface, under
 * the 3:1 guide, which obligates the relief the validator asks for: every series
 * is direct-labeled at its last point and the same numbers exist as a table on
 * the Data tab.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { NA, isMissing, monthShort } from "../format";

/** Categorical slots, fixed order. A 4th series is not a new hue - it is a facet. */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"] as const;

// ------------------------------------------------------------------ sizing --

/** Width from the DOM, because geometry computed from a guess collides labels. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setW(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, w];
}

// ----------------------------------------------------------------- tooltip --

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip, width }: { tip: TipState; width: number }) {
  // Flip to the left of the cursor near the right edge so the tip never clips.
  const flip = tip.x > width - 180;
  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        left: flip ? undefined : tip.x + 12,
        right: flip ? width - tip.x + 12 : undefined,
        top: Math.max(4, tip.y - 12),
        pointerEvents: "none",
        background: "rgba(255,255,255,0.98)",
        border: "1px solid var(--border-solid)",
        borderRadius: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,0.10)",
        padding: "6px 9px",
        fontSize: 12,
        lineHeight: 1.45,
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
        zIndex: 5,
      }}
    >
      {tip.content}
    </div>
  );
}

// ------------------------------------------------------------------- scales --

/** A "nice" upper bound so the top gridline is a round number. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function ticks(lo: number, hi: number, n = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
  return out;
}

/** X labels thin out rather than overlap; the first and last always survive. */
function labelEvery(count: number, width: number): number {
  const per = width / Math.max(1, count);
  return per >= 34 ? 1 : per >= 20 ? 2 : Math.ceil(34 / Math.max(per, 1));
}

// -------------------------------------------------------------- month bars --

export interface MonthPoint {
  month: string;
  value: number | null;
}

/**
 * Revenue bars. One series, one hue, no legend - the title names it.
 *
 * A month with no filing is not a zero-height bar (indistinguishable from a real
 * zero); it gets a hatched stub at the baseline and says "no filing" on hover.
 */
export function MonthBars({
  data,
  height = 180,
  format,
  color = "var(--seq-400)",
}: {
  data: MonthPoint[];
  height?: number;
  format: (v: number | null) => string;
  color?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);

  const pad = { l: 52, r: 10, t: 10, b: 22 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = Math.max(0, height - pad.t - pad.b);
  const values = data.map((d) => d.value).filter((v): v is number => !isMissing(v));
  const max = niceMax(values.length ? Math.max(...values) : 1);
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(30, band - 2)); // 2px surface gap between bars
  const step = labelEvery(data.length, plotW);

  const y = (v: number) => pad.t + plotH - (v / max) * plotH;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Monthly revenue">
          {ticks(0, max).map((t, i) => (
            <g key={i}>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={y(t)}
                y2={y(t)}
                stroke={i === 0 ? "var(--axis-line)" : "var(--grid-line)"}
                strokeWidth={1}
              />
              <text
                x={pad.l - 6}
                y={y(t) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {format(t)}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            const cx = pad.l + band * i + band / 2;
            const x = cx - barW / 2;
            const hit = (
              <rect
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={plotH}
                fill="transparent"
                onPointerMove={(e) => {
                  const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  setTip({
                    x: r ? e.clientX - r.left : cx,
                    y: r ? e.clientY - r.top : pad.t,
                    content: (
                      <>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          {monthShort(d.month)} {d.month.slice(0, 4)}
                        </div>
                        <div>{isMissing(d.value) ? "no filing" : format(d.value)}</div>
                      </>
                    ),
                  });
                }}
                onPointerLeave={() => setTip(null)}
              />
            );

            if (isMissing(d.value)) {
              return (
                <g key={d.month}>
                  <rect
                    x={x}
                    y={pad.t + plotH - 3}
                    width={barW}
                    height={3}
                    fill="url(#absent-hatch)"
                    stroke="var(--cell-missing-ink)"
                    strokeWidth={0.5}
                  />
                  {hit}
                </g>
              );
            }

            const top = y(d.value as number);
            const h = Math.max(1, pad.t + plotH - top);
            const r = Math.min(4, barW / 2, h); // rounded data-end only
            return (
              <g key={d.month}>
                <path
                  d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${
                    x + barW
                  },${top} ${x + barW},${top + r} V${top + h} Z`}
                  fill={color}
                />
                {hit}
              </g>
            );
          })}

          {data.map((d, i) =>
            i % step === 0 || i === data.length - 1 ? (
              <text
                key={`x${d.month}`}
                x={pad.l + band * i + band / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {monthShort(d.month)}
              </text>
            ) : null,
          )}

          <defs>
            <pattern id="absent-hatch" width="4" height="4" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="#ffffff" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="#e8e6e0" strokeWidth="1.5" />
            </pattern>
          </defs>
        </svg>
      )}
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

// -------------------------------------------------------------- month lines --

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  /** Aligned to `months`; null means absent and BREAKS the line. */
  values: (number | null)[];
}

/**
 * Growth-rate lines on one shared axis, in percent or ppt.
 *
 * Null breaks the path. That is the whole reason this is drawn by hand: a line
 * that strides across a month nobody filed asserts a value that does not exist.
 */
export function MonthLines({
  months,
  series,
  height = 200,
  unit = "%",
  domain,
  refLine,
}: {
  months: string[];
  series: LineSeries[];
  height?: number;
  unit?: string;
  /** Shared y domain. Small multiples MUST pass this or they cannot be compared. */
  domain?: readonly [number, number];
  /** The value the chart is read against - 0 for a signed rate, 100 for an index. */
  refLine?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const pad = { l: 46, r: 52, t: 10, b: 22 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = Math.max(0, height - pad.t - pad.b);

  const anchor = refLine ?? 0;
  const all = series.flatMap((s) => s.values).filter((v): v is number => !isMissing(v));
  const rawMin = all.length ? Math.min(...all, anchor) : anchor;
  const rawMax = all.length ? Math.max(...all, anchor) : anchor + 1;
  const spanPad = Math.max(1, (rawMax - rawMin) * 0.08);
  const lo = domain ? domain[0] : rawMin - spanPad;
  const hi = domain ? domain[1] : rawMax + spanPad;

  const x = (i: number) => pad.l + (months.length <= 1 ? plotW / 2 : (plotW * i) / (months.length - 1));
  const y = (v: number) => pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const step = labelEvery(months.length, plotW);

  /** Contiguous runs of non-null points; each run is its own path. */
  const runs = (s: LineSeries): { i: number; v: number }[][] => {
    const out: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    s.values.forEach((v, i) => {
      if (isMissing(v)) {
        if (cur.length) out.push(cur);
        cur = [];
      } else {
        cur.push({ i, v: v as number });
      }
    });
    if (cur.length) out.push(cur);
    return out;
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Growth rates by month">
          {ticks(lo, hi).map((t, i) => (
            <g key={i}>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--grid-line)"
                strokeWidth={1}
              />
              <text
                x={pad.l - 6}
                y={y(t) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {t.toFixed(0)}
              </text>
            </g>
          ))}

          {/* The reference value is drawn stronger: 0 for a rate, 100 for an index.
              Without it, "above or below the baseline" has to be inferred. */}
          {lo < anchor && hi > anchor && (
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={y(anchor)}
              y2={y(anchor)}
              stroke="var(--axis-line)"
              strokeWidth={1.5}
            />
          )}

          {hoverIdx !== null && (
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={pad.t}
              y2={pad.t + plotH}
              stroke="var(--axis-line)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {series.map((s) => (
            <g key={s.key}>
              {runs(s).map((run, ri) => (
                <g key={ri}>
                  <path
                    d={run.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i)},${y(p.v)}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {/* A single surviving point would otherwise draw nothing at all. */}
                  {run.length === 1 && run[0] && (
                    <circle cx={x(run[0].i)} cy={y(run[0].v)} r={3} fill={s.color} />
                  )}
                </g>
              ))}
              {hoverIdx !== null &&
                !isMissing(s.values[hoverIdx]) && (
                  <circle
                    cx={x(hoverIdx)}
                    cy={y(s.values[hoverIdx] as number)}
                    r={4.5}
                    fill={s.color}
                    stroke="var(--chart-surface)"
                    strokeWidth={2}
                  />
                )}
            </g>
          ))}

          {/* Direct labels at the last real point: the relief for the contrast WARN. */}
          {series.map((s) => {
            const rs = runs(s);
            const last = rs[rs.length - 1];
            const p = last?.[last.length - 1];
            if (!p) return null;
            return (
              <text
                key={`lbl${s.key}`}
                x={x(p.i) + 6}
                y={y(p.v) + 3}
                fontSize={10}
                fontWeight={600}
                fill="var(--text-secondary)"
              >
                {s.values[p.i]?.toFixed(1)}
                {unit}
              </text>
            );
          })}

          {months.map((m, i) =>
            i % step === 0 || i === months.length - 1 ? (
              <text
                key={m}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {monthShort(m)}
              </text>
            ) : null,
          )}

          <rect
            x={pad.l}
            y={pad.t}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={(e) => {
              const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
              if (!r) return;
              const px = e.clientX - r.left;
              const i = Math.round(((px - pad.l) / (plotW || 1)) * (months.length - 1));
              const idx = Math.min(months.length - 1, Math.max(0, i));
              setHoverIdx(idx);
              const month = months[idx];
              setTip({
                x: px,
                y: e.clientY - r.top,
                content: (
                  <>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {month ? `${monthShort(month)} ${month.slice(0, 4)}` : ""}
                    </div>
                    {series.map((s) => (
                      <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: s.color,
                            flexShrink: 0,
                          }}
                        />
                        {s.label}:{" "}
                        <strong style={{ color: "var(--text-primary)" }}>
                          {isMissing(s.values[idx])
                            ? NA
                            : `${(s.values[idx] as number).toFixed(1)}${unit}`}
                        </strong>
                      </div>
                    ))}
                  </>
                ),
              });
            }}
            onPointerLeave={() => {
              setHoverIdx(null);
              setTip(null);
            }}
          />
        </svg>
      )}
      {tip && <Tooltip tip={tip} width={width} />}
      {series.length >= 2 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            padding: "2px 12px 8px 46px",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {series.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 2.5, background: s.color, borderRadius: 2 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- sparkline --

/**
 * Sparkline for a table row. No axes, no labels - it carries shape only, and the
 * cell beside it carries the number.
 */
export function Sparkline({
  values,
  width = 72,
  height = 20,
  color = "var(--seq-400)",
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const real = values.filter((v): v is number => !isMissing(v));
  if (real.length < 2) return <span style={{ color: "var(--text-hint)", fontSize: 11 }}>{NA}</span>;
  const lo = Math.min(...real);
  const hi = Math.max(...real);
  const span = hi - lo || 1;
  const x = (i: number) => (width * i) / (values.length - 1);
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);

  const segs: string[] = [];
  let open = false;
  values.forEach((v, i) => {
    if (isMissing(v)) {
      open = false;
      return;
    }
    segs.push(`${open ? "L" : "M"}${x(i).toFixed(1)},${y(v as number).toFixed(1)}`);
    open = true;
  });

  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
      <path d={segs.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

/** Keeps a chart from animating in when the user asked for no motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
