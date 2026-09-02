/**
 * The composition root: three zones, one shared view state, one fetch per widget
 * that needs one.
 *
 * Each tab is its own component so its queries mount with it - switching to Company
 * does not fetch the bucket heatmap, and switching away cancels nothing that
 * matters. The only query hoisted to this level is `/api/analytics`, because four
 * of the five tabs read it and the filter row reports its row count.
 *
 * AlertStrip sits above all of them rather than on a tab of its own. A tab is a
 * place you have to decide to go; a data problem has to reach whoever is looking
 * at revenue, wherever that is.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { api, onUnauthorized } from "./api";
import type { FilterState } from "./api";
import { readView, windowMonths, writeView } from "./urlState";
import type { ViewState } from "./urlState";
import { useApi } from "./useApi";
import { METRICS, metricSpec } from "./scale";
import { forMonth, groupBy, sortedMonths } from "./stats";
import { revenue } from "./format";

import { Header } from "./components/Header";
import type { Tab } from "./components/Header";
import { FilterBar } from "./components/FilterBar";
import { KeyGate } from "./components/KeyGate";
import { WidgetCard } from "./components/WidgetCard";
import { AsyncBody, EmptyState, ErrorState, Shimmer, ShimmerBlock } from "./components/states";
import { Segmented, ViewToggle } from "./components/controls";
import type { ViewMode } from "./components/controls";
import { Heatmap } from "./components/Heatmap";
import type { HeatRow } from "./components/Heatmap";
import { MatrixTable } from "./components/tables";
import { Kpis } from "./components/Kpis";
import { Movers } from "./components/Movers";
import { Insights } from "./components/Insights";
import { consolidationNote } from "./generated/relationships";
import { DataTable } from "./components/DataTable";
import { CompanyPanel } from "./components/CompanyPanel";
import { AlertStrip, consolidatedNote } from "./components/AlertStrip";
import { Buckets } from "./components/Buckets";
import { MethodAndUnits } from "./components/Method";
import type { AnalyticsRow, BucketHeatmap, HeatmapMetric, Meta, TickerHeatmap } from "./types";

const GRID: CSSProperties = {
  display: "grid",
  gap: "var(--grid-gap)",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  /*
   * STRETCH, not start.
   *
   * `start` gave every card its natural height, so a row of three cards whose
   * content happened to differ - a 6-line summary beside a 20-row list beside a
   * one-line empty state - came out as three different heights with ragged
   * whitespace between them. That is the single thing that made every tab look
   * unfinished. Stretching makes each row a clean band; the cards already
   * flex-column with a `flex: 1` body, so the extra height lands in the body
   * rather than stranding the header.
   */
  alignItems: "stretch",
};

/**
 * How tall a matrix may get before it scrolls.
 *
 * These were fixed pixel guesses (420 and 560) chosen against one screen size,
 * so on anything taller they left the card short and sliced the last row in
 * half - the table looked truncated rather than scrollable, which is the
 * complaint. Sizing against the viewport lets the matrix use whatever room the
 * page actually has, while `max()` keeps a usable floor on a laptop. The
 * subtrahend is the chrome above each one: header + filter bar + card header +
 * legend, plus the KPI strip on Overview.
 */
const MATRIX_H_OVERVIEW = "max(300px, calc(100vh - 430px))";
const MATRIX_H_ACCEL = "max(340px, calc(100vh - 300px))";
const TABLE_H_DATA = "max(360px, calc(100vh - 250px))";

const METRIC_OPTIONS = METRICS.map((m) => ({
  value: m.key,
  label: m.label,
  title: m.blurb,
}));

