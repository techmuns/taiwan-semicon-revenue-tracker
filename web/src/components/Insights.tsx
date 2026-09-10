/**
 * Insights - what changed this month, said in a sentence before it is shown in a table.
 *
 * WHAT THIS TAB GETS WRONG WHEN IT IS BUILT THE OBVIOUS WAY
 *
 * The arithmetic here has always been careful and the screen has always been
 * unreadable, which is a specific and common failure rather than a matter of
 * taste. The tab printed "Most unlike the others — +5.1 MAD — somewhat apart"
 * over a list ordered by a column that was not on screen, and hung four to six
 * lines of methodology under every card in 10px gray. Everything on it was
 * true. Nothing on it was legible: a reader could not tell whether the month
 * had been eventful without first learning what a median absolute deviation is.
 *
 * The redesign moves three things and changes no number:
 *
 *   1. THE FINDING IS A SENTENCE, AND IT IS FIRST. `standoutRead` in plain.ts
 *      assembles it from values already on screen - "AI Silicon slowed while
 *      most of the chain sped up" - and it is set in the largest type on the
 *      page. The tables underneath are the evidence for it, not a substitute.
 *   2. THE RANKING IS DRAWN, NOT JUST PRINTED. Rows are ordered by distance
 *      from the middle of the pack, so a column of raw values read as unsorted
 *      (71.7, 71.7, 67.8, 22.6, 64.4...). A diverging bar measured from the
 *      median puts the ordering on screen, where the eye can check it.
 *   3. THE METHODOLOGY FOLDS AWAY. It is one closed `<details>` on the one card
 *      whose unit needs explaining, not a footnote wall under all five. The
 *      caveat that matters - this is a RANKING, not a significance test - is
 *      still one click from the number it qualifies, and the unit on screen is
 *      now "x the typical gap", which needs less explaining than "MAD" did.
 *
 * WHAT IS DELIBERATELY NOT SAID
 *
 * The reason this is a cross-sectional ranking rather than a z-score alert is
 * unchanged and worth keeping written down. The window is seven months, and the
 * maximum |z| a sample of n=7 can produce is 2.268 - arithmetic, not data - so a
 * 3-sigma alert on a per-stage history CANNOT FIRE, and a 2-sigma one fires on
 * the series maximum or minimum and nothing else. Measured against the live
 * store: every |z| > 2 in the universe was a series max or min, and lag-1
 * autocorrelation was -0.310, so there is no trend to model underneath either.
 * So each stage is compared against THE OTHER STAGES IN THE SAME MONTH, and the
 * result is called a ranking, never a significant finding. Ten stages that share
 * customers and a cycle are too few, and too linked, for a false-positive rate
 * worth quoting.
 *
 * THE CARDS
 *
 *   The odd one out    the ranking, with every stage drawn against the median so
 *                      the gap between first and second is visible rather than
 *                      inferred from a badge.
 *   What's driving it  the largest filers inside that stage, with each one's
 *                      share drawn, because a stage moving on a 97% member is a
 *                      different fact from one moving on a 2% member.
 *   Segment            a named slice of the universe from config/segments.yaml.
 *                      Its figure is the members' TOTAL revenue, not their
 *                      revenue in that segment - stated on the card in those
 *                      words, because it is the single most misreadable number
 *                      on the tab.
 *   Counted once       the one consolidation pair, and the five holdings checked
 *                      and cleared - together, because the intuitive "big stake
 *                      means consolidated" rule is wrong and the counter-examples
 *                      belong beside the case where it happens to hold.
 *   Not on this page   why there is no supplier map. A hand-built one of 18 edges
 *                      used to sit here; most of its edges were inferred from
 *                      stage structure rather than disclosed, and no caveat makes
 *                      a guess safe to render beside filed revenue.
 */

import { WidgetCard } from "./WidgetCard";
import { EmptyState } from "./states";
import { NA, monthLabel, pct, ppt, revenue } from "../format";
import { forAggregate, forMonth, scoreLabel, standouts, sumRevenue, weightedYoY } from "../stats";
import { standoutRead, treatmentTip, wordingFor } from "../plain";
import { metricSpec } from "../scale";
import { CLEARED, CONSOLIDATION } from "../generated/relationships";
import { SEGMENTS } from "../generated/segments";
import type { AnalyticsRow, BucketCell, HeatmapMetric } from "../types";

/** Positive and negative arms of the diverging ramp, as bar fills. */
const BAR_UP = "var(--div-pos-2)";
const BAR_DOWN = "var(--div-neg-2)";

/** Signed ink for a figure. Red is up - the same Taiwanese convention as the heatmap. */
function inkFor(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "var(--text-hint)";
  return value >= 0 ? "var(--ink-up)" : "var(--ink-down)";
}

