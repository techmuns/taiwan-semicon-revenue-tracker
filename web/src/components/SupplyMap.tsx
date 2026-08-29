/**
 * The supply chain drawn as a map: who sells into whom, and how each end moved.
 *
 * WHY A NODE-LINK DIAGRAM AND NOT A TABLE
 *
 * The Supply links table beside this answers "what is the gap on this pair".
 * It cannot answer "does anything feed a supplier", "how much of the universe is
 * even connected", or "is this stage a source or a sink" - those are questions
 * about SHAPE, and shape is what a table is worst at. This is the only view in
 * the dashboard whose job is structure rather than magnitude.
 *
 * THE SHAPE, MEASURED
 *
 * Two columns rather than ten, because two columns is the truth. Every recorded
 * link is exactly ONE HOP: eight suppliers sell into six buyers, nothing sells
 * into a supplier, and no path is longer than a single edge. A ten-stage
 * left-to-right chain would have drawn a cascade this data does not contain.
 *
 * WHAT EACH CHANNEL CARRIES - and the one that is deliberately absent
 *
 *   position   the stage - every stage is one contiguous, labelled group. The
 *              GROUPS are ordered to minimise crossings, not by chain position;
 *              see `sweep` below for why, with the measurement.
 *   fill       this month's YoY acceleration, on the SAME diverging scale as
 *              every heatmap cell, so a red node here means what a red cell
 *              means there. Each node also PRINTS its value, so colour is never
 *              the only carrier.
 *   hatch      no filing this month. Not a small number - a different fact.
 *   line style solid = a source NAMES the buyer; dashed = inferred from stage
 *              structure. A texture, not a hue, so it survives colour-blindness,
 *              print and forced-colors, and so colour keeps doing exactly one job.
 *
 *   NODE SIZE IS NOT USED. The obvious move is area by revenue, and it would be
 *   wrong twice over: TSMC is ~400x Gudeng, so on any honest scale the small
 *   nodes vanish; and a thick link between two big nodes reads as a big FLOW,
 *   which we do not know - no filing states what any of these pairs is worth.
 *   Revenue is on every other screen. Structure is only on this one.
 *
 * THE UNLINKED COMPANIES ARE ON THE CHART
 *
 * 23 of the 37 have no recorded SUPPLY link. Drawing only the connected 14
 * would make the map look like a finished picture of the chain, which it is
 * not - it is a picture of what has been read out of filings so far. They get a
 * muted strip and a count, because coverage is part of what the map says.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { useWidth, Tooltip } from "./charts";
import type { TipState } from "./charts";
import { Legend } from "./Heatmap";
import { EmptyState } from "./states";
import { NA, ppt, revenue } from "../format";
import { bandFor, cellStyle } from "../scale";
import { CONSOLIDATION, SUPPLIES } from "../generated/relationships";
import type { AnalyticsRow } from "../types";

const NODE_W = 172;
const NODE_H = 34;
const NODE_GAP = 7;
const STAGE_GAP = 17;
const STAGE_LABEL_H = 15;
const PAD_TOP = 8;
/** Room on the right edge for the consolidation connector and its label. */
const CONTAIN_GUTTER = 52;
/** Minimum drawing width. Below this the card scrolls rather than overlapping. */
const MIN_W = 592;

interface Node {
  ticker: string;
  name: string;
  bucket: string;
  accel: number | null;
  revenue: number | null;
  /**
   * Why this node has no acceleration to colour by. Three different facts that
   * a single `filed` flag conflated, and the node captioned all of them "no
   * filing" - which asserted an absence that had not happened:
   *
   *   "filter"  the company is outside the current stage/tier/ticker filter, so
   *             there is no row for it here at all. It very probably filed.
   *   "filing"  it is in the filter and genuinely did not file this month.
   *   "prior"   it filed, but acceleration needs the previous month's YoY and
   *             there is none - every company looks like this in Dec 2025, the
   *             selectable shoulder month, where all 37 accelerations are null
   *             and 36 companies filed.
   */
  absent: "filter" | "filing" | "prior" | null;
  x: number;
  y: number;
}