/** A clock, for "3h ago" labels. One interval for the whole app. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function App() {
  const [view, setView] = useState<ViewState>(readView);
  const [locked, setLocked] = useState(false);
  const now = useNow();

  // A 401 from any query means the whole dashboard has no credential, not that one
  // widget failed. Subscribed once here; see api.ts for why it is not per-widget.
  useEffect(() => onUnauthorized(() => setLocked(true)), []);

  // The CSV href. Unfiltered it is the published file - one URL, cached,
  // nothing built. Filtered it is a blob assembled from the rows already in
  // memory, because there is no Worker query to run any more. The previous
  // blob is revoked when the filters change or the page unmounts; without that
  // every chip click leaks a copy of the dataset for the life of the tab.
  const [exportHref, setExportHref] = useState<string>("/data/export.csv");
  useEffect(() => {
    let revoke: (() => void) | undefined;
    let live = true;
    void api.exportCsv(view.filters).then((r) => {
      if (!live) {
        r.revoke?.();
        return;
      }
      revoke = r.revoke;
      setExportHref(r.href);
    });
    return () => {
      live = false;
      revoke?.();
    };
  }, [view.filters]);

  useEffect(() => writeView(view), [view]);
  useEffect(() => {
    const on = () => setView(readView());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);

  const meta = useApi(() => api.meta(), []);

  // The live access posture, and the only source for it. `meta.access` is
  // written by the exporter on a GitHub runner, which cannot see this Worker's
  // secrets, so it always reads "open"; only the Worker can answer this. Health
  // is the one route that answers without a credential, which is exactly what a
  // browser that does not yet hold one needs.
  const health = useApi(() => api.health(), []);

  // The server owns the default window (it excludes the shoulder month). Adopt it
  // once, and only when the URL did not already say otherwise.
  const adopted = useRef(false);
  useEffect(() => {
    const m = meta.data;
    if (adopted.current || !m) return;
    adopted.current = true;
    if (!view.fromExplicit && m.default_from && m.default_from !== view.filters.from) {
      setView((v) => ({ ...v, filters: { ...v.filters, from: m.default_from } }));
    }
  }, [meta.data, view.fromExplicit, view.filters.from]);

  const filterKey = JSON.stringify(view.filters);
  const analytics = useApi(() => api.analytics(view.filters), [filterKey]);
  const rows = analytics.data?.rows ?? [];

  const months = useMemo(
    () => windowMonths(meta.data?.months ?? [], view.filters),
    [meta.data, view.filters],
  );
  // The newest month that actually has rows, not the newest column.
  const latestMonth = useMemo(() => {
    const withRows = sortedMonths(rows);
    return withRows[withRows.length - 1] ?? meta.data?.latest_month ?? null;
  }, [rows, meta.data]);

  const setFilters = (filters: FilterState) =>
    setView((v) => ({ ...v, filters, fromExplicit: true }));
  const setTab = (tab: Tab) => setView((v) => ({ ...v, tab }));
  const openCompany = (ticker: string) => setView((v) => ({ ...v, ticker, tab: "company" }));
  // One graph/table mode for the whole dashboard. See ViewToggle for why it is shared.
  const setViz = (viz: ViewMode) => setView((v) => ({ ...v, viz }));

  const showFilters = view.tab !== "company";

  // Placed after every hook above on purpose - an early return before them would
  // break the rules of hooks. The queries they hold are harmless while locked: each
  // 401s once, which is what set this flag in the first place.
  if (locked) {
    // A full reload, because the session cookie is HttpOnly and therefore invisible
    // to this code. It also drops the view state back to the URL, which is where it
    // already lives, so the reader lands on the same tab they were locked out of.
    return <KeyGate onUnlocked={() => location.reload()} />;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "var(--page-bg)",
      }}
    >
      <Header
        tab={view.tab}
        onTab={setTab}
        meta={meta.data}
        ticker={view.ticker}
        onClearTicker={() => setView((v) => ({ ...v, ticker: null }))}
        exportHref={exportHref}
        accessMode={health.data?.access?.mode ?? null}
        onLock={() => {
          void api.logout().then(() => setLocked(true));
        }}
        now={now}
      />

      <main style={{ flex: 1, overflow: "auto", padding: "var(--main-pad)" }}>
        {meta.error && !meta.data ? (
          <WidgetCard title="Dashboard unavailable">
            <AsyncBody state={meta} onRetry={meta.reload}>
              {() => null}
            </AsyncBody>
          </WidgetCard>
        ) : (
          <>
            {/* Above the filters, so it is the first thing read on whichever
                tab happens to be open. Renders nothing when nothing is wrong. */}
            <AlertStrip alerts={meta.data?.alerts} />

            {showFilters && (
              <FilterBar
                meta={meta.data}
                filters={view.filters}
                onChange={setFilters}
                rowCount={analytics.data ? analytics.data.count : null}
              />
            )}

            {view.tab === "overview" && (
              <OverviewTab
                meta={meta.data}
                filters={view.filters}
                rows={rows}
                months={months}
                latestMonth={latestMonth}
                metric={view.metric}
                agg={view.agg}
                viz={view.viz}
                onMetric={(metric) => setView((v) => ({ ...v, metric }))}
                onAgg={(agg) => setView((v) => ({ ...v, agg }))}
                onViz={setViz}
                onSelect={openCompany}
              />
            )}

            {view.tab === "insights" && (
              <InsightsTab
                meta={meta.data}
                filters={view.filters}
                rows={rows}
                latestMonth={latestMonth}
                metric={view.metric}
                agg={view.agg}
                onMetric={(metric) => setView((v) => ({ ...v, metric }))}
                onAgg={(agg) => setView((v) => ({ ...v, agg }))}
                onSelect={openCompany}
              />
            )}

            {view.tab === "acceleration" && (
              <AccelerationTab
                filters={view.filters}
                rows={rows}
                months={months}
                latestMonth={latestMonth}
                metric={view.metric}
                viz={view.viz}
                onMetric={(metric) => setView((v) => ({ ...v, metric }))}
                onViz={setViz}
                onSelect={openCompany}
              />
            )}

            {view.tab === "company" && (
              <CompanyTab
                meta={meta.data}
                ticker={view.ticker}
                viz={view.viz}
                onViz={setViz}
                onSelect={(ticker) => setView((v) => ({ ...v, ticker }))}
              />
            )}

            {/* The grid goes INSIDE the AsyncBody callback, not around it.
                AsyncBody renders one <div>, so as a direct child of GRID it
                became a single `minmax(340px, 1fr)` cell and everything it
                wrapped was trapped in one 340px column - with three quarters of
                the screen left empty. Worse, WidgetCard's `wide`/`full` set
                `gridColumn`, which only does anything for a DIRECT grid child,
                so the cards that asked to span were silently ignored. */}
            {view.tab === "buckets" && (
              <AsyncBody
                state={analytics}
                onRetry={analytics.reload}
                skeleton={
                  <div style={GRID}>
                    <ShimmerBlock />
                  </div>
                }
              >
                {() => (
                  <div style={GRID}>
                    <Buckets rows={rows} viz={view.viz} onViz={setViz} />
                  </div>
                )}
              </AsyncBody>
            )}

            {/* The Data tab gets no graph/table toggle: it IS the table view, column
                for column identical to the CSV export, and drawing twelve columns of
                mixed units as a chart would need a dual axis. */}
            {view.tab === "data" && (
              <div style={GRID}>
                <WidgetCard
                  title="Monthly revenue table"
                  subtitle="The twelve specified columns, in export order"
                  full
                  staticCard
                  bodyStyle={{ overflow: "hidden" }}
                >
                  <AsyncBody
                    state={analytics}
                    onRetry={analytics.reload}
                    skeleton={<Shimmer rows={10} />}
                    empty={(d) =>
                      d.rows.length === 0 ? (
                        <EmptyState
                          message="No rows match these filters"
                          hint="Widen the month range, or clear the stage and tier chips."
                        />
                      ) : null
                    }
                  >
                    {(d) => (
                      <DataTable
                        rows={d.rows}
                        onSelect={openCompany}
                        maxHeight={TABLE_H_DATA}
                        note={consolidatedNote(meta.data?.alerts)}
                      />
                    )}
                  </AsyncBody>
                </WidgetCard>
              </div>
            )}

          </>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ overview --