/*
 * The rank row.
 *
 * The stage column takes the larger share (1fr against the bar's 0.8fr) because
 * a fixed 168px clipped every long stage name mid-word - "Power / Data Center
 * Ele...", "Legacy / Mature Node Contro..." - and a truncated stage name in the
 * one card whose job is naming a stage is not a trade worth making for bar
 * width. Both are fractions so the split holds at one column and at two.
 *
 * The last column carries the multiple as a NUMBER rather than as the sentence
 * it used to: "a little outside the pack" needs ~140px to set, which this card
 * does not have beside two columns, so it wrapped or clipped on every row that
 * was not "with the pack". The bar beside it already says the same thing in a
 * form that cannot wrap, and the words survive on the row's title.
 */
const HEAD_ROW = "minmax(0, 1fr) minmax(80px, 0.8fr) 78px 62px";
const MEMBER_ROW = "minmax(0, 1fr) 118px 96px 88px";

/**
 * A bar measured from the MIDDLE of the pack, not from zero.
 *
 * The ranking is on distance from the median, so that is what the bar has to
 * draw: a bar from zero would order the rows by a quantity the list is not
 * sorted on, which is the defect this replaces rather than a different view of
 * it. Half the track per arm, scaled by the largest deviation in the month, so
 * the leader always reaches the end and the rest are read against it.
 */
function DeviationBar({ dev, maxDev }: { dev: number; maxDev: number }) {
  const width = maxDev > 0 ? (Math.abs(dev) / maxDev) * 50 : 0;
  const up = dev >= 0;
  return (
    <div
      style={{
        position: "relative",
        height: 15,
        background: "var(--track)",
        borderRadius: 3,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: -3,
          bottom: -3,
          width: 1,
          background: "var(--border-solid)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          [up ? "left" : "right"]: "50%",
          width: `${width}%`,
          background: up ? BAR_UP : BAR_DOWN,
          borderRadius: up ? "0 3px 3px 0" : "3px 0 0 3px",
        }}
      />
    </div>
  );
}

/** The month's finding, set as the page's own headline. Spans the grid. */
function Headline({
  latestMonth,
  metric,
  agg,
  read,
}: {
  latestMonth: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  read: { headline: string; detail: string } | null;
}) {
  const w = wordingFor(metric);
  return (
    <div style={{ gridColumn: "1 / -1", alignSelf: "start", padding: "0 2px 2px" }}>
      <div className="eyebrow">
        {latestMonth ? `${monthLabel(latestMonth)} · what changed` : "what changed"}
      </div>
      <h2
        style={{
          margin: "6px 0 0",
          fontSize: 24,
          lineHeight: 1.22,
          fontWeight: 650,
          letterSpacing: "-0.02em",
          color: "var(--text-primary)",
          textWrap: "pretty",
          maxWidth: 900,
        }}
      >
        {read ? read.headline : "Nothing to rank this month."}
      </h2>
      <p
        style={{
          margin: "7px 0 0",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--text-muted)",
          maxWidth: 820,
        }}
      >
        {read
          ? read.detail
          : "This metric needs a prior month or a prior year to compare against."}
      </p>
      <p
        style={{
          margin: "5px 0 0",
          fontSize: 11.5,
          lineHeight: 1.55,
          color: "var(--text-hint)",
          maxWidth: 820,
        }}
      >
        Stages are ranked on {w.meaning}{" "}
        {agg === "weighted"
          ? "Companies are weighted by revenue, so TSMC counts for more than a small supplier."
          : "Every company counts the same, whatever its size."}
      </p>
    </div>
  );
}

