-- The ongoing-refresh feed list, mirrored from config/sources.yaml.
--
-- Why a table rather than a constant in cron.ts:
--
-- config/sources.yaml states the intent explicitly - "config, not code, so the
-- precedence is visible and editable without a deploy". A hardcoded array in the
-- Worker would be a second source of truth for the URLs and the precedence, and
-- the ONE thing that must never drift is the order: analytics_monthly's
-- source-precedence CASE and this list have to agree, or the view would prefer a
-- row the cron considers a fallback.
--
-- Rewritten wholesale by the seed, exactly like `universe`, so the YAML stays
-- authoritative. Changing a URL or demoting a feed is then a seed re-apply, not
-- a redeploy.
CREATE TABLE IF NOT EXISTS source_feed (
  source_id              TEXT PRIMARY KEY,
  role                   TEXT NOT NULL,   -- 'specified' (named in the brief) | 'fallback'
  url                    TEXT NOT NULL,
  market                 TEXT CHECK (market IN ('sii','otc','rotc') OR market IS NULL),
  expect_min_records     INTEGER NOT NULL DEFAULT 0,
  expect_target_coverage INTEGER NOT NULL DEFAULT 0,
  -- JSON array. A handful of tickers that must be present, as the cheap proof we
  -- are reading the dataset we think we are rather than a valid-looking other one.
  anchor_tickers         TEXT NOT NULL DEFAULT '[]',
  notes                  TEXT,
  -- Ascending. Position 0 must be the brief's feed; the seed asserts that.
  precedence             INTEGER NOT NULL
);

-- The month field name (資料年月) and the percent sentinel are single scalars
-- shared by both halves, so they live here rather than being retyped in TS.
CREATE TABLE IF NOT EXISTS source_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