function OverviewTab({
  meta,
  filters,
  rows,
  months,
  latestMonth,
  metric,
  agg,
  viz,
  onMetric,
  onAgg,
  onViz,
  onSelect,
}: {
  meta: Meta | null;
  filters: FilterState;
  rows: AnalyticsRow[];
  months: string[];
  latestMonth: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  viz: ViewMode;
  onMetric: (m: HeatmapMetric) => void;
  onAgg: (a: "weighted" | "equal") => void;
  onViz: (v: ViewMode) => void;
  onSelect: (ticker: string) => void;
}) {
  const heat = useApi(
    () => api.bucketHeatmap(filters, metric, agg),
    [JSON.stringify(filters), metric, agg],
  );
  const spec = metricSpec(metric);
  const order = stageOrder(meta);

  return (
    <>
      <Kpis
        rows={rows}
        meta={meta}
        bucketCells={heat.data?.cells ?? null}
        latestMonth={latestMonth}
        // The metric the CELLS carry, not the one the toggle is on. Between a
        // click and the response landing those differ, and the KPI row took its
        // unit from the toggle while still holding the previous metric's values -
        // printing a percentage-point figure with a % sign for that moment.
        metric={heat.data?.metric ?? metric}
        filtered={
          filters.tickers.length > 0 || filters.buckets.length > 0 || filters.tiers.length > 0
        }
      />

      <div style={GRID}>
        <WidgetCard
          title="Supply chain by stage"
          subtitle={`${spec.label} in ${spec.unit} · ${aggLabel(heat.data ?? undefined, agg)}`}
          full
          staticCard
          bodyStyle={{ overflow: "hidden" }}
          // The stage aggregate is a sum, and one member's revenue is inside
          // another's. The Worker excludes it; this says so where the number is.
          footnote={consolidationNote()}
          actions={
            <>
              <Segmented
                options={METRIC_OPTIONS}
                value={metric}
                onChange={onMetric}
                ariaLabel="Heatmap metric"
              />
              <Segmented
                options={[
                  { value: "weighted", label: "NT$", title: "Weight each company by revenue" },
                  { value: "equal", label: "Equal", title: "One company, one vote" },
                ]}
                value={agg}
                onChange={onAgg}
                ariaLabel="Aggregation"
              />
              <ViewToggle value={viz} onChange={onViz} />
            </>
          }
        >
          <AsyncBody
            state={heat}
            onRetry={heat.reload}
            skeleton={<ShimmerBlock height={260} />}
            empty={(d) =>
              d.cells.length === 0 ? (
                <EmptyState
                  message="No stage has a value in this window"
                  hint="This metric needs a prior month or a prior year to compare against. Try widening the month range."
                />
              ) : null
            }
          >
            {(d) =>
              viz === "table" ? (
                <MatrixTable
                  months={months}
                  rows={bucketRows(d, order)}
                  metric={metric}
                  rowHeader="Stage"
                  maxHeight={MATRIX_H_OVERVIEW}
                />
              ) : (
                <Heatmap
                  months={months}
                  rows={bucketRows(d, order)}
                  metric={metric}
                  rowHeader="Stage"
                  maxHeight={MATRIX_H_OVERVIEW}
                />
              )
            }
          </AsyncBody>
        </WidgetCard>

        {/* Rendered bare, exactly as the Acceleration tab does it. Movers emits
            TWO cards, so wrapping it in AsyncBody made both share one grid cell
            and stacked Decelerating underneath Accelerating in a 340px column.
            `rows` is already the resolved analytics payload and both panels
            handle an empty list, so the wrapper bought nothing. */}
        <Movers rows={rows} latestRows={forMonth(rows, latestMonth)} onSelect={onSelect} />

        {meta && <MethodAndUnits meta={meta} />}
      </div>
    </>
  );
}