function StandoutStage({
  cells,
  latestMonth,
  metric,
}: {
  cells: BucketCell[] | null;
  latestMonth: string | null;
  metric: HeatmapMetric;
}) {
  const spec = metricSpec(metric);
  const w = wordingFor(metric);
  const fmt = (v: number | null) => (spec.unit === "ppt" ? ppt(v) : pct(v));
  const month = (cells ?? []).filter((c) => c.month === latestMonth && c.value !== null);
  const { ranked, median, mad, n } = standouts(month, (c) => c.value);
  const top = ranked[0];
  const label = scoreLabel(top?.score ?? null);
  const maxDev =
    median === null ? 0 : Math.max(...ranked.map((r) => Math.abs(r.value - median)), 0);

  // Every stage sharing the leader's ROUNDED score. Rounded, because that is
  // the number on screen, and two stages the reader sees as the same figure are
  // tied as far as they can tell - picking one by array order would present an
  // arbitrary choice as a finding.
  const tied =
    top?.score == null
      ? []
      : ranked.filter((r) => r.score != null && Math.abs(r.score - top.score!) < 0.05);

  return (
    <WidgetCard
      title="The odd one out"
      subtitle={
        n >= 2
          ? `${n} stages, ranked by distance from the middle of the pack`
          : "not enough stages to rank"
      }
      staticCard
    >
      {ranked.length === 0 || median === null ? (
        <EmptyState
          message="No stage has a value this month"
          hint="This metric needs a prior month or a prior year to compare against."
        />
      ) : (
        <>
          <div style={{ padding: "13px 14px 12px" }}>
            <div
              style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
            >
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 650,
                  letterSpacing: "-0.015em",
                  color: "var(--text-primary)",
                }}
              >
                {top?.item.bucket ?? NA}
              </div>
              <div
                className="tnum"
                style={{
                  fontSize: 18,
                  fontWeight: 650,
                  letterSpacing: "-0.015em",
                  color: inkFor(top?.value ?? null),
                }}
              >
                {fmt(top?.value ?? null)}
              </div>
              {label.apart && (
                <span
                  style={{
                    padding: "1px 8px",
                    borderRadius: 999,
                    fontSize: 10.5,
                    fontWeight: 600,
                    background: "var(--track)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {label.gap}
                </span>
              )}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--text-muted)",
              }}
            >
              The middle stage came in at{" "}
              <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
                {fmt(median)}
              </strong>
              , and stages typically sit{" "}
              <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
                {fmt(mad)}
              </strong>{" "}
              away from it. Bars below run from that middle: left is {w.barLeft}, right is{" "}
              {w.barRight}.
            </p>
            {/* A tie is not a winner. Naming it costs a line and stops the
                reader acting on the wrong stage. */}
            {tied.length > 1 && (
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: "var(--text-hint)",
                }}
              >
                {tied
                  .slice(1)
                  .map((t) => t.item.bucket)
                  .join(", ")}{" "}
                {tied.length > 2 ? "are" : "is"} exactly as far out — which of them leads is
                arbitrary.
              </p>
            )}
            {/* A one-member stage has no internal spread: its figure IS that
                company's figure, scored against stages that average five
                filers. Not wrong, but not the same kind of number. */}
            {top && top.item.members === 1 && (
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: "var(--text-hint)",
                }}
              >
                This stage has one company in it, so this is a single company's move rather
                than a stage average.
              </p>
            )}
          </div>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "8px 14px 3px",
              display: "grid",
              gridTemplateColumns: HEAD_ROW,
              gap: 12,
            }}
          >
            <div className="eyebrow">Stage</div>
            <div className="eyebrow" style={{ textAlign: "center" }}>
              {w.axis}
            </div>
            <div className="eyebrow" style={{ textAlign: "right" }}>
              {spec.unit === "ppt" ? "Change" : "Growth"}
            </div>
            <div
              className="eyebrow"
              style={{ textAlign: "right" }}
              title="How far from the middle, as a multiple of the typical gap between stages"
            >
              Gap
            </div>
          </div>

          {ranked.map((r, i) => {
            const rowLabel = scoreLabel(r.score);
            return (
              <div
                key={r.item.bucket}
                style={{
                  display: "grid",
                  gridTemplateColumns: HEAD_ROW,
                  gap: 12,
                  alignItems: "center",
                  padding: "7px 14px",
                  borderTop: "1px solid var(--border)",
                  background: i === 0 ? "var(--card-header-bg)" : undefined,
                }}
              >
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: i === 0 ? 600 : 400,
                    color: i === 0 ? "var(--text-primary)" : "var(--text-secondary)",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={r.item.bucket}
                >
                  {r.item.bucket}
                </div>
                <DeviationBar dev={r.value - median} maxDev={maxDev} />
                <div
                  className="tnum"
                  style={{
                    textAlign: "right",
                    fontSize: 12.5,
                    fontWeight: i === 0 ? 600 : 400,
                    color: i === 0 ? inkFor(r.value) : "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                  title={`${r.item.members_with_revenue} of ${r.item.members} companies filed`}
                >
                  {fmt(r.value)}
                </div>
                <div
                  className="tnum"
                  style={{
                    textAlign: "right",
                    fontSize: 11.5,
                    color: rowLabel.apart ? "var(--text-secondary)" : "var(--text-hint)",
                    fontWeight: rowLabel.apart ? 600 : 400,
                    whiteSpace: "nowrap",
                  }}
                  title={`${rowLabel.gap} — ${rowLabel.plain}`}
                >
                  {rowLabel.times === null ? NA : `${rowLabel.times.toFixed(1)}\u00d7`}
                </div>
              </div>
            );
          })}

          {/*
            The method, folded. It used to be an unfoldable 4-line footnote under
            every card on the tab; the caveat it carries is real, so it stays -
            one click from the number it qualifies, on the one card whose unit
            needs it, rather than as a wall under all five.
          */}
          <details style={{ borderTop: "1px solid var(--border)", padding: "9px 14px 11px" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-hint)",
                listStyle: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
              How “distance from the pack” is worked out
            </summary>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 11,
                lineHeight: 1.6,
                color: "var(--text-hint)",
                maxWidth: 660,
              }}
            >
              Each stage is scored (its value − the middle value) ÷ the typical distance from
              that middle, across the {n} stages in this month. The middle is {fmt(median)} and
              the typical distance is {fmt(mad)} — the median absolute deviation, if you want the
              term — so the stage at the top of the list sits{" "}
              {(label.times ?? 0).toFixed(1)} times further out than a stage usually does. This
              is a <strong style={{ color: "var(--text-muted)" }}>ranking, not a test</strong>:{" "}
              {n} stages that share customers and a cycle are too few, and too linked, for a
              false-positive rate worth quoting. Scoring a stage against its own seven-month
              history instead could not reach 3 sigma even in principle, which is why the
              comparison is made across stages.
            </p>
          </details>
        </>
      )}
    </WidgetCard>
  );
}

