/**
 * Insights - what stands out this month, and who inside it is big enough to matter.
 *
 * THE HONEST VERSION OF "ABNORMAL"
 *
 * The obvious build for this tab is a z-score alert: flag the stage more than
 * three standard deviations from its own history. That is not available here,
 * and it is worth writing down why rather than shipping it and hoping.
 *
 * The window is seven months. The maximum |z| a sample of n=7 can produce is
 * 2.268 - it is a property of the arithmetic, not of this data - so a 3-sigma
 * alert on a per-stage history CANNOT FIRE, ever, and a 2-sigma one fires on
 * the series maximum or minimum and nothing else. Measured against the live
 * store: every |z| > 2 in the universe was a series max or min, and lag-1
 * autocorrelation was -0.310, so there is no trend to model underneath either.
 * A panel built that way would look like statistics and be a relabelled
 * "highest month so far".
 *
 * So this compares each stage against THE OTHER STAGES IN THE SAME MONTH, using
 * the median and MAD, and calls the result what it is: a ranking in MAD units.
 * Ten stages is still far too few to quote a false-positive rate for and they
 * are not independent draws - they share customers and a cycle - so the panel
 * says "most unlike the others" and never says "significant". The question it
 * answers is real; the one it declines is the one it cannot.
 *
 * THE THREE PANELS
 *
 *   Standout stage   the ranking above, with the median and MAD it was measured
 *                    against, and every stage listed so the reader can see the
 *                    gap between first and second rather than trusting a badge.
 *   Inside it        the largest filer in that stage this month, because a
 *                    stage moving on its biggest member is a different fact from
 *                    a stage moving on its smallest.
 *   Segment pilot    a named slice of the universe from config/segments.yaml.
 *                    Its figure is the members' TOTAL revenue, not their revenue
 *                    in that segment; `basis` says so and is always rendered.
 *   Relationships    the one consolidation pair, and the holdings checked and
 *                    cleared - shown together because the intuitive "big stake
 *                    means consolidated" rule is wrong and the counter-examples
 *                    belong next to the case where it happens to hold.
 *   Supply data gap  where a supplier -> customer map would go, and why there is
 *                    not one. A hand-built map of 18 edges used to sit here; it
 *                    was removed because most of its edges were inferred from
 *                    stage structure rather than disclosed, and no caveat makes
 *                    a guess safe to render beside filed revenue.
 */

import { WidgetCard } from "./WidgetCard";
import { EmptyState } from "./states";
import { NA, monthLabel, pct, ppt, revenue } from "../format";
import { forAggregate, forMonth, scoreLabel, standouts, sumRevenue, weightedYoY } from "../stats";
import { cellStyle, metricSpec } from "../scale";
import { CLEARED, CONSOLIDATION, consolidationNote } from "../generated/relationships";
import { SEGMENTS } from "../generated/segments";
import type { AnalyticsRow, BucketCell, HeatmapMetric } from "../types";