/**
 * Order the two columns to minimise edge crossings, by the standard two-layer
 * barycentre sweep: put each node at the mean position of its neighbours in the
 * other column, keep each stage's members contiguous, and order the stage bands
 * by their own mean. Repeat until it stops moving - here, two passes.
 *
 * MEASURED, not assumed. Ordering both columns by supply-chain position gives
 * **72 crossings**; this gives **14**. Chain order reads well in a heatmap's rows
 * and badly here, because the two columns are not two points on the chain - the
 * left holds Thermal, Power, Packaging and Equipment, the right holds Rack and
 * AI Silicon, and their chain positions run in opposite directions, so chain
 * order guarantees a full crossing of the diagram.
 *
 * Nothing is lost by it: every stage is still one contiguous, labelled group.
 * The vertical axis in this diagram was never a scale.
 */
function sweep(
  fixed: string[],
  moving: string[],
  bucketOf: (t: string) => string,
  nameOf: (t: string) => string,
  neighbours: (t: string) => string[],
): string[] {
  const at = new Map(fixed.map((t, i) => [t, i]));
  const bary = new Map(
    moving.map((t) => {
      const ns = neighbours(t).map((n) => at.get(n)).filter((v): v is number => v !== undefined);
      return [t, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0];
    }),
  );
  const bands = new Map<string, number[]>();
  for (const t of moving) {
    const k = bucketOf(t);
    bands.set(k, [...(bands.get(k) ?? []), bary.get(t) ?? 0]);
  }
  const bandBary = new Map(
    [...bands].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]),
  );
  return [...moving].sort(
    (a, b) =>
      (bandBary.get(bucketOf(a)) ?? 0) - (bandBary.get(bucketOf(b)) ?? 0) ||
      (bary.get(a) ?? 0) - (bary.get(b) ?? 0) ||
      nameOf(a).localeCompare(nameOf(b)),
  );
}

/** Lay one column out as stage bands, returning the nodes and the column height. */
function layout(
  ordered: string[],
  byTicker: Map<string, AnalyticsRow>,
  x: number,
): { nodes: Node[]; height: number; bands: { label: string; y: number }[] } {
  const nodes: Node[] = [];
  const bands: { label: string; y: number }[] = [];
  let y = PAD_TOP;
  let current: string | null = null;

  for (const t of ordered) {
    const row = byTicker.get(t);
    const bucket = row?.bucket ?? "not in this filter";
    if (bucket !== current) {
      if (current !== null) y += STAGE_GAP;
      bands.push({ label: bucket, y });
      y += STAGE_LABEL_H;
      current = bucket;
    }
    const filed = row !== undefined && row.revenue_twd_thousands !== null;
    const accel = row?.yoy_acceleration_ppt ?? null;
    nodes.push({
      ticker: t,
      name: row?.company_name ?? t,
      bucket,
      accel,
      revenue: row?.revenue_twd_thousands ?? null,
      absent:
        row === undefined ? "filter" : !filed ? "filing" : accel === null ? "prior" : null,
      x,
      y,
    });
    y += NODE_H + NODE_GAP;
  }
  return { nodes, height: y, bands };
}

