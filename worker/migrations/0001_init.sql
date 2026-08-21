-- Taiwan semiconductor supply-chain revenue tracker - initial schema.
--
-- Applied to D1 (remote), and to a local SQLite file by the Python test harness.
-- Running the same DDL against both engines is deliberate: the metric logic lives
-- in a view, so the only way to test it cheaply is to execute the identical SQL
-- locally. Nothing in here may use a D1-only or a Python-only construct.
--
-- Units: every revenue figure is TWD THOUSANDS, as declared by the source
-- (單位：新台幣仟元). Percentages are percent; accelerations are percentage points.

-- ---------------------------------------------------------------- universe --
-- Mirror of config/universe.yaml. Rewritten wholesale by the seed inside a
-- transaction, so the YAML is always authoritative and drift is impossible.
CREATE TABLE IF NOT EXISTS universe (
  ticker       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  name_zh      TEXT,
  bucket       TEXT NOT NULL,
  tier         INTEGER NOT NULL CHECK (tier IN (1, 2)),
  market_hint  TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','merged','delisted','suspended')),
  active_from  TEXT,
  active_to    TEXT,
  successor    TEXT,
  thesis       TEXT,
  notes        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------- raw_revenue --
-- The scrape at company/month level, as reported. Never edited in place except
-- by the idempotent upsert. This is the auditable layer: every derived number in
-- the product is a pure function of these rows.
--
-- Sources are allowed to be sparse. The brief's per-company MOPS endpoint has no
-- 上月營收 field at all, so revenue_prev_month is NULL for every one of its rows
-- and mom_pct is derived from the neighbouring month instead.
CREATE TABLE IF NOT EXISTS raw_revenue (
  source_id          TEXT NOT NULL,
  market             TEXT CHECK (market IN ('sii','otc','rotc') OR market IS NULL),
  month              TEXT NOT NULL,      -- 'YYYY-MM'
  month_idx          INTEGER NOT NULL,   -- year*12 + (month-1); integer contiguity
  ticker             TEXT NOT NULL,
  roc_yyyymm         TEXT,
  company_name       TEXT,               -- AS REPORTED (Chinese)
  industry           TEXT,
  report_date        TEXT,
  revenue_month      INTEGER,            -- 本月 / 當月營收
  revenue_prev_month INTEGER,            -- 上月營收; NULL from mops_company
  revenue_yoy_month  INTEGER,            -- 去年同期 / 去年當月營收
  src_mom_pct        REAL,               -- reported; QA cross-check only
  src_yoy_pct        REAL,               -- reported; QA cross-check only
  cum_revenue        INTEGER,            -- 本年累計
  cum_revenue_prior  INTEGER,            -- 去年累計
  src_cum_yoy_pct    REAL,               -- reported; QA cross-check only
  note               TEXT,               -- 備註 / 營收變化原因說明
  row_hash           TEXT NOT NULL,      -- over reported values only, not timestamps
  first_seen_utc     TEXT NOT NULL,
  last_seen_utc      TEXT NOT NULL,
  PRIMARY KEY (source_id, month, ticker)
);
CREATE INDEX IF NOT EXISTS ix_raw_ticker_month ON raw_revenue (ticker, month_idx);
CREATE INDEX IF NOT EXISTS ix_raw_month        ON raw_revenue (month);

-- Append-only supersession log. Written by a TRIGGER rather than by the writer,
-- so a restatement is captured whether it arrives via the Python seed or the
-- Worker cron - neither has to remember to do it.
CREATE TABLE IF NOT EXISTS raw_revenue_history (
  history_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       TEXT NOT NULL,
  month           TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  row_hash        TEXT,
  payload_json    TEXT,
  superseded_at_utc TEXT NOT NULL,
  change_reason   TEXT
);
CREATE INDEX IF NOT EXISTS ix_hist_ticker_month
  ON raw_revenue_history (ticker, month);

CREATE TRIGGER IF NOT EXISTS trg_raw_revenue_restatement
BEFORE UPDATE ON raw_revenue
-- Only fires on a genuine change to reported values. An unchanged re-fetch
-- updates last_seen_utc only, and must not create history noise.
WHEN OLD.row_hash <> NEW.row_hash
BEGIN
  INSERT INTO raw_revenue_history (
    source_id, month, ticker, row_hash, payload_json, superseded_at_utc, change_reason
  ) VALUES (
    OLD.source_id, OLD.month, OLD.ticker, OLD.row_hash,
    json_object(
      'company_name',       OLD.company_name,
      'industry',           OLD.industry,
      'report_date',        OLD.report_date,
      'revenue_month',      OLD.revenue_month,
      'revenue_prev_month', OLD.revenue_prev_month,
      'revenue_yoy_month',  OLD.revenue_yoy_month,
      'src_mom_pct',        OLD.src_mom_pct,
      'src_yoy_pct',        OLD.src_yoy_pct,
      'cum_revenue',        OLD.cum_revenue,
      'cum_revenue_prior',  OLD.cum_revenue_prior,
      'src_cum_yoy_pct',    OLD.src_cum_yoy_pct,
      'note',               OLD.note
    ),
    NEW.last_seen_utc,
    'row_hash changed: ' || substr(OLD.row_hash, 1, 12) || ' -> ' || substr(NEW.row_hash, 1, 12)
  );
END;

-- --------------------------------------------------------------- fetch_log --
-- One row per attempted fetch, cached or not. Answers "when did we last
-- successfully see this month, and from which surface?" without inference.
CREATE TABLE IF NOT EXISTS fetch_log (
  fetch_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT NOT NULL,
  month         TEXT,
  ticker        TEXT,
  url           TEXT,
  http_status   INTEGER,
  byte_len      INTEGER,
  sha256        TEXT,
  rows_parsed   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  fetched_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fetch_month ON fetch_log (month, source_id);

-- -------------------------------------------------------- quality_findings --
CREATE TABLE IF NOT EXISTS quality_findings (
  finding_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT,
  created_at_utc TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  code          TEXT NOT NULL,
  month         TEXT,
  ticker        TEXT,
  source_id     TEXT,
  message       TEXT,
  detail_json   TEXT
);
CREATE INDEX IF NOT EXISTS ix_findings_sev ON quality_findings (severity, code);

-- ============================================================== ANALYTICS ==
--
-- Metrics are a VIEW, not a materialised table, so they can never drift from
-- raw_revenue and re-seeding is idempotent by construction.
--
-- Rules encoded below:
--   * ALL percentages are recomputed from integer levels. The reported src_*_pct
--     columns are retained for cross-checking only. Recomputation is what makes
--     yoy_acceleration_ppt exactly the difference of the two YoY columns.
--   * Any non-positive or NULL denominator yields NULL - never 0, never infinity.
--   * MoM requires the immediately PRECEDING month. Without the contiguity guard,
--     a series with a hole would silently compute a two-month change and label it
--     month-over-month.
--   * The row set is universe x months, not "rows we happen to have". A company
--     with no filing for a month appears with NULL metrics rather than vanishing,
--     which is the agreed treatment for 6286 (merged into 2454, no filing
--     obligation) and makes any other gap visible instead of silent.

-- One authoritative row per (ticker, month), chosen by source precedence.
-- mops_company first: it is the brief's endpoint and the per-company query is the
-- most specific surface. Same filing seen twice must never double-count.
CREATE VIEW IF NOT EXISTS authoritative_revenue AS
SELECT * FROM (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.ticker, r.month
      ORDER BY CASE r.source_id
                 WHEN 'mops_company'   THEN 1
                 WHEN 'twse_openapi_p' THEN 2
                 WHEN 'twse_openapi_l' THEN 3
                 WHEN 'tpex_openapi_o' THEN 4
                 ELSE 9
               END,
               r.source_id          -- deterministic tie-break for unknown sources
    ) AS src_rank
  FROM raw_revenue r
)
WHERE src_rank = 1;

-- Every month observed anywhere in the data. Data-driven rather than a fixed
-- range, so the table grows with the cron and never invents empty future months.
CREATE VIEW IF NOT EXISTS month_spine AS
SELECT DISTINCT month, month_idx FROM raw_revenue;

CREATE VIEW IF NOT EXISTS analytics_base AS
WITH grid AS (
  -- universe x months, left-joined to the data: gaps become explicit NULL rows.
  SELECT
    u.ticker, u.display_name, u.name_zh, u.bucket, u.tier, u.status,
    u.successor, u.sort_order,
    s.month, s.month_idx,
    a.source_id, a.market, a.company_name AS reported_name, a.industry,
    a.report_date, a.revenue_month, a.revenue_prev_month, a.revenue_yoy_month,
    a.cum_revenue, a.cum_revenue_prior,
    a.src_mom_pct, a.src_yoy_pct, a.src_cum_yoy_pct, a.note,
    a.last_seen_utc
  FROM universe u
  CROSS JOIN month_spine s
  LEFT JOIN authoritative_revenue a
         ON a.ticker = u.ticker AND a.month_idx = s.month_idx
),
lagged AS (
  SELECT
    g.*,
    LAG(g.revenue_month) OVER w AS prev_revenue,
    LAG(g.month_idx)     OVER w AS prev_month_idx
  FROM grid g
  WINDOW w AS (PARTITION BY g.ticker ORDER BY g.month_idx)
),
computed AS (
  SELECT
    l.*,
    -- Prefer our own preceding month; fall back to the source's 上月營收 when a
    -- feed supplies it (the OpenAPI feeds do, mops_company does not). The
    -- contiguity guard is what makes the first branch safe.
    CASE
      WHEN l.prev_month_idx = l.month_idx - 1 AND l.prev_revenue > 0
        THEN 100.0 * (l.revenue_month * 1.0 / l.prev_revenue - 1.0)
      WHEN l.revenue_prev_month > 0
        THEN 100.0 * (l.revenue_month * 1.0 / l.revenue_prev_month - 1.0)
      ELSE NULL
    END AS mom_pct_raw,
    CASE
      WHEN l.revenue_yoy_month > 0
        THEN 100.0 * (l.revenue_month * 1.0 / l.revenue_yoy_month - 1.0)
      ELSE NULL
    END AS yoy_pct_raw,
    CASE
      WHEN l.cum_revenue_prior > 0
        THEN 100.0 * (l.cum_revenue * 1.0 / l.cum_revenue_prior - 1.0)
      ELSE NULL
    END AS cum_yoy_pct_raw
  FROM lagged l
),
rounded AS (
  SELECT
    c.*,
    ROUND(c.mom_pct_raw, 2)     AS mom_pct,
    ROUND(c.yoy_pct_raw, 2)     AS yoy_pct,
    ROUND(c.cum_yoy_pct_raw, 2) AS cumulative_yoy_pct
  FROM computed c
)
SELECT
  r.*,
  -- Lag the ROUNDED YoY, and gate it on contiguity for the same reason MoM is
  -- gated: across a hole, LAG would return a YoY from an unrelated month.
  -- Taking the difference of the rounded values (rather than of the raw ones)
  -- keeps the exported table internally consistent - a reader subtracting the
  -- two YoY columns gets exactly the acceleration column. The two conventions
  -- differ by at most 0.01pp, which is immaterial next to that.
  CASE
    WHEN r.prev_month_idx = r.month_idx - 1
      THEN LAG(r.yoy_pct) OVER w2
    ELSE NULL
  END AS prior_month_yoy_pct,
  CASE
    WHEN r.prev_month_idx = r.month_idx - 1 AND r.yoy_pct IS NOT NULL
         AND LAG(r.yoy_pct) OVER w2 IS NOT NULL
      THEN ROUND(r.yoy_pct - LAG(r.yoy_pct) OVER w2, 2)
    ELSE NULL
  END AS yoy_acceleration_ppt,
  CASE WHEN r.revenue_month IS NULL THEN 0 ELSE 1 END AS has_data
FROM rounded r
WINDOW w2 AS (PARTITION BY r.ticker ORDER BY r.month_idx);

-- The deliverable. EXACTLY the twelve columns specified in the brief, in order.
-- Do not add columns here - the CSV export reads SELECT * from this view, and
-- consumers depend on the column order. Extra fields belong in analytics_base.
CREATE VIEW IF NOT EXISTS analytics_monthly AS
SELECT
  ticker,
  display_name AS company_name,
  bucket,
  tier,
  month,
  revenue_month        AS revenue_twd_thousands,
  mom_pct,
  yoy_pct,
  prior_month_yoy_pct,
  yoy_acceleration_ppt,
  cum_revenue          AS cumulative_ytd_revenue_twd_thousands,
  cumulative_yoy_pct
FROM analytics_base
ORDER BY sort_order, ticker, month_idx;
