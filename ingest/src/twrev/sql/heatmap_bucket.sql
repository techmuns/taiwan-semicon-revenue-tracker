-- The bucket heatmap. THE ONE COPY.
--
-- Lifted verbatim out of worker/src/api.ts when the dashboard left Cloudflare
-- D1. Not one character of the statement changed in the move: it is byte-for-
-- byte what shipped and what ingest/tests/test_heatmap_sql.py has been
-- executing against a SQLite database built from worker/migrations/*.sql all
-- along. D1 is Cloudflare's hosted SQLite, so "porting" it was never required -
-- only rehosting it.
--
-- WHY IT IS A FILE NOW. It used to be a template literal inside a TypeScript
-- function, reachable only by a regex that scraped api.ts. That regex was the
-- single most fragile thing in the test suite - its own docstring warned that a
-- restructure would silently orphan the only executable test of the most
-- defect-prone code in the repository (a sign inversion that reported a stage
-- growing +10.0% as -26.67%, a member count describing the wrong set, and a
-- churn flag comparing against a month that was not the prior one - all three
-- found in production). A file has no such failure mode.
--
-- TWO PLACEHOLDERS, substituted by the caller exactly as api.ts substituted them:
--   ${sql}      the WHERE clause built from the request filters
--   ${pairSql}  the consolidation CTE, or a pass-through `scoped` when there is
--               no consolidation to apply
--
-- THE INVARIANT. Every ratio's numerator and denominator are summed over a
-- predicate TEXTUALLY IDENTICAL to its members_* counter. That is not a style
-- rule; it is what stops a member landing in a denominator whose numerator
-- excludes it. Changing one of a triple and not the others is how the sign
-- inversion happened. Compare all three before editing any of them.
WITH all_rows AS (
       -- The filtered universe, materialised ONCE so the de-duplication and the
       -- membership comparison can both reuse it without binding the filter
       -- parameters again.
       SELECT * FROM analytics_base b WHERE ${sql}
     )${pairSql},
     member AS (
       -- Who is actually behind the weighted YoY in each bucket-month. Same
       -- predicate as members_yoy, so this is that set enumerated rather than
       -- merely counted.
       SELECT bucket, month_idx, ticker FROM scoped
        WHERE revenue_month IS NOT NULL AND revenue_yoy_month > 0
     ),
     churn AS (
       /*
        * Did the member SET change against the IMMEDIATELY PRECEDING month?
        *
        * This replaces comparing LAG(members_yoy) - the count - which was wrong
        * twice. A 1-for-1 swap changes the set without changing its size: blank
        * 8081's July row and add 6286's, and Analog Cycle goes from
        * {4919,6138,6415,8081} to {4919,6138,6286,6415} with the count still 4,
        * so the caveat never appeared over an acceleration differencing two
        * different sets. And LAG walks to the previous PRESENT row, which is not
        * the previous month when a whole stage files nothing - blank Networking's
        * only member in June and July's flag was computed against MAY while the
        * tooltip said "vs prior month".
        *
        * Joining on month_idx - 1 makes adjacency structural rather than a gate
        * that can be forgotten, and comparing tickers makes it identity rather
        * than size.
        */
       SELECT bucket, month_idx, SUM(chg) AS changed FROM (
         SELECT m.bucket AS bucket, m.month_idx AS month_idx, 1 AS chg
           FROM member m LEFT JOIN member p
             ON p.bucket = m.bucket AND p.ticker = m.ticker
            AND p.month_idx = m.month_idx - 1
          WHERE p.ticker IS NULL
         UNION ALL
         SELECT p.bucket AS bucket, p.month_idx + 1 AS month_idx, 1 AS chg
           FROM member p LEFT JOIN member m
             ON m.bucket = p.bucket AND m.ticker = p.ticker
            AND m.month_idx = p.month_idx + 1
          WHERE m.ticker IS NULL
       ) GROUP BY bucket, month_idx
     ),
     per_bucket AS (
       SELECT b.bucket, b.month, b.month_idx,
              SUM(CASE WHEN b.revenue_month IS NOT NULL THEN 1 ELSE 0 END) AS members,
              SUM(b.revenue_month) AS revenue,

              -- Each pair's predicate is TEXTUALLY IDENTICAL to its members_*
              -- counter, which is the only way the invariant above is actually
              -- enforced rather than merely asserted. Gating the denominator on
              -- a weaker predicate than the numerator is what breaks it: SUM
              -- skips a NULL numerator silently while the denominator still
              -- counts that member, so the ratio is computed over two different
              -- sets and the members_* count describes only one of them.
              --
              -- MoM was the live case. analytics_base is universe CROSS JOIN
              -- month_spine, and prev_revenue is a LAG over that dense grid, so
              -- it survives on a row where revenue_month is NULL - a company
              -- that filed last month but has not filed this one landed in
              -- mom_den alone. A bucket with A (1,000,000 -> 1,100,000) and B
              -- (500,000, not yet filed) reported -26.67% instead of +10.00%.
              -- That is the normal state between the 11th and 14th cron runs,
              -- which exist precisely to sweep up late filers.
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN b.revenue_month END)     AS yoy_num,
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN b.revenue_yoy_month END) AS yoy_den,
              SUM(CASE WHEN b.revenue_month IS NOT NULL AND b.revenue_yoy_month > 0
                       THEN 1 ELSE 0 END) AS members_yoy,

              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN b.revenue_month END) AS mom_num,
              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN b.prev_revenue END)  AS mom_den,
              SUM(CASE WHEN b.revenue_month IS NOT NULL
                            AND b.prev_month_idx = b.month_idx - 1 AND b.prev_revenue > 0
                       THEN 1 ELSE 0 END) AS members_mom,

              -- The EQUAL-weighted MoM averages b.mom_pct, and mom_pct is NOT the
              -- same set as members_mom above. The view computes it from our own
              -- preceding month when there is one and FALLS BACK to the source's
              -- 上月營收 when there is not - a branch the OpenAPI feeds populate
              -- and the per-company MOPS scrape does not. So a company that filed
              -- this month but skipped last month has a mom_pct and is in the
              -- average, while members_mom excludes it.
              --
              -- Reproduced on the live store: drop 4919's June row and give its
              -- July row a 上月營收, and Analog Cycle's equal-weighted MoM is the
              -- mean of FOUR companies while members_mom reports three. That is
              -- the normal state between the 11th and 14th refresh passes, which
              -- exist precisely to sweep up late filers.
              COUNT(b.mom_pct) AS members_mom_equal,

              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN b.cum_revenue END)       AS cum_num,
              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN b.cum_revenue_prior END) AS cum_den,
              SUM(CASE WHEN b.cum_revenue IS NOT NULL AND b.cum_revenue_prior > 0
                       THEN 1 ELSE 0 END) AS members_cum,

              AVG(b.yoy_pct) AS yoy_equal,
              AVG(b.mom_pct) AS mom_equal
         FROM scoped b
        GROUP BY b.bucket, b.month, b.month_idx
       HAVING members > 0
     ),
     calc AS (
       SELECT p.*,
         COALESCE(ch.changed, 0) AS members_churned,
         CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
              THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END AS yoy_weighted,
         CASE WHEN p.members_mom > 0 AND p.mom_den > 0
              THEN ROUND(100.0 * (p.mom_num * 1.0 / p.mom_den - 1.0), 2) END AS mom_weighted,
         CASE WHEN p.members_cum > 0 AND p.cum_den > 0
              THEN ROUND(100.0 * (p.cum_num * 1.0 / p.cum_den - 1.0), 2) END AS cum_yoy_weighted,
         LAG(p.month_idx)   OVER w AS prev_idx,
         LAG(CASE WHEN p.members_yoy > 0 AND p.yoy_den > 0
                  THEN ROUND(100.0 * (p.yoy_num * 1.0 / p.yoy_den - 1.0), 2) END) OVER w
           AS prev_yoy_weighted,
         LAG(ROUND(p.yoy_equal, 2)) OVER w AS prev_yoy_equal
       FROM per_bucket p
       LEFT JOIN churn ch ON ch.bucket = p.bucket AND ch.month_idx = p.month_idx
       WINDOW w AS (PARTITION BY p.bucket ORDER BY p.month_idx)
     )
     SELECT bucket, month, revenue,
            members, members_yoy, members_mom, members_mom_equal, members_cum,
            -- Gated on the same contiguity as the acceleration it caveats: with
            -- no adjacent prior month there is no "vs prior month" to speak of,
            -- and the acceleration is null there anyway.
            CASE WHEN prev_idx = month_idx - 1 THEN members_churned END AS members_churned,
            yoy_weighted, mom_weighted, cum_yoy_weighted,
            ROUND(yoy_equal, 2) AS yoy_equal, ROUND(mom_equal, 2) AS mom_equal,
            -- Contiguity-gated exactly as the per-ticker view gates it: across a
            -- hole, LAG would difference two non-adjacent months.
            CASE WHEN prev_idx = month_idx - 1
                 THEN ROUND(yoy_weighted - prev_yoy_weighted, 2) END
              AS acceleration_weighted,
            CASE WHEN prev_idx = month_idx - 1
                 THEN ROUND(ROUND(yoy_equal, 2) - prev_yoy_equal, 2) END
              AS acceleration_equal
       FROM calc
      WHERE month >= ?
      ORDER BY bucket, month