/**
 * The weighting caption, read off what the SERVER APPLIED rather than off the
 * toggle. Cumulative YoY has no equal-weighted variant, so asking for Equal
 * returns the revenue-weighted figure - and captioning that "equal-weighted, one
 * company one vote" from the local toggle state told the reader the opposite of
 * how the number was made, in all 70 cells. When the request could not be
 * honoured the caption says so, so a toggle that appears to do nothing is
 * explained rather than merely inert.
 */
function aggLabel(d: BucketHeatmap | undefined, requested: "weighted" | "equal"): string {
  const applied = d?.agg ?? requested;
  const base =
    applied === "weighted" ? "revenue-weighted" : "equal-weighted, one company one vote";
  return applied !== requested ? `${base} · this metric has no equal-weighted form` : base;
}

/**
 * Supply-chain order for the stage rows, read off `meta.universe`.
 *
 * The universe arrives sorted by `sort_order`, which encodes the chain:
 * equipment -> silicon -> packaging -> substrate -> thermal -> power -> rack ->
 * networking -> the two control groups. First appearance of each stage in that
 * list therefore IS the chain order, with no second list to keep in sync.
 *
 * That order is checked, not asserted. `test_stage_order_follows_the_supply
 * _edges` walks every edge in config/relationships.yaml and requires the seller
 * to sit at or before the buyer. It runs 17 of 18 forward; the exception is
 * ASE -> TSMC, which is genuinely two-directional (TSMC ships wafers to ASE for
 * packaging, and separately buys outsourced capacity back from it), so no
 * linear order can satisfy it and the test names it explicitly.
 *
 * The previous order put thermal, power and equipment AFTER the stages they
 * feed, which made every one of those 18 edges run backwards up the page.
 *
 * `/api/heatmap` returns `ORDER BY bucket`, i.e. alphabetically, so without this
 * the Overview matrix read AI Silicon, Advanced Packaging, Analog Cycle, Legacy,
 * Networking, Power, Rack, Semi Equipment, Substrate, Thermal - which puts the
 * control group in the middle of the chain and separates substrate from the rack
 * it feeds. The Buckets tab was already in chain order, so the same ten stages
 * came out in two different sequences on two tabs.
 */