function InsideTheStage({
  rows,
  bucket,
  latestMonth,
  onSelect,
}: {
  rows: AnalyticsRow[];
  bucket: string | null;
  latestMonth: string | null;
  onSelect: (ticker: string) => void;
}) {
  const monthRows = forMonth(rows, latestMonth).filter(
    (r) => r.bucket === bucket && r.revenue_twd_thousands !== null,
  );
  // De-duplicated, because "the stage's revenue" is a sum and one member's
  // figure can be inside another's. The LIST below keeps everyone: each
  // company's own revenue is its own.
  const summable = forAggregate(monthRows);
  const stageTotal = sumRevenue(summable);
  const ranked = [...monthRows].sort(
    (a, b) => (b.revenue_twd_thousands ?? 0) - (a.revenue_twd_thousands ?? 0),
  );

  /**
   * A share is only meaningful for a company that is IN the denominator.
   *
   * The stage total is de-duplicated and the list is not - deliberately, since a
   * subsidiary's own revenue is real and belongs on screen. But dividing one by
   * the other for every row makes the column sum past 100%: on Rack / ODM this
   * month it reached 106.7%, with Wiwynn shown as a 6.7% slice of a total that
   * excludes it precisely because those 6.7 points are already inside Wistron's
   * 17.6%. So excluded rows get the containment label instead of a percentage.
   */
  const insideOf = new Map(CONSOLIDATION.map((c) => [c.child, c.parentName]));
  const biggest = [...summable].sort(
    (a, b) => (b.revenue_twd_thousands ?? 0) - (a.revenue_twd_thousands ?? 0),
  )[0];
  const shareOf = (r: AnalyticsRow): number | null =>
    stageTotal.value && !insideOf.has(r.ticker)
      ? ((r.revenue_twd_thousands ?? 0) / stageTotal.value) * 100
      : null;
  const topShare = biggest ? shareOf(biggest) : null;
  const rest = ranked.filter((r) => r.ticker !== biggest?.ticker);
  const restShare = rest.reduce((sum, r) => sum + (shareOf(r) ?? 0), 0);

  return (
    <WidgetCard
      title="What’s driving it"
      subtitle={
        bucket
          ? `Inside ${bucket}${latestMonth ? ` · ${monthLabel(latestMonth)}` : ""}`
          : "no stage to open"
      }
      staticCard
    >
      {ranked.length === 0 ? (
        <EmptyState
          message="No filings in this stage this month"
          hint="Either the stage's members have not filed yet, or a filter is excluding them."
        />
      ) : (
        <>
          <div style={{ padding: "13px 14px 12px" }}>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                textWrap: "pretty",
              }}
            >
              {biggest && topShare !== null && topShare >= 60 ? (
                <>
                  <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {bucket} is {biggest.company_name}.
                  </strong>{" "}
                  It is {topShare.toFixed(0)}% of the stage once overlaps are removed, so the
                  stage’s move is mostly its move
                  {rest.length > 0
                    ? ` — the other ${rest.length} together are ${restShare.toFixed(0)}%.`
                    : "."}
                </>
              ) : biggest && topShare !== null ? (
                <>
                  <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    No single company owns this stage.
                  </strong>{" "}
                  The largest, {biggest.company_name}, is {topShare.toFixed(0)}% of it, so the
                  stage’s move is a genuinely shared one.
                </>
              ) : (
                <>Every filer in this stage is already counted inside another member.</>
              )}
            </p>
          </div>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "8px 14px 3px",
              display: "grid",
              gridTemplateColumns: MEMBER_ROW,
              gap: 10,
            }}
          >
            <div className="eyebrow">Company</div>
            <div className="eyebrow" style={{ textAlign: "right" }}>
              Revenue
            </div>
            <div className="eyebrow" style={{ textAlign: "right" }}>
              Vs last year
            </div>
            <div className="eyebrow" style={{ textAlign: "right" }}>
              Change
            </div>
          </div>

          {ranked.slice(0, 6).map((r, i) => {
            const share = shareOf(r);
            return (
              <div
                key={r.ticker}
                onClick={() => onSelect(r.ticker)}
                title={`Open ${r.company_name}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: MEMBER_ROW,
                  gap: 10,
                  alignItems: "center",
                  padding: "8px 14px",
                  borderTop: "1px solid var(--border)",
                  cursor: "pointer",
                  background: i === 0 ? "var(--card-header-bg)" : undefined,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: i === 0 ? 600 : 400,
                      color: i === 0 ? "var(--text-primary)" : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.company_name}
                  </div>
                  {/* The share, drawn. A 97% member and a 2% member are not the
                      same kind of signal, and a column of percentages makes the
                      reader do that comparison in their head. */}
                  <div
                    style={{
                      marginTop: 4,
                      height: 5,
                      background: "var(--track)",
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${share ?? 0}%`,
                        minWidth: share === null || share === 0 ? 0 : 3,
                        background: "var(--primary)",
                        borderRadius: 3,
                      }}
                    />
                  </div>
                  <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-hint)" }}>
                    {r.ticker} · T{r.tier}
                    {insideOf.has(r.ticker)
                      ? ` · already counted inside ${insideOf.get(r.ticker)}`
                      : share !== null
                        ? ` · ${share.toFixed(1)}% of the stage`
                        : ""}
                  </div>
                </div>
                <div
                  className="tnum"
                  style={{
                    textAlign: "right",
                    fontSize: 12.5,
                    fontWeight: i === 0 ? 600 : 400,
                    color: i === 0 ? "var(--text-primary)" : "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {revenue(r.revenue_twd_thousands)}
                </div>
                <div
                  className="tnum"
                  style={{
                    textAlign: "right",
                    fontSize: 12.5,
                    color: inkFor(r.yoy_pct),
                    whiteSpace: "nowrap",
                  }}
                >
                  {pct(r.yoy_pct)}
                </div>
                <div
                  className="tnum"
                  style={{
                    textAlign: "right",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: inkFor(r.yoy_acceleration_ppt),
                    whiteSpace: "nowrap",
                  }}
                  title="Change in the year-on-year growth rate since last month"
                >
                  {ppt(r.yoy_acceleration_ppt)}
                </div>
              </div>
            );
          })}

          {/*
            The denominator, on screen.
            
            Every share in the column above is a fraction of this number and the
            summary sentence quotes it ("97% of the stage"), but it was never
            shown - so the one figure the card is arguing about was the one
            figure a reader could not check. It is the de-duplicated sum, which
            is why the count beside it can be lower than the rows listed.
          */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: MEMBER_ROW,
              gap: 10,
              alignItems: "center",
              padding: "9px 14px",
              borderTop: "1px solid var(--border-solid)",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Stage total{" "}
              <span style={{ color: "var(--text-hint)" }}>
                · {stageTotal.n} counted
                {ranked.length > summable.length
                  ? `, ${ranked.length - summable.length} already inside another`
                  : ""}
              </span>
            </div>
            <div
              className="tnum"
              style={{
                textAlign: "right",
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-secondary)",
                whiteSpace: "nowrap",
              }}
            >
              {revenue(stageTotal.value)}
            </div>
            <div />
            <div />
          </div>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "9px 14px 11px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-hint)",
            }}
          >
            Being big does not make a company the cause — a stage can turn on a small member.
            {ranked.length > summable.length
              ? " Rows marked as already counted have no share of their own: their revenue is real, it is just inside another member’s filing."
              : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}