function NodeBox({
  node,
  dim,
  onEnter,
  onLeave,
  onClick,
}: {
  node: Node;
  dim: boolean;
  onEnter: (e: React.MouseEvent) => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const style = cellStyle(node.accel, "yoy_acceleration_ppt");
  const missing = bandFor(node.accel, "yoy_acceleration_ppt") === null;
  const why =
    node.absent === "filter"
      ? "not in this filter"
      : node.absent === "filing"
        ? "no filing"
        : node.absent === "prior"
          ? "no prior month"
          : null;
  return (
    <g
      opacity={dim ? 0.22 : 1}
      style={{ cursor: "pointer", transition: "opacity 0.12s" }}
      onMouseEnter={onEnter}
      onMouseMove={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      <rect
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={NODE_H}
        rx={4}
        // The SAME 45-degree hatch a missing heatmap cell gets, not a pale fill:
        // absence is a different fact from a small number and must not read as
        // the neutral middle of the scale. Reusing the idiom means the legend
        // below already explains it.
        fill={missing ? "url(#map-hatch)" : style.background}
        stroke="var(--border-solid)"
        strokeWidth={1}
      />
      <text
        x={node.x + 9}
        y={node.y + 14}
        fontSize={11}
        fontWeight={600}
        fill={missing ? "var(--cell-missing-ink)" : style.color}
      >
        {node.name}
      </text>
      <text
        x={node.x + 9}
        y={node.y + 26}
        fontSize={10}
        fill={missing ? "var(--cell-missing-ink)" : style.color}
        opacity={0.85}
      >
        {node.ticker} · {why ?? ppt(node.accel)}
      </text>
    </g>
  );
}

export function SupplyMap({
  rows,
  latestMonth,
  stageOrder,
  universe,
  onSelect,
}: {
  rows: AnalyticsRow[];
  latestMonth: string | null;
  stageOrder: string[];
  /** Every tracked company, so the unlinked ones can be counted honestly. */
  universe: { ticker: string; name: string }[];
  onSelect: (ticker: string) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  const monthRows = rows.filter((r) => r.month === latestMonth);
  const byTicker = new Map(monthRows.map((r) => [r.ticker, r]));

  const supplierIds = [...new Set(SUPPLIES.map((e) => e.from))];
  const buyerIds = [...new Set(SUPPLIES.map((e) => e.to))];
  /**
   * The layout's precondition, checked rather than assumed.
   *
   * Two columns only works while the graph is one hop deep - every company is a
   * supplier or a buyer, never both. Add one edge from a company that already
   * receives one (Wistron selling into Hon Hai would do it) and the same company
   * appears in both columns: React would draw it twice, `pos` would keep only
   * the second, and every edge touching it would silently point at one of the
   * two boxes. A wrong picture drawn confidently is worse than no picture, so
   * this stops instead and says what changed.
   */
  const inBoth = supplierIds.filter((t) => buyerIds.includes(t));
  const linked = new Set([...supplierIds, ...buyerIds]);
  const unlinked = universe.filter((c) => !linked.has(c.ticker));

  const w = Math.max(width || MIN_W, MIN_W);
  const rightX = w - NODE_W - CONTAIN_GUTTER;

  // Seed from chain order so the result is deterministic, then sweep twice -
  // which is where it converges on this graph (72 crossings -> 14).
  const bucketOf = (t: string) => byTicker.get(t)?.bucket ?? "";
  const nameOf = (t: string) => byTicker.get(t)?.company_name ?? t;
  const chain = (list: string[]) =>
    [...list].sort((a, b) => {
      const ia = stageOrder.indexOf(bucketOf(a));
      const ib = stageOrder.indexOf(bucketOf(b));
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || nameOf(a).localeCompare(nameOf(b));
    });
  let lOrder = chain(supplierIds);
  let rOrder = chain(buyerIds);
  for (let i = 0; i < 2; i++) {
    rOrder = sweep(lOrder, rOrder, bucketOf, nameOf, (t) =>
      SUPPLIES.filter((e) => e.to === t).map((e) => e.from));
    lOrder = sweep(rOrder, lOrder, bucketOf, nameOf, (t) =>
      SUPPLIES.filter((e) => e.from === t).map((e) => e.to));
  }

  const left = layout(lOrder, byTicker, 0);
  const right = layout(rOrder, byTicker, rightX);
  const height = Math.max(left.height, right.height) + 4;

  const pos = new Map<string, Node>();
  for (const n of [...left.nodes, ...right.nodes]) pos.set(n.ticker, n);

  const show = (e: React.MouseEvent, content: ReactNode) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
  };

  /** A node or edge is dimmed when something else is hovered. */
  const dimNode = (t: string) =>
    hot !== null && hot !== t &&
    !SUPPLIES.some((e) => (e.from === hot && e.to === t) || (e.to === hot && e.from === t));

  if (inBoth.length > 0) {
    const names = inBoth.map((t) => byTicker.get(t)?.company_name ?? t).join(", ");
    return (
      <EmptyState
        message="The supply graph is no longer one hop deep"
        hint={
          `${names} now both sells to and buys from other tracked companies, so a ` +
          `two-column map would draw it twice and split its links between the copies. ` +
          `The table below is unaffected; the map needs a layered layout before it can ` +
          `show this honestly.`
        }
      />
    );
  }

  return (
    <>
      <div ref={box} style={{ position: "relative", overflowX: "auto" }}>
        <svg
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          role="img"
          aria-label={
            `Supply map: ${supplierIds.length} suppliers selling into ${buyerIds.length} ` +
            `buyers across ${SUPPLIES.length} recorded links.`
          }
          style={{ display: "block" }}
        >
          <defs>
            <pattern
              id="map-hatch"
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="4" height="4" fill="var(--cell-missing-bg)" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="var(--hatch-line)" strokeWidth="1" />
            </pattern>
          </defs>
          {[...left.bands.map((b) => ({ ...b, x: 0 })),
            ...right.bands.map((b) => ({ ...b, x: rightX }))].map((b) => (
            <text
              key={`${b.x}-${b.label}`}
              x={b.x}
              y={b.y + 10}
              fontSize={9.5}
              fill="var(--text-hint)"
              letterSpacing="0.04em"
              style={{ textTransform: "uppercase" }}
            >
              {b.label}
            </text>
          ))}

          {SUPPLIES.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const dx = (x2 - x1) * 0.45;
            const on = hot === null || hot === e.from || hot === e.to;
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--text-hint)"
                strokeWidth={2}
                // Texture, not hue: the dashed links are the ones no disclosure
                // pairs by name. Colour is already spent on acceleration.
                strokeDasharray={e.confidence === "high" ? undefined : "4 4"}
                opacity={on ? 0.55 : 0.08}
                style={{ transition: "opacity 0.12s", cursor: "pointer" }}
                onMouseEnter={(ev) =>
                  show(ev, (
                    <div style={{ maxWidth: 320, whiteSpace: "normal" }}>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {e.fromName} sells into {e.toName}
                      </div>
                      <div style={{ marginTop: 2, color: "var(--text-hint)" }}>
                        {e.confidence === "high"
                          ? "A source names the buyer"
                          : "Inferred from stage structure — no disclosure pairs the two"}
                      </div>
                      <div style={{ marginTop: 4 }}>{e.evidence}</div>
                    </div>
                  ))
                }
                onMouseLeave={() => setTip(null)}
              />
            );
          })}

          {/* Containment, not supply. Wiwynn's revenue is INSIDE Wistron's, which
              is a different relation from selling to it, so it gets its own mark
              on the right edge rather than another link between the columns. */}
          {CONSOLIDATION.map((c) => {
            const p = pos.get(c.parent);
            const k = pos.get(c.child);
            if (!p || !k) return null;
            // A connector in the right margin rather than a bracket around the
            // two nodes: the crossing-minimised order does not put a parent next
            // to its child, and a bracket spanning them would visually enclose
            // whatever sits between - claiming a containment that is not there.
            const x = Math.max(p.x, k.x) + NODE_W;
            const yp = p.y + NODE_H / 2;
            const yk = k.y + NODE_H / 2;
            const out = 15;
            return (
              <g
                key={`c-${c.parent}-${c.child}`}
                style={{ cursor: "pointer" }}
                onMouseEnter={(ev) =>
                  show(ev, (
                    <div style={{ maxWidth: 300, whiteSpace: "normal" }}>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {c.parentName} consolidates {c.childName}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {c.childName}'s revenue is already inside {c.parentName}'s reported
                        figure, so totals across companies count it once. Each company's own
                        numbers are unaffected.
                      </div>
                    </div>
                  ))
                }
                onMouseLeave={() => setTip(null)}
              >
                <path
                  d={`M ${x} ${yk} C ${x + out} ${yk}, ${x + out} ${yp}, ${x} ${yp}`}
                  fill="none"
                  stroke="var(--text-hint)"
                  strokeWidth={1.5}
                />
                <text
                  x={x + out + 3}
                  y={(yp + yk) / 2 + 3}
                  fontSize={9}
                  fill="var(--text-hint)"
                >
                  inside
                </text>
              </g>
            );
          })}

          {[...left.nodes, ...right.nodes].map((n) => (
            <NodeBox
              key={n.ticker}
              node={n}
              dim={dimNode(n.ticker)}
              onEnter={(ev) => {
                setHot(n.ticker);
                const out = SUPPLIES.filter((e) => e.from === n.ticker).length;
                const inn = SUPPLIES.filter((e) => e.to === n.ticker).length;
                show(ev, (
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {n.name} <span style={{ color: "var(--text-hint)" }}>{n.ticker}</span>
                    </div>
                    <div style={{ marginTop: 2 }}>{n.bucket}</div>
                    <div>
                      Revenue:{" "}
                      {n.absent === "filter"
                        ? "not in the current filter"
                        : n.absent === "filing"
                          ? "did not file this month"
                          : revenue(n.revenue)}
                    </div>
                    <div>
                      Acceleration:{" "}
                      {n.absent === "prior"
                        ? "needs the prior month's YoY, which this month has none of"
                        : n.absent
                          ? NA
                          : ppt(n.accel)}
                    </div>
                    <div style={{ marginTop: 2, color: "var(--text-hint)" }}>
                      {out ? `sells into ${out} ` : ""}
                      {out && inn ? "· " : ""}
                      {inn ? `bought from by ${inn} ` : ""}
                      tracked {out + inn === 1 ? "company" : "companies"}
                    </div>
                  </div>
                ));
              }}
              onLeave={() => {
                setHot(null);
                setTip(null);
              }}
              onClick={() => onSelect(n.ticker)}
            />
          ))}
        </svg>
        {tip && <Tooltip tip={tip} width={box.current?.clientWidth ?? w} />}
      </div>

      {/* Coverage, on the chart rather than in a caption someone can skip. A map
          that showed only the connected 20 would look like a finished picture of
          the chain instead of a picture of what has been read out of filings. */}
      {unlinked.length > 0 && (
        <div
          style={{
            padding: "9px 12px 10px",
            borderTop: "1px solid var(--border)",
            fontSize: 10.5,
            lineHeight: 1.6,
            color: "var(--text-hint)",
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {unlinked.length} of {universe.length} tracked companies have no recorded supply link
          </span>{" "}
          — no customer or supplier has been read out of a filing for them yet. That is a
          gap in the research, not a claim that they sell to nobody:{" "}
          {unlinked.map((c, i) => (
            <span key={c.ticker}>
              {i > 0 && " · "}
              <span
                onClick={() => onSelect(c.ticker)}
                style={{
                  cursor: "pointer",
                  textDecoration: "underline",
                  textDecorationStyle: "dotted",
                }}
              >
                {c.name}
              </span>
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
          padding: "7px 12px",
          borderTop: "1px solid var(--border)",
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width="26" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="26" y2="3" stroke="var(--text-hint)" strokeWidth="2" />
          </svg>
          a source names the buyer
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width="26" height="6" aria-hidden="true">
            <line
              x1="0" y1="3" x2="26" y2="3"
              stroke="var(--text-hint)" strokeWidth="2" strokeDasharray="4 4"
            />
          </svg>
          inferred from stage structure
        </span>
      </div>

      {/* The same diverging scale the heatmaps use, so a red node here means what
          a red cell means there. Reused, not restated. */}
      <Legend metric="yoy_acceleration_ppt" />
    </>
  );
}