function stageOrder(meta: Meta | null): string[] {
  const seen: string[] = [];
  for (const c of meta?.universe ?? []) {
    if (!seen.includes(c.bucket)) seen.push(c.bucket);
  }
  return seen;
}

/** Bucket cells -> heatmap rows. Detail lines carry the basis for the number. */
function bucketRows(d: BucketHeatmap, order: string[]): HeatRow[] {
  const by = groupBy(d.cells, (c) => c.bucket);
  // A stage the order does not know about sorts after the ones it does, rather
  // than to the top: indexOf returns -1, which would put an unrecognised stage
  // first. That case is a universe.yaml edit that has not reached the browser
  // yet, so it should be visible at the end, not leading the chain.
  const rank = (b: string) => {
    const i = order.indexOf(b);
    return i === -1 ? order.length : i;
  };
  return [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([bucket, cells]) => ({
      key: bucket,
      label: bucket,
      cells: Object.fromEntries(
        cells.map((c) => [
          c.month,
          {
            value: c.value,
            flag: c.composition_changed,
            detail: (
              <>
                <div>Stage revenue: {revenue(c.revenue)}</div>
                {/* These are two different counts, not a fraction. `members` is
                    the metric's own basis (members_yoy / members_mom /
                    members_cum, api.ts:498), `members_with_revenue` is the plain
                    filed count - so the "of" reading printed a numerator that is
                    always >= its denominator. */}
                <div>
                  {c.members_with_revenue} filed · {c.members} with a comparable
                </div>
              </>
            ),
          },
        ]),
      ),
    }));
}

// -------------------------------------------------------------- acceleration --

/**
 * The Insights tab.
 *
 * It asks /api/heatmap for the same bucket aggregate the Overview chart draws,
 * with the same filters, metric and weighting - deliberately the same request,
 * so the browser cache serves it and the two tabs can never disagree about a
 * stage's number. Recomputing the aggregate here would be a second
 * implementation of the paired-predicate CTE, which is the one piece of SQL in
 * this repo that has already shipped a sign inversion.
 */
/**
 * Two columns on a wide screen, one on a narrow one - not the shared GRID.
 *
 * GRID is minmax(340px, 1fr), which at a normal desktop width lays out three
 * columns. The Insights cards are ranked tables that want roughly half the
 * screen each, and `wide` (span 2 of 3) left a third of the viewport empty
 * beside them. 560px floors this at two columns at 1200px and above and folds
 * to one below, which is what these two cards actually want; `full` still spans
 * the row whatever the count.
 */
const INSIGHTS_GRID: CSSProperties = {
  ...GRID,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 560px), 1fr))",
};