function SegmentPilot({
  rows,
  latestMonth,
  onSelect,
}: {
  rows: AnalyticsRow[];
  latestMonth: string | null;
  onSelect: (ticker: string) => void;
}) {
  return (
    <>
      {SEGMENTS.map((seg) => {
        const members = new Set(seg.members);
        const monthRows = forMonth(rows, latestMonth).filter((r) => members.has(r.ticker));
        // Same rule as the universe total: a segment may name both a parent and
        // the subsidiary inside it, because membership is a claim about which
        // businesses belong to the theme - and the arithmetic is not allowed to
        // be wrong because of how that claim was written.
        const summable = forAggregate(monthRows);
        const total = sumRevenue(summable);
        const growth = weightedYoY(summable);
        const filed = monthRows.filter((r) => r.revenue_twd_thousands !== null).length;
        const present = new Set(monthRows.map((r) => r.ticker));
        const missing = seg.members.filter((t) => !present.has(t));
        const folded = filed - total.n;
        const insideNames = CONSOLIDATION.filter(
          (c) => members.has(c.child) && members.has(c.parent),
        );

        return (
          <WidgetCard
            key={seg.key}
            title={seg.label}
            subtitle={
              `A named slice of the chain · ${seg.members.length} companies` +
              (latestMonth ? ` · ${monthLabel(latestMonth)}` : "")
            }
            actions={
              <span style={{ fontSize: 11, color: "var(--text-hint)" }}>
                {missing.length
                  ? `${missing.length} of ${seg.members.length} not in view`
                  : `all ${seg.members.length} have filed`}
              </span>
            }
            full
            staticCard
            fit
          >
            {total.value === null ? (
              <EmptyState
                message="No member has filed for this month"
                hint="Or the current filter excludes them - segment membership does not override a filter."
              />
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                    gap: 1,
                    background: "var(--border)",
                  }}
                >
                  <div style={{ background: "var(--card-bg)", padding: "13px 16px 14px" }}>
                    <div className="eyebrow">Combined revenue</div>
                    <div
                      className="tnum"
                      style={{
                        marginTop: 4,
                        fontSize: 24,
                        fontWeight: 650,
                        letterSpacing: "-0.02em",
                        lineHeight: 1.15,
                      }}
                    >
                      {revenue(total.value)}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 11, color: "var(--text-hint)" }}>
                      {total.n} filings added up.
                      {folded > 0 && insideNames[0]
                        ? ` ${insideNames[0].childName} sits inside ${insideNames[0].parentName}, so it is counted once.`
                        : ""}
                    </div>
                  </div>
                  <div style={{ background: "var(--card-bg)", padding: "13px 16px 14px" }}>
                    <div className="eyebrow">Growth vs a year ago</div>
                    <div
                      className="tnum"
                      style={{
                        marginTop: 4,
                        fontSize: 24,
                        fontWeight: 650,
                        letterSpacing: "-0.02em",
                        lineHeight: 1.15,
                        color: inkFor(growth.value),
                      }}
                    >
                      {pct(growth.value)}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 11, color: "var(--text-hint)" }}>
                      Weighted by size, so the largest members move it most.
                    </div>
                  </div>
                  {/*
                    The single most misreadable number on this tab, and the one
                    line that stops it being misread. `basis` from the config is
                    two sentences of methodology; what a reader needs is what the
                    figure is NOT, said first.
                  */}
                  <div style={{ background: "var(--card-bg)", padding: "13px 16px 14px" }}>
                    <div className="eyebrow">What this is not</div>
                    <div
                      style={{
                        marginTop: 5,
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: "var(--text-secondary)",
                      }}
                    >
                      <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        Not an AI revenue figure.
                      </strong>{" "}
                      It is these {seg.members.length} companies’ <em>total</em> revenue —
                      monthly filings do not split out products.
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    padding: "10px 14px 12px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span className="eyebrow" style={{ marginRight: 3 }}>
                    Members
                  </span>
                  {seg.members.map((t) => {
                    const row = monthRows.find((r) => r.ticker === t);
                    return (
                      <span
                        key={t}
                        onClick={() => onSelect(t)}
                        title={row ? `Open ${row.company_name}` : "Not in the current filter"}
                        style={{
                          cursor: "pointer",
                          padding: "3px 9px",
                          borderRadius: 999,
                          fontSize: 11,
                          background: "var(--track)",
                          color: row ? "var(--text-secondary)" : "var(--text-hint)",
                          opacity: row ? 1 : 0.7,
                        }}
                      >
                        {row?.company_name ?? t}
                      </span>
                    );
                  })}
                </div>
              </>
            )}
          </WidgetCard>
        );
      })}
    </>
  );
}

