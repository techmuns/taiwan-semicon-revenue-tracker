/**
 * The composition root: three zones, one shared view state, one fetch per widget
 * that needs one.
 *
 * Each tab is its own component so its queries mount with it - switching to Quality
 * does not fetch the heatmap, and switching away cancels nothing that matters. The
 * only query hoisted to this level is `/api/analytics`, because four of the six tabs
 * read it and the filter row reports its row count.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { api } from "./api";
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
import { WidgetCard } from "./components/WidgetCard";
import { AsyncBody, EmptyState, ErrorState, Shimmer, ShimmerBlock } from "./components/states";
import { Segmented } from "./components/controls";
import { Heatmap } from "./components/Heatmap";
import type { HeatRow } from "./components/Heatmap";
import { Kpis } from "./components/Kpis";
import { Insights } from "./components/Insights";
import { DataTable } from "./components/DataTable";
import { CompanyPanel } from "./components/CompanyPanel";
import { QualityPanel } from "./components/QualityPanel";
import { Buckets } from "./components/Buckets";
import { Sources } from "./components/Sources";
import type { AnalyticsRow, BucketHeatmap, HeatmapMetric, Meta, TickerHeatmap } from "./types";

const GRID: CSSProperties = {
  display: "grid",
  gap: "var(--grid-gap)",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  alignItems: "start",
};

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
  const now = useNow();

  useEffect(() => writeView(view), [view]);
  useEffect(() => {
    const on = () => setView(readView());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);

  const meta = useApi(() => api.meta(), []);

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

  const showFilters = view.tab !== "quality" && view.tab !== "company";

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
        exportHref={api.exportUrl(view.filters)}
        now={now}
      />

      <main style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
        {meta.error && !meta.data ? (
          <WidgetCard title="Dashboard unavailable">
            <AsyncBody state={meta} onRetry={meta.reload}>
              {() => null}
            </AsyncBody>
          </WidgetCard>
        ) : (
          <>
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
                analytics={analytics}
                rows={rows}
                months={months}
                latestMonth={latestMonth}
                metric={view.metric}
                agg={view.agg}
                onMetric={(metric) => setView((v) => ({ ...v, metric }))}
                onAgg={(agg) => setView((v) => ({ ...v, agg }))}
                onSelect={openCompany}
                now={now}
              />
            )}

            {view.tab === "acceleration" && (
              <AccelerationTab
                filters={view.filters}
                rows={rows}
                months={months}
                latestMonth={latestMonth}
                metric={view.metric}
                onMetric={(metric) => setView((v) => ({ ...v, metric }))}
                onSelect={openCompany}
              />
            )}

            {view.tab === "company" && (
              <CompanyTab
                meta={meta.data}
                ticker={view.ticker}
                onSelect={(ticker) => setView((v) => ({ ...v, ticker }))}
              />
            )}

            {view.tab === "buckets" && (
              <div style={GRID}>
                <AsyncBody state={analytics} onRetry={analytics.reload} skeleton={<ShimmerBlock />}>
                  {() => <Buckets rows={rows} />}
                </AsyncBody>
              </div>
            )}

            {view.tab === "data" && (
              <div style={GRID}>
                <WidgetCard
                  title="Monthly revenue table"
                  subtitle="The twelve specified columns, in order · same shape as the CSV export"
                  category="markets"
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
                    {(d) => <DataTable rows={d.rows} onSelect={openCompany} />}
                  </AsyncBody>
                </WidgetCard>
              </div>
            )}

            {view.tab === "quality" && <QualityTab />}
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
  analytics,
  rows,
  months,
  latestMonth,
  metric,
  agg,
  onMetric,
  onAgg,
  onSelect,
  now,
}: {
  meta: Meta | null;
  filters: FilterState;
  analytics: { data: { rows: AnalyticsRow[] } | null; error: unknown; loading: boolean };
  rows: AnalyticsRow[];
  months: string[];
  latestMonth: string | null;
  metric: HeatmapMetric;
  agg: "weighted" | "equal";
  onMetric: (m: HeatmapMetric) => void;
  onAgg: (a: "weighted" | "equal") => void;
  onSelect: (ticker: string) => void;
  now: number;
}) {
  const heat = useApi(
    () => api.bucketHeatmap(filters, metric, agg),
    [JSON.stringify(filters), metric, agg],
  );
  const spec = metricSpec(metric);

  return (
    <>
      <Kpis
        rows={rows}
        meta={meta}
        bucketCells={heat.data?.cells ?? null}
        latestMonth={latestMonth}
      />

      <div style={GRID}>
        <WidgetCard
          title="Supply chain by stage"
          subtitle={`${spec.blurb} · ${
            agg === "weighted"
              ? "revenue-weighted, so the big names dominate their stage"
              : "equal-weighted, so a small name counts as much as TSMC"
          }`}
          category="heatmaps"
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
              <Segmented
                options={[
                  { value: "weighted", label: "NT$ weighted", title: "Weight each company by revenue" },
                  { value: "equal", label: "Equal", title: "One company, one vote" },
                ]}
                value={agg}
                onChange={onAgg}
                ariaLabel="Aggregation"
              />
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
            {(d) => (
              <Heatmap
                months={months}
                rows={bucketRows(d)}
                metric={metric}
                rowHeader="Stage"
                maxHeight={420}
              />
            )}
          </AsyncBody>
        </WidgetCard>

        <AsyncBody state={analytics} skeleton={<ShimmerBlock height={200} />}>
          {() => <Insights rows={rows} latestRows={forMonth(rows, latestMonth)} onSelect={onSelect} />}
        </AsyncBody>

        {meta && <Sources meta={meta} now={now} />}
      </div>
    </>
  );
}

/** Bucket cells -> heatmap rows. Detail lines carry the basis for the number. */
function bucketRows(d: BucketHeatmap): HeatRow[] {
  const by = groupBy(d.cells, (c) => c.bucket);
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
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
                <div>
                  {c.members_with_revenue} of {c.members} names filed
                </div>
              </>
            ),
          },
        ]),
      ),
    }));
}