function InsightsTab({
  meta,
  filters,
  rows,
  latestMonth,
  metric,
  agg,
  onMetric,
  onAgg,
  onSelect,
}: {
  meta: Meta | null;
  filters: FilterState;
  rows: AnalyticsRow[];
  latestMonth: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  onMetric: (m: HeatmapMetric) => void;
  onAgg: (a: "weighted" | "equal") => void;
  onSelect: (ticker: string) => void;
}) {
  const heat = useApi(
    () => api.bucketHeatmap(filters, metric, agg),
    [JSON.stringify(filters), metric, agg],
  );
  const spec = metricSpec(metric);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: "var(--grid-gap)",
        }}
      >
        <div style={{ fontSize: 11, color: "var(--text-hint)", lineHeight: 1.45, maxWidth: 620 }}>
          Ranked on <strong>{spec.label}</strong>, {aggLabel(heat.data ?? undefined, agg)}.
          Changing the metric changes what “stands out” means, which is the point: a stage can
          lead on growth and trail on acceleration in the same month.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Segmented
            options={METRIC_OPTIONS}
            value={metric}
            onChange={onMetric}
            ariaLabel="Ranking metric"
          />
          <Segmented
            options={[
              { value: "weighted", label: "NT$", title: "Weight each company by revenue" },
              { value: "equal", label: "Equal", title: "One company, one vote" },
            ]}
            value={agg}
            onChange={onAgg}
            ariaLabel="Aggregation"
          />
        </div>
      </div>

      {/* GRID goes INSIDE the callback. AsyncBody renders one <div>, and
          Insights emits four cards - as a direct grid child that div would be a
          single minmax(340px, 1fr) cell with all four cards stacked inside it,
          and WidgetCard's `wide` would be silently ignored because gridColumn
          only does anything for a DIRECT grid child. The Buckets tab hit exactly
          this and the comment there is why this one is written this way. */}
      <AsyncBody
        state={heat}
        onRetry={heat.reload}
        skeleton={
          <div style={INSIGHTS_GRID}>
            <ShimmerBlock height={260} />
          </div>
        }
      >
        {(d) => (
          <div style={INSIGHTS_GRID}>
            <Insights
              rows={rows}
              bucketCells={d.cells}
              latestMonth={latestMonth}
              metric={metric}
              stageOrder={stageOrder(meta)}
              universe={(meta?.universe ?? []).map((c) => ({
                ticker: c.ticker,
                name: c.display_name,
              }))}
              onSelect={onSelect}
            />
            {meta && <MethodAndUnits meta={meta} />}
          </div>
        )}
      </AsyncBody>
    </>
  );
}

function AccelerationTab({
  filters,
  rows,
  months,
  latestMonth,
  metric,
  viz,
  onMetric,
  onViz,
  onSelect,
}: {
  filters: FilterState;
  rows: AnalyticsRow[];
  months: string[];
  latestMonth: string | null;
  metric: HeatmapMetric;
  viz: ViewMode;
  onMetric: (m: HeatmapMetric) => void;
  onViz: (v: ViewMode) => void;
  onSelect: (ticker: string) => void;
}) {
  const heat = useApi(() => api.tickerHeatmap(filters, metric), [JSON.stringify(filters), metric]);
  const spec = metricSpec(metric);

  return (
    <div style={GRID}>
      <WidgetCard
        title="Company by month"
        // The count is here because the matrix scrolls. Without it, a row sliced
        // by the container's edge reads as "the table is cut off" rather than
        // "there are more below" - which was exactly the complaint.
        subtitle={
          `${spec.label} in ${spec.unit}` +
          (heat.data ? ` · ${new Set(heat.data.cells.map((c) => c.ticker)).size} companies` : "") +
          ` · strongest latest month first · click a row for the filings`
        }
        full
        staticCard
        bodyStyle={{ overflow: "hidden" }}
        actions={
          <>
            <Segmented
              options={METRIC_OPTIONS}
              value={metric}
              onChange={onMetric}
              ariaLabel="Heatmap metric"
            />
            <ViewToggle value={viz} onChange={onViz} />
          </>
        }
      >
        <AsyncBody
          state={heat}
          onRetry={heat.reload}
          skeleton={<ShimmerBlock height={340} />}
          empty={(d) =>
            d.cells.length === 0 ? (
              <EmptyState
                message="Nothing to show for these filters"
                hint="Clear a stage or tier chip, or widen the month range."
              />
            ) : null
          }
        >
          {(d) =>
            viz === "table" ? (
              <MatrixTable
                months={months}
                rows={tickerRows(d, latestMonth)}
                metric={metric}
                rowHeader="Company"
                onRowClick={onSelect}
                maxHeight={MATRIX_H_ACCEL}
              />
            ) : (
              <Heatmap
                months={months}
                rows={tickerRows(d, latestMonth)}
                metric={metric}
                rowHeader="Company"
                onRowClick={onSelect}
                maxHeight={MATRIX_H_ACCEL}
              />
            )
          }
        </AsyncBody>
      </WidgetCard>

      <Movers rows={rows} latestRows={forMonth(rows, latestMonth)} onSelect={onSelect} />
    </div>
  );
}