/**
 * Consolidation, and the five holdings that look like it and are not.
 *
 * Shown together on purpose. The intuitive rule - a big stake means the revenue
 * is inside the parent's - is wrong, and these are the counter-examples sitting
 * beside the one pair where it happens to hold. Someone who sees only "Wistron
 * consolidates Wiwynn" and knows TSMC owns a third of GUC will reasonably
 * conclude the dashboard has missed one.
 *
 * WHY THIS IS NOT A TABLE.
 *
 * It was, twice, and both times it failed the same way. Five full-width rows,
 * each holding one short sentence and one citation, put a statement on the left
 * edge of a 1350px card and its source on the right edge with nothing between
 * them - so the eye had to travel the width of the screen to join two halves of
 * one fact, and two of the five citations wrapped, making the row heights ragged
 * on top of it. A table earns its shape when rows are compared COLUMN BY COLUMN.
 * Nobody compares these: each is a self-contained verdict about one pair, read
 * once. That is a card.
 *
 * So the five are cards in a grid - all five side by side on a wide screen,
 * folding to fewer as it narrows - and the consolidation pair above them is
 * drawn rather than asserted: a bar the width of the parent's filing with the
 * child's revenue nested inside it, at its true share. "Already inside" is a
 * containment relationship, and a picture of containment says it faster than a
 * sentence can.
 */