function Row({
  label,
  sub,
  value,
  metric,
  emphasis,
  onClick,
}: {
  label: string;
  sub: string;
  value: number | null;
  metric: HeatmapMetric;
  emphasis?: boolean;
  onClick?: () => void;
}) {
  const spec = metricSpec(metric);
  return (
    <tr
      onClick={onClick}
      style={{
        borderBottom: "1px solid var(--border)",
        cursor: onClick ? "pointer" : undefined,
        background: emphasis ? "var(--card-header-bg)" : undefined,
      }}
    >
      <td style={{ padding: "5px 8px 5px 14px" }}>
        <div style={{ fontWeight: emphasis ? 600 : 500, color: "var(--text-primary)" }}>
          {label}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-hint)" }}>{sub}</div>
      </td>
      <td
        className="tnum"
        style={{
          ...cellStyle(value, metric),
          padding: "5px 10px",
          textAlign: "right",
          width: 96,
          whiteSpace: "nowrap",
          fontWeight: 600,
        }}
      >
        {spec.unit === "ppt" ? ppt(value) : pct(value)}
      </td>
    </tr>
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
  const month = (cells ?? []).filter((c) => c.month === latestMonth && c.value !== null);
  const { ranked, median, mad, n } = standouts(month, (c) => c.value);
  const top = ranked[0];
  // Every stage sharing the leader's ROUNDED score - rounded, because that is
  // the number on screen, and two stages the reader sees as "+1.5 MAD" are
  // tied as far as they can tell.
  const tied =
    top?.score == null
      ? []
      : ranked.filter(
          (r) => r.score != null && Math.abs(r.score - top.score!) < 0.05,
        );

  return (
    <WidgetCard
      title="Standout stage"
      subtitle={
        latestMonth
          ? `${monthLabel(latestMonth)} · ${spec.label} vs the other stages that month` +
            ` · ordered by distance from the median, not by ${spec.label}`
          : "no month loaded"
      }
      staticCard
      footnote={
        n >= 2 && median !== null
          ? `A RANKING, NOT A TEST. Each stage is scored (value − median) ÷ MAD against ` +
            `the other ${n - 1} stages in this month. Median ` +
            `${spec.unit === "ppt" ? ppt(median) : pct(median)}, MAD ` +
            `${spec.unit === "ppt" ? ppt(mad) : pct(mad)}. With ${n} stages — which share ` +
            `customers and a cycle, and are not independent draws — no threshold here has a ` +
            `false-positive rate worth quoting. A z-score against a stage's own short history ` +
            `could not reach 3 even in principle, which is why this is cross-sectional.`
          : null
      }
    >
      {ranked.length === 0 ? (
        <EmptyState
          message="No stage has a value this month"
          hint="This metric needs a prior month or a prior year to compare against."
        />
      ) : (
        <>
          <div style={{ padding: "10px 14px 8px" }}>
            <div className="eyebrow">Most unlike the others</div>
            <div
              style={{
                marginTop: 3,
                fontSize: 17,
                fontWeight: 600,
                color: "var(--text-primary)",
                lineHeight: 1.2,
              }}
            >
              {top?.item.bucket ?? NA}
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-hint)" }}>
              {top
                ? `${spec.unit === "ppt" ? ppt(top.value) : pct(top.value)} · ` +
                  `${scoreLabel(top.score).text} · ${scoreLabel(top.score).words}`
                : "—"}
            </div>
            {/* A tie is not a winner. Two stages on the same rounded score are
                equally unlike the others, and picking one by array order
                presents an arbitrary choice as a finding. Naming the tie costs
                a line and stops the reader acting on the wrong stage. */}
            {tied.length > 1 && (
              <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)" }}>
                Tied at {scoreLabel(top?.score ?? null).text} with{" "}
                {tied.slice(1).map((t) => t.item.bucket).join(", ")} — the pick between them
                is arbitrary.
              </div>
            )}
            {/* A one-member stage has no internal spread: its "stage
                acceleration" IS that company's acceleration, scored here
                against stages that average five filers. Not wrong, but not the
                same kind of number, and the card should not pretend it is. */}
            {top && top.item.members === 1 && (
              <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)" }}>
                One member only — this is a single company's move, not a stage average.
              </div>
            )}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {ranked.map((r, i) => (
                <Row
                  key={r.item.bucket}
                  label={r.item.bucket}
                  sub={
                    // Ranked by |MAD|, but the eye follows the big metric
                    // figure on the right, so the list read as unsorted: 71.7,
                    // 71.7, 67.8, 22.6, 64.4... An explicit rank says which
                    // number the order is actually on.
                    `#${i + 1} · ` +
                    `${scoreLabel(r.score).text}` +
                    ` · ${r.item.members_with_revenue} filed, ${r.item.members} comparable` +
                    (r.item.members === 1 ? " (single company)" : "")
                  }
                  value={r.value}
                  metric={metric}
                  emphasis={i === 0}
                />
              ))}
            </tbody>
          </table>
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
  // figure can be inside another's. The RANKING below is over the individual
  // filers and keeps everyone: each company's own revenue is its own.
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
   * 17.6%. So excluded rows get the containment label instead of a percentage,
   * and the footnote describes the largest SUMMABLE filer, which is the largest
   * company the denominator actually contains.
   */
  const insideOf = new Map(CONSOLIDATION.map((c) => [c.child, c.parentName]));
  const biggest = [...summable].sort(
    (a, b) => (b.revenue_twd_thousands ?? 0) - (a.revenue_twd_thousands ?? 0),
  )[0];
  const shareOf = (r: AnalyticsRow): number | null =>
    stageTotal.value && !insideOf.has(r.ticker)
      ? ((r.revenue_twd_thousands ?? 0) / stageTotal.value) * 100
      : null;

  return (
    <WidgetCard
      title="Inside that stage"
      subtitle={
        bucket
          ? `${bucket} · largest filers by revenue${
              latestMonth ? ` · ${monthLabel(latestMonth)}` : ""
            }`
          : "no stage to open"
      }
      staticCard
      footnote={
        biggest && stageTotal.value
          ? `${biggest.company_name} is ${(shareOf(biggest) ?? 0).toFixed(0)}% of the stage's ` +
            `de-duplicated revenue this month, so the stage's move is largely its move. Share ` +
            `is a level, not a driver: a stage can inflect on a small member.` +
            (ranked.length > summable.length
              ? ` Rows marked “inside” are already counted within another member and so have ` +
                `no share of their own — their revenue is real, it is just not a separate ` +
                `slice of this stage.`
              : "")
          : null
      }
    >
      {ranked.length === 0 ? (
        <EmptyState
          message="No filings in this stage this month"
          hint="Either the stage's members have not filed yet, or a filter is excluding them."
        />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {ranked.slice(0, 6).map((r, i) => (
              <tr
                key={r.ticker}
                onClick={() => onSelect(r.ticker)}
                style={{
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  background: i === 0 ? "var(--card-header-bg)" : undefined,
                }}
                title={`Open ${r.company_name}`}
              >
                <td style={{ padding: "5px 8px 5px 14px" }}>
                  <div style={{ fontWeight: i === 0 ? 600 : 500, color: "var(--text-primary)" }}>
                    {r.company_name}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-hint)" }}>
                    {r.ticker} · T{r.tier}
                    {insideOf.has(r.ticker)
                      ? ` · inside ${insideOf.get(r.ticker)}`
                      : shareOf(r) !== null
                        ? ` · ${(shareOf(r) as number).toFixed(1)}% of the stage`
                        : ""}
                  </div>
                </td>
                <td
                  className="tnum"
                  style={{
                    padding: "5px 8px",
                    textAlign: "right",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                  title="Revenue this month"
                >
                  {revenue(r.revenue_twd_thousands)}
                </td>
                <td
                  className="tnum"
                  style={{
                    padding: "5px 8px",
                    textAlign: "right",
                    width: 66,
                    color: "var(--text-secondary)",
                  }}
                  title="Year-on-year growth"
                >
                  {pct(r.yoy_pct)}
                </td>
                <td
                  className="tnum"
                  style={{
                    ...cellStyle(r.yoy_acceleration_ppt, "yoy_acceleration_ppt"),
                    padding: "5px 10px",
                    textAlign: "right",
                    width: 92,
                    whiteSpace: "nowrap",
                    fontWeight: 600,
                  }}
                  title="Change in the YoY rate vs the prior month"
                >
                  {ppt(r.yoy_acceleration_ppt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

        return (
          <WidgetCard
            key={seg.key}
            title={seg.label}
            subtitle={
              `${seg.members.length} companies across the chain` +
              (latestMonth ? ` · ${monthLabel(latestMonth)}` : "")
            }
            full
            staticCard
            footnote={seg.basis}
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
                    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                    gap: 1,
                    background: "var(--border)",
                  }}
                >
                  <div style={{ background: "var(--card-bg)", padding: "9px 12px 10px" }}>
                    <div className="eyebrow">Segment revenue</div>
                    <div
                      className="tnum"
                      style={{ marginTop: 3, fontSize: 19, fontWeight: 600, lineHeight: 1.2 }}
                    >
                      {revenue(total.value)}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)" }}>
                      sum of {total.n} filings
                      {filed - total.n > 0 ? ` · ${filed - total.n} inside another filer` : ""}
                    </div>
                  </div>
                  <div style={{ background: "var(--card-bg)", padding: "9px 12px 10px" }}>
                    <div className="eyebrow">Segment YoY</div>
                    <div
                      className="tnum"
                      style={{
                        marginTop: 3,
                        fontSize: 19,
                        fontWeight: 600,
                        lineHeight: 1.2,
                        color:
                          growth.value === null
                            ? "var(--text-primary)"
                            : growth.value >= 0
                              ? "var(--ink-up)"
                              : "var(--ink-down)",
                      }}
                    >
                      {pct(growth.value)}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)" }}>
                      revenue-weighted · n={growth.n}
                    </div>
                  </div>
                  <div style={{ background: "var(--card-bg)", padding: "9px 12px 10px" }}>
                    <div className="eyebrow">Coverage</div>
                    <div
                      className="tnum"
                      style={{ marginTop: 3, fontSize: 19, fontWeight: 600, lineHeight: 1.2 }}
                    >
                      {filed}/{seg.members.length}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-hint)" }}>
                      {missing.length
                        ? `${missing.length} not in the current filter`
                        : "every member is in view"}
                    </div>
                  </div>
                </div>
                <div style={{ padding: "8px 14px 10px", fontSize: 11, lineHeight: 1.5 }}>
                  <span style={{ color: "var(--text-hint)" }}>Members: </span>
                  {seg.members.map((t, i) => {
                    const row = monthRows.find((r) => r.ticker === t);
                    return (
                      <span key={t}>
                        {i > 0 && <span style={{ color: "var(--text-hint)" }}> · </span>}
                        <span
                          onClick={() => onSelect(t)}
                          style={{
                            cursor: "pointer",
                            textDecoration: "underline",
                            textDecorationStyle: "dotted",
                            color: row ? "var(--text-secondary)" : "var(--text-hint)",
                          }}
                          title={row ? `Open ${row.company_name}` : "Not in the current filter"}
                        >
                          {row?.company_name ?? t}
                        </span>
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

function Relationships() {
  const note = consolidationNote();
  return (
    <WidgetCard
      title="Company relationships"
      subtitle="Verified links between tracked companies · used to de-duplicate totals"
      full
      staticCard
      fit
      footnote={note}
    >
      {CONSOLIDATION.length === 0 ? (
        <EmptyState
          message="No relationships recorded"
          hint="Add them to config/relationships.yaml and run `twrev validate --write`."
        />
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {CONSOLIDATION.map((c) => (
                <tr key={`${c.parent}-${c.child}`} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px 6px 14px" }}>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {c.parentName} consolidates {c.childName}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-hint)" }}>
                      {c.parent} → {c.child} · {c.childName} is removed from sums, never from its
                      own rows
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            The cleared pairs are shown, not hidden. The intuitive rule - a big
            stake means the revenue is inside the parent's - is wrong, and these
            are the counter-examples sitting right beside the one pair where it
            happens to hold. Someone who sees only "Wistron consolidates Wiwynn"
            and knows TSMC owns a third of GUC will reasonably conclude the
            dashboard has missed one.
          */}
          {CLEARED.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)" }}>
              <div
                className="eyebrow"
                style={{ padding: "8px 14px 2px", color: "var(--text-hint)" }}
              >
                Checked and cleared — held, not consolidated
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {CLEARED.map((c) => (
                    <tr key={`${c.parent}-${c.child}`}>
                      <td style={{ padding: "3px 8px 3px 14px", color: "var(--text-secondary)" }}>
                        {c.parentName} → {c.childName}
                        <span style={{ color: "var(--text-hint)" }}> · {c.stake}</span>
                      </td>
                      <td
                        style={{
                          padding: "3px 14px 3px 8px",
                          textAlign: "right",
                          fontSize: 10.5,
                          color: "var(--text-hint)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.treatment === "equity_method"
                          ? "equity method"
                          : c.treatment === "fvoci"
                            ? "fair value, passive"
                            : c.treatment}{" "}
                        — not inside the parent
                        {/* An accounting treatment is a fact about a date, and
                            one of these is already known to have moved on. A
                            bare "equity method" read as present tense is the
                            thing this line exists to prevent. */}
                        <div style={{ opacity: 0.75, fontSize: 10 }}>per {c.asOf}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/*
            This card is ONLY about consolidation - which company's revenue is
            already inside another's, and therefore must not be added twice. It
            is the one relationship on this dashboard that changes a number.

            The supplier / competitor graph is a different thing and is not here.
            Those edges would drive "a related company moved sharply, check this
            one" flags, and an edge asserted from stage structure rather than a
            disclosure produces confident-looking alerts founded on a guess -
            which on a page whose whole claim is that every figure states its
            basis is worse than no alerts at all. The card below says what it
            would take to have them for real: buying the data.
          */}
          <div
            style={{
              padding: "8px 14px 10px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-hint)",
              borderTop: "1px solid var(--border)",
            }}
          >
            Competitors are not listed separately: every competitor pair is two companies
            in the same stage, which <code>config/universe.yaml</code> already records and
            every screen already shows. A second copy of that fact could only drift from
            the first. Supplier and customer links are a different problem &mdash; see the
            card below.
          </div>
        </>
      )}
    </WidgetCard>
  );
}

/**
 * Where a supplier -> customer map would go.
 *
 * A hand-built map of 18 edges used to sit here. It was removed because most of
 * its edges carried the evidence line "inferred from stage structure; not
 * itemised in a disclosure" - an honest label on a guess, and a guess rendered
 * beside filed revenue reads as a fact.
 *
 * The gap is in the SOURCE. Taiwan's monthly filing names no counterparty, and
 * the annual reports anonymise it ("Customer A - 60.16%"), so no amount of
 * scraping closes this. One line, because one line is the whole answer.
 */
function SupplyDataGap() {
  return (
    <WidgetCard title="Supplier and customer mapping" full staticCard fit>
      <div style={{ padding: "14px", fontSize: 13, color: "var(--text-muted)" }}>
        Paid data required.
      </div>
    </WidgetCard>
  );
}

export function Insights({
  rows,
  bucketCells,
  latestMonth,
  metric,
  onSelect,
}: {
  rows: AnalyticsRow[];
  bucketCells: BucketCell[] | null;
  latestMonth: string | null;
  metric: HeatmapMetric;
  onSelect: (ticker: string) => void;
}) {
  const month = (bucketCells ?? []).filter((c) => c.month === latestMonth && c.value !== null);
  const { ranked } = standouts(month, (c) => c.value);
  const standoutBucket = ranked[0]?.item.bucket ?? null;

  return (
    <>
      <StandoutStage cells={bucketCells} latestMonth={latestMonth} metric={metric} />
      <InsideTheStage
        rows={rows}
        bucket={standoutBucket}
        latestMonth={latestMonth}
        onSelect={onSelect}
      />
      <SegmentPilot rows={rows} latestMonth={latestMonth} onSelect={onSelect} />
      <Relationships />
      <SupplyDataGap />
    </>
  );
}