/**
 * Ticker cells -> heatmap rows, ordered by the latest month's value.
 *
 * Nulls sort last rather than to the bottom of the negative range: a company that
 * has not filed is not the worst performer.
 */
function tickerRows(d: TickerHeatmap, latestMonth: string | null): HeatRow[] {
  const by = groupBy(d.cells, (c) => c.ticker);
  const entries = [...by.entries()];
  entries.sort((a, b) => {
    const av = a[1].find((c) => c.month === latestMonth)?.value ?? null;
    const bv = b[1].find((c) => c.month === latestMonth)?.value ?? null;
    if (av === null && bv === null) return a[0].localeCompare(b[0]);
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
  return entries.map(([ticker, cells]) => {
    const first = cells[0];
    return {
      key: ticker,
      label: first?.company_name ?? ticker,
      sublabel: `${ticker} · ${first?.bucket ?? ""} · T${first?.tier ?? "?"}`,
      cells: Object.fromEntries(
        cells.map((c) => [
          c.month,
          {
            value: c.value,
            detail: <div>Revenue: {revenue(c.revenue)}</div>,
          },
        ]),
      ),
    };
  });
}

// ------------------------------------------------------------------- company --

function CompanyTab({
  meta,
  ticker,
  viz,
  onViz,
  onSelect,
}: {
  meta: Meta | null;
  ticker: string | null;
  viz: ViewMode;
  onViz: (v: ViewMode) => void;
  onSelect: (ticker: string) => void;
}) {
  const universe = meta?.universe ?? [];
  const byBucket = groupBy(universe, (u) => u.bucket);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          marginBottom: "var(--grid-gap)",
          background: "var(--card-bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
        }}
      >
        <span className="eyebrow">Company</span>
        <select
          value={ticker ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            height: "var(--control-h)",
            padding: "0 7px",
            fontSize: 11.5,
            background: "var(--card-bg)",
            border: "1px solid var(--border-solid)",
            borderRadius: "var(--radius-control)",
            minWidth: 280,
            cursor: "pointer",
          }}
        >
          <option value="">Select a company…</option>
          {[...byBucket.entries()].map(([bucket, list]) => (
            <optgroup key={bucket} label={bucket}>
              {list.map((u) => (
                <option key={u.ticker} value={u.ticker}>
                  {u.ticker} · {u.display_name}
                  {u.status !== "active" ? ` (${u.status})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span style={{ flex: 1, fontSize: 11, color: "var(--text-hint)" }}>
          Full history, unaffected by the month filters on the other tabs
        </span>
        {/* One toggle for this tab's three charts, in the tab's own control row -
            three identical controls in three card headers would be noise. */}
        <ViewToggle value={viz} onChange={onViz} />
      </div>

      <div style={GRID}>
        {ticker ? (
          <CompanyBody ticker={ticker} viz={viz} />
        ) : (
          <WidgetCard title="No company selected">
            <EmptyState
              message="Pick a company above"
              hint="Or click any row in the Acceleration heatmap or the Data table."
            />
          </WidgetCard>
        )}
      </div>
    </>
  );
}

/** Split out so the query is keyed to the ticker and remounts cleanly. */
function CompanyBody({ ticker, viz }: { ticker: string; viz: ViewMode }) {
  const detail = useApi(() => api.company(ticker), [ticker]);

  if (detail.error && !detail.data) {
    return (
      <WidgetCard title={`${ticker} unavailable`} full>
        <ErrorState error={detail.error} onRetry={detail.reload} />
      </WidgetCard>
    );
  }
  if (!detail.data) {
    return (
      <WidgetCard title={`Loading ${ticker}`} full>
        <Shimmer rows={6} />
      </WidgetCard>
    );
  }
  return <CompanyPanel detail={detail.data} viz={viz} />;
}