function Overlaps({ rows, latestMonth }: { rows: AnalyticsRow[]; latestMonth: string | null }) {
  const monthRows = forMonth(rows, latestMonth);
  const revenueOf = (ticker: string) =>
    monthRows.find((r) => r.ticker === ticker)?.revenue_twd_thousands ?? null;

  return (
    <WidgetCard
      title="Counted once, not twice"
      subtitle="Where one tracked company’s revenue already sits inside another’s"
      full
      staticCard
      fit
    >
      {CONSOLIDATION.length === 0 ? (
        <EmptyState
          message="No relationships recorded"
          hint="Add them to config/relationships.yaml and run `twrev validate --write`."
        />
      ) : (
        <>
          {CONSOLIDATION.map((c) => {
            const childRev = revenueOf(c.child);
            const parentRev = revenueOf(c.parent);
            // The child's share of what the parent REPORTS - which is the whole
            // point, since the parent's figure is the one that already contains
            // it. Null on either side means no bar: an invented width here would
            // be a picture of a number nobody filed.
            const share =
              childRev !== null && parentRev !== null && parentRev > 0
                ? (childRev / parentRev) * 100
                : null;
            return (
              <div key={`${c.parent}-${c.child}`} style={{ padding: "13px 14px 14px" }}>
                <div className="eyebrow">The one real overlap</div>
                {share !== null && (
                  <div style={{ marginTop: 9, marginBottom: 11, maxWidth: 820 }}>
                    {/* The parent's filing, drawn as a bar, with the child nested
                        inside it at its true share. */}
                    <div
                      style={{
                        position: "relative",
                        height: 42,
                        borderRadius: 7,
                        background: "var(--track)",
                        border: "1px solid var(--border-solid)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: `${share}%`,
                          background: "var(--primary-light)",
                          borderRight: "1px solid var(--primary)",
                        }}
                      />
                      <div
                        style={{
                          position: "relative",
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "0 12px",
                          gap: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: "var(--primary-text)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {c.childName} {revenue(childRev)}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: "var(--text-secondary)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.parentName} reports {revenue(parentRev)}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 5, fontSize: 10.5, color: "var(--text-hint)" }}>
                      {c.childName} is {share.toFixed(0)}% of what {c.parentName} reports
                      {latestMonth ? ` · ${monthLabel(latestMonth)}` : ""}
                    </div>
                  </div>
                )}
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: "var(--text-secondary)",
                    textWrap: "pretty",
                    maxWidth: 900,
                  }}
                >
                  <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    Add the two filings together and {c.childName} is counted twice.
                  </strong>{" "}
                  So every total on this dashboard counts it once — but {c.childName} keeps its
                  own row, and its own growth figures are untouched.
                </p>
              </div>
            );
          })}

          {CLEARED.length > 0 && (
            <>
              <div style={{ borderTop: "1px solid var(--border)", padding: "13px 14px 4px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>
                  These {CLEARED.length} look like overlaps. They are not.
                </div>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    color: "var(--text-muted)",
                    maxWidth: 820,
                  }}
                >
                  Owning a big stake does not put the revenue inside the parent’s filing. Each was
                  checked against the document that states the accounting treatment, and in every
                  case both companies report their revenue separately.
                </p>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(238px, 1fr))",
                  gap: 10,
                  padding: "10px 14px 14px",
                }}
              >
                {CLEARED.map((c) => {
                  // `stake` is free text from config and can carry several figures
                  // at several dates ("28% at FY2025, 27.6% at 2026-02-28, ~19%
                  // after the May 2026 sale"). The leading percentage is the card's
                  // headline; whatever qualifies it follows, in its own words.
                  const head = c.stake.match(/^~?\s*[\d.]+\s*%/);
                  const pctText = head ? head[0].trim() : c.stake;
                  const qualifier = head
                    ? c.stake.slice(head[0].length).replace(/^[\s,·-]+/, "")
                    : "";
                  return (
                    <div
                      key={`${c.parent}-${c.child}`}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: "var(--card-body-bg)",
                        padding: "10px 12px 11px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {c.parentName} holds
                      </div>
                      <div
                        className="tnum"
                        style={{
                          fontSize: 21,
                          fontWeight: 650,
                          letterSpacing: "-0.02em",
                          lineHeight: 1.15,
                          color: "var(--text-primary)",
                        }}
                      >
                        {pctText}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        of {c.childName}
                      </div>
                      {qualifier && (
                        <div
                          style={{
                            marginTop: 2,
                            fontSize: 10.5,
                            lineHeight: 1.45,
                            color: "var(--text-hint)",
                          }}
                        >
                          {qualifier}
                        </div>
                      )}
                      {/*
                        The treatment, not a repeated verdict. Five identical
                        "counted separately" labels would restate the heading
                        five times; these two differ - an equity-method holder
                        books a share of the PROFIT, a passive holder books
                        nothing - and the difference is the reason neither one
                        puts revenue in the parent.
                      */}
                      <div
                        style={{
                          marginTop: "auto",
                          paddingTop: 9,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--text-secondary)",
                        }}
                        title={treatmentTip(c.treatment)}
                      >
                        {c.treatment === "equity_method"
                          ? "Stake only"
                          : c.treatment === "fvoci"
                            ? "Passive holding"
                            : c.treatment}
                        <span style={{ fontWeight: 400, color: "var(--text-hint)" }}>
                          {" "}
                          · no revenue moves
                        </span>
                      </div>
                      {/* An accounting treatment is a fact about a date, and one
                          of these is already known to have moved on. A bare label
                          read as present tense is what this line exists to
                          prevent. */}
                      <div
                        style={{
                          marginTop: 6,
                          paddingTop: 7,
                          borderTop: "1px solid var(--border)",
                          fontSize: 10,
                          lineHeight: 1.4,
                          color: "var(--text-hint)",
                        }}
                      >
                        {/*
                          Two lines of citation, reserved.

                          Three of the five citations wrap and two do not, so
                          without a floor the treatment line above sits ~8px
                          higher on the short cards and the row of five footers
                          steps up and down. The floor goes on the TEXT rather
                          than on the bordered box: 2 x 10px x 1.4 line-height is
                          exactly two lines, and stays right if the box's padding
                          ever changes.
                        */}
                        <div style={{ minHeight: 28 }}>{c.asOf}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </WidgetCard>
  );
}

/**
 * Why there is no supplier map, and no competitor list.
 *
 * A hand-built map of 18 edges used to sit here as a card of its own, whose
 * whole body read "Paid data required." - a large empty box saying nothing. It
 * is a footer note, so it is drawn as one.
 *
 * The gap is in the SOURCE. Taiwan's monthly filing names no counterparty, and
 * the annual reports anonymise it ("Customer A - 60.16%"), so no amount of
 * scraping closes it. Most of the removed edges carried the evidence line
 * "inferred from stage structure; not itemised in a disclosure" - an honest
 * label on a guess, and a guess rendered beside filed revenue reads as a fact.
 */
function NotOnThisPage() {
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        alignSelf: "start",
        border: "1px dashed var(--border-solid)",
        borderRadius: "var(--radius-card)",
        padding: "12px 16px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 190px) minmax(0, 1fr)",
        gap: 18,
        alignItems: "start",
      }}
    >
      <div>
        <div className="eyebrow">Not on this page</div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          Who sells to whom
        </div>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 11.5,
          lineHeight: 1.6,
          color: "var(--text-hint)",
          maxWidth: 900,
        }}
      >
        There is no supplier → customer map here because the filings do not contain one.
        Taiwan’s monthly revenue filing names no counterparty, and annual reports anonymise it —
        “Customer A — 60.2%”. Buying the data is the only way to get it right, and a guessed map
        beside filed revenue reads as fact. Competitors are not listed either: a competitor pair
        is two companies in the same stage, which every screen already shows.
      </p>
    </div>
  );
}

export function Insights({
  rows,
  bucketCells,
  latestMonth,
  metric,
  agg,
  onSelect,
}: {
  rows: AnalyticsRow[];
  bucketCells: BucketCell[] | null;
  latestMonth: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  onSelect: (ticker: string) => void;
}) {
  const month = (bucketCells ?? []).filter((c) => c.month === latestMonth && c.value !== null);
  const { ranked, median } = standouts(month, (c) => c.value);
  const standoutBucket = ranked[0]?.item.bucket ?? null;
  const read = standoutRead(metric, ranked, median);

  return (
    <>
      <Headline latestMonth={latestMonth} metric={metric} agg={agg} read={read} />
      <StandoutStage cells={bucketCells} latestMonth={latestMonth} metric={metric} />
      <InsideTheStage
        rows={rows}
        bucket={standoutBucket}
        latestMonth={latestMonth}
        onSelect={onSelect}
      />
      <SegmentPilot rows={rows} latestMonth={latestMonth} onSelect={onSelect} />
      <Overlaps rows={rows} latestMonth={latestMonth} />
      <NotOnThisPage />
    </>
  );
}