// -------------------------------------------------------------- acceleration --

function AccelerationTab({
  filters,
  rows,
  months,
  latestMonth,
  metric,
  onMetric,
  onSelect,
}: {
  filters: FilterState;
  rows: AnalyticsRow[];
  months: string[];
  latestMonth: string | null;
  metric: HeatmapMetric;
  onMetric: (m: HeatmapMetric) => void;
  onSelect: (ticker: string) => void;
}) {
  const heat = useApi(() => api.tickerHeatmap(filters, metric), [JSON.stringify(filters), metric]);
  const spec = metricSpec(metric);

  return (
    <div style={GRID}>
      <WidgetCard
        title="Company by month"
        subtitle={`${spec.blurb} · sorted by the latest month, strongest first · click a row for the filings`}
        category="heatmaps"
        full
        staticCard
        bodyStyle={{ overflow: "hidden" }}
        actions={
          <Segmented
            options={METRIC_OPTIONS}
            value={metric}
            onChange={onMetric}
            ariaLabel="Heatmap metric"
          />
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
          {(d) => (
            <Heatmap
              months={months}
              rows={tickerRows(d, latestMonth)}
              metric={metric}
              rowHeader="Company"
              onRowClick={onSelect}
              maxHeight={560}
            />
          )}
        </AsyncBody>
      </WidgetCard>

      <Insights rows={rows} latestRows={forMonth(rows, latestMonth)} onSelect={onSelect} />
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
  onSelect,
}: {
  meta: Meta | null;
  ticker: string | null;
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
          padding: "10px 14px",
          marginBottom: 20,
          background: "var(--card-bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--text-hint)",
          }}
        >
          Company
        </span>
        <select
          value={ticker ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            height: 28,
            padding: "0 8px",
            fontSize: 12,
            background: "#ffffff",
            border: "1px solid var(--border-solid)",
            borderRadius: 8,
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
        <span style={{ fontSize: 11, color: "var(--text-hint)" }}>
          Full history, unaffected by the month filters on the other tabs
        </span>
      </div>

      <div style={GRID}>
        {ticker ? (
          <CompanyBody ticker={ticker} />
        ) : (
          <WidgetCard title="No company selected" category="sector">
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
function CompanyBody({ ticker }: { ticker: string }) {
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
  return <CompanyPanel detail={detail.data} />;
}

// ------------------------------------------------------------------- quality --

function QualityTab() {
  const quality = useApi(() => api.quality(), []);
  return (
    <div style={GRID}>
      <AsyncBody state={quality} onRetry={quality.reload} skeleton={<ShimmerBlock height={240} />}>
        {(q) => <QualityPanel quality={q} />}
      </AsyncBody>
    </div>
  );
}
