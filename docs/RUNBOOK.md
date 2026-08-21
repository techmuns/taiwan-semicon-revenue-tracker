# Runbook

Operating notes for the Taiwan semiconductor supply-chain revenue tracker. Read
[README.md](../README.md) first for what the thing is; this file is what to do
when something needs doing.

Live: <https://taiwan-semicon-revenue.tech-441.workers.dev>

---

## Open items

Two things are not closed, and neither can be closed from a terminal.

### 1. The URL has no access control

`/api/health` reports the posture, and the dashboard prints it in the header:

```bash
curl -s https://taiwan-semicon-revenue.tech-441.workers.dev/api/meta | grep -o '"mode":"[a-z-]*"'
```

Current mode is **`open`** — anyone with the URL reads everything, including the
bucket and tier framing, which is the proprietary part of this tracker. The
Worker supports three postures and picks whichever is configured, most specific
first (`worker/src/access.ts`):

| Mode | Set | Behaviour |
|---|---|---|
| `cf-access` | `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` | Verifies `Cf-Access-Jwt-Assertion` against the team JWKS. |
| `secret` | `DASHBOARD_KEY` | Shared key; `POST /auth {"key":"…"}` exchanges it for a session cookie, or send `X-Dashboard-Key`. |
| `open` | nothing | No access control. **Current state.** |

To take the shared-key route — one command, effective on the next request:

```bash
npx wrangler secret put DASHBOARD_KEY --cwd worker
```

Cloudflare Access is the stronger option but **cannot protect a
`*.workers.dev` hostname**. It needs a domain onboarded to the account, a Zero
Trust application over the route, and then both `CF_ACCESS_*` values set as
secrets. Until a domain exists, `secret` is the available posture.

`/api/health` stays open in every mode, deliberately: a monitor has to be able
to see "up" without a credential, and it carries no revenue figures.

### 2. There is no monthly auto-refresh

`worker/wrangler.toml` declares the schedule and the code is written and
deployed, but **the cron trigger will not register**:

```
This account has reached the Workers Free limit of 5 cron triggers per account.
```

The limit is per **account**, not per Worker, and the five are already spent on
other Workers. `crons = ["0 1 11,14,18 * *"]` is one trigger, so freeing a
single unused schedule elsewhere in the account is enough. Otherwise Workers
Paid raises the limit to 1,000.

This is the only reason the deploy prints an error. The Worker itself,
its bindings, and the assets all deploy fine — wrangler says so explicitly:
"Trigger configuration … was only partially updated". Nothing else is affected.

Until it registers, refresh by hand once a month, any time after the 10th:

```bash
npx wrangler dev --test-scheduled --cwd worker
# then, in another shell:
curl "http://localhost:8787/__scheduled?cron=0+1+11+*+*"
```

Every write is gated on `row_hash`, so running it repeatedly is harmless and
running it early is a clean no-op — the cron derives the month from the payload's
`資料年月`, never from the clock, so a feed still showing the prior month logs
and exits.

---

## Monthly refresh: what it actually does

`worker/src/cron.ts`, in order:

1. Fetches the ongoing feeds in the precedence declared in
   `config/sources.yaml` — **config, not code**, so the order is editable
   without a deploy.
2. Derives the month from `資料年月` in the payload.
3. Counts how many universe tickers each feed covers. The brief's specified
   feed, `t187ap05_P`, covers **zero** — it is the non-listed public issuer
   feed. That is recorded as a `SOURCE_EMPTY` finding rather than an error, so
   the feed behaving as observed is visible in the data instead of looking like
   a broken cron, and the fallbacks (`_L` for 上市, `_O` for 上櫃) run.
4. Upserts to `raw_revenue` tagged with `source_id`, gated on `row_hash`.
5. Falls back to the per-company MOPS endpoint for any tier-1 ticker still
   missing.
6. Writes `quality_findings`.

If `_P` ever does start carrying listed companies, the switch shows up in
`raw_revenue.source_id` with no code change.

---

## Repair path: one ticker, one month

The per-company MOPS endpoint is independent per company-month, so a repair is
one request. This is the break-glass path when a month is missing or looks wrong.

```bash
cd ingest
python -m twrev.cli backfill --from 2026-07 --to 2026-07 --tickers 3324
python -m twrev.cli show --ticker 3324
python -m twrev.cli seed --out out/seed.sql
npx wrangler d1 execute taiwan-semicon-revenue --file=../ingest/out/seed.sql --remote --cwd ../worker
```

The seed is idempotent — `ON CONFLICT … DO UPDATE … WHERE excluded.row_hash <>
raw_revenue.row_hash`, preserving `first_seen_utc` — so re-running it converges
rather than churning. A genuine restatement lands in `raw_revenue_history`; the
superseded row is kept, never overwritten.

Other CLI subcommands:

| Command | Does |
|---|---|
| `backfill --from --to [--tickers] [--offline]` | Fetch + parse a window into `ingest/cache/`. |
| `report` | Re-parse the cache offline and summarise. Free — no network. |
| `verify --month 2026-07` | Cross-check the MOPS scrape against the `_P`/`_L`/`_O` feeds. |
| `seed --out out/seed.sql` | Emit D1 SQL from the cache. |
| `show --ticker 2330` | Print one ticker's series from the cache. |

`ingest/cache/` holds the raw fetched bytes and is the real audit artifact. It is
gitignored because it is reproducible, but do not delete it casually: with it,
re-parsing is instant; without it, a full re-fetch is 296 throttled requests and
15–20 minutes.

`--offline` makes any cache miss raise. `conftest.py` forces `TWREV_OFFLINE=1`,
so the test suite provably cannot reach the network.

---

## Universe changes

`config/universe.yaml` is the single source of truth for bucket, tier, and
lifecycle. It is mirrored into the D1 `universe` table at seed time, so the
Worker and the dashboard read the same values.

A delisting, merger, or suspension is a `status` / `active_to` edit — **never a
code change**:

```yaml
- ticker: "6286"
  status: merged
  successor: "2454"
```

Then `seed` and load. `universe` is emitted as `DELETE` + re-`INSERT` inside a
transaction, so the YAML is always authoritative.

A `successor` is recorded but **never auto-spliced** into the predecessor's
series. Splicing would silently corrupt YoY, which is the number the whole
tracker is read for. `status: merged` also suppresses `MISSING_TICKER_MONTH`
findings — an absence of duty is not missing data, and 6286 Richtek is the
worked example: it appears in the universe with every cell an em dash.

Tickers are **quoted strings** in the YAML. An unquoted `2330` becomes the
integer 2330 and stops matching anything.

---

## Deploying

```bash
cd web    && npm ci && npm run build      # -> worker/public
cd worker && npx wrangler deploy
```

`web/` builds directly into `worker/public`, which the `[assets]` binding
serves, so the SPA and the API share one origin — no CORS, no second host to
keep in sync, one deploy.

`worker/public/` is **gitignored**: it is build output. The consequence for CI
is a trap worth stating plainly — a Cloudflare Workers Build with root directory
`worker` would find an empty assets directory and deploy a Worker that 404s the
dashboard. Settings that work, from the repo root:

```
build:  npm --prefix web ci && npm --prefix web run build
deploy: npx wrangler deploy -c worker/wrangler.toml
```

### Why `not_found_handling` is not set

`[assets]` leaves `not_found_handling` at its default of `none`. Setting it to
`single-page-application` makes the asset server answer every unmatched path
itself, which swallows `/api/*` before the Worker runs. The SPA fallback is done
in `worker/src/index.ts` instead, which knows which paths are API routes and
which are client-side ones. That fallback sits **ahead of the access gate** on
purpose: `/` is already served without a credential by the asset server, so
gating a deep link would break bookmarks without protecting anything, and the
shell holds no figures.

### Migrations

```bash
npx wrangler d1 migrations apply taiwan-semicon-revenue --remote --cwd worker
```

`analytics_monthly` is a **view**, not a table, so it cannot drift from
`raw_revenue` and needs no rebuild after a load.

---

## Reading the numbers correctly

These are properties of the data, not of the UI, and they are the ones that get
misread.

- **An em dash is not zero.** A null denominator yields no value, ever. "Did not
  file" and "earned nothing" are different facts, and collapsing them is the
  mistake this whole codebase is arranged to prevent — nulls break lines rather
  than being interpolated, absent months draw a hatched stub rather than a
  zero-height bar, and the coverage matrix keeps *filed* / *not filed but
  expected* / *no obligation* as three states rather than two.
- **All percentages are recomputed from the integer levels**, never copied from
  the filer's own percentage fields. Those are rounded to 2dp and computed
  against as-originally-filed prior-year figures that MOPS does not restate.
  Recomputing makes `yoy_acceleration_ppt` exactly `yoy_pct −
  prior_month_yoy_pct` instead of a difference of two independent roundings. The
  reported fields are retained in `raw_revenue` and shown in the company tab's
  "As filed" table purely as a cross-check.
- **Aggregates are revenue-weighted from levels, never an average of
  percentages**, with numerator and denominator summed over the *identical*
  member set. Summing all revenue over one set and all prior-year revenue over
  another is the failure mode: it reports a stage as growing because a member
  with no prior-year figure was counted in the numerator only.
- **The rebased bucket index holds membership constant** month to month, so a
  company joining or skipping cannot masquerade as a demand inflection.
- **January and February are excluded from outlier detection.** Lunar New Year
  moves between them and legitimately swings MoM by ±40%. Flagging that as an
  error would train you to ignore the report.
- **Dec 2025 is a shoulder month.** The per-company MOPS endpoint carries no
  上月營收, so January 2026 would have no MoM at all without holding December's
  own level; and January's `prior_month_yoy_pct` needs December's YoY. It is
  stored but excluded from the default window. Anything computing a month-over-
  month difference has to reach back into it — the bucket heatmap CTE aggregates
  one month before `from` and discards it after it has served as the `LAG`.
- **`3661` and `6415` file on a consolidated basis** with a non-TWD functional
  currency; the TWD column is taken. Their *levels* are therefore not directly
  comparable with the standalone filers. Raised as `CONSOLIDATED_BASIS` info
  findings on the Quality tab, once per company-month, so it is impossible to
  quote a level without having been told.

---

## Deliberate divergences from the dashboard-builder skill

Recorded so the divergence is traceable rather than looking like an oversight.

| Not adopted | Why |
|---|---|
| Munshot Dashboard SDK | There is no Munshot host. This is a standalone Worker on its own URL, not an iframe embed. |
| Host-owned auth | Auth is Cloudflare Access or a Worker-level shared key. There is no host to own it. |
| "Registered datasources only" | The datasource is this project's own D1. |

The skill's *structural* standards are followed as written: 3-zone shell, 48px
sticky header, `WidgetCard` for every data widget, `repeat(auto-fill,
minmax(340px, 1fr))`, indigo `#4f46e5` chrome plus grayscale, and mandatory
shimmer / empty / error states in every widget.

Its *decoration* is deliberately not followed. This dashboard is read for
eight-digit revenue figures and signed percentage points, and every gradient,
blur, and drop shadow competes with the marks for attention.

| Skill says | This dashboard | Why |
|---|---|---|
| Gradient page, `rgba(255,255,255,0.9)` surfaces, `backdrop-filter: blur(8px)` | Flat opaque `#ffffff` cards on a flat `#f4f5f7` page, no blur anywhere | The page being gray is what makes a white card read as a plane. One value instead of three effects. |
| `box-shadow` on cards; `translateY(-4px)` + 40px indigo shadow on hover | No card shadow; hover steps the border one shade darker | Nothing about a card is clickable, so the lift promised an affordance that does not exist — and on a ten-card screen, moving the pointer set off a wave of animation over the numbers being read. A shadow survives in exactly one place: the floating tooltip, where elevation is the point. |
| 16px card radius | 10px (`--radius-card`), 6px on controls | |
| Five pastel category badges in card headers | Deleted, along with the `category` prop | It put more saturated color in the chrome than the charts had in their data, against a taxonomy a single-purpose dashboard does not have. |
| 15px title / 14px widget title / 14px body | 13px base, 13px title, 12.5px widget title | A denser instrument. |
| Pill segmented control for tab navigation | Underlined tabs | Navigation and controls should not look alike; there are two real pill controls inside the widgets below. |
| `all 0.35s` transitions | `0.14s`, border-color only | 350ms on chrome reads as a consumer app, not an instrument. |
| One card per metric | Seven KPI cards → one "Summary" card; ten per-stage cards → one "Stage index" card | Both were facets of one thing wearing ten frames. Panels are divided by the grid's own 1px gaps showing the container color through — per-cell borders dangle at a wrapped row's end. |

Charts are hand-rolled SVG rather than a library, because a library would take
away the three things that matter most here: a null that **breaks** a line
instead of being interpolated or zeroed, exact mark specs, and the absence of a
dual-axis escape hatch. Revenue and growth are two charts, never one chart with
two y-scales.

The categorical palette was run through the dataviz validator before any chart
code was written. It passes the lightness band, chroma floor, CVD separation
(worst pair ΔE 9.2, deutan) and the normal-vision floor (ΔE 27.6). The third hue
WARNs on contrast: **2.82:1** against the now-white chart surface (it was 2.74:1
against the old `#f8f9fa`), under the 3:1 floor. That WARN is not dismissable, so
the relief ships — every series is direct-labelled at its last real point, and
every chart has a table view one click away.

### Graph or table

Every *chart* widget can be redrawn as a table of numbers. Two reasons, and only
the first is aesthetic:

1. It discharges the contrast WARN above with something better than a hope that
   the reader can distinguish aqua from the surface.
2. A figure that is going to be quoted should be **read**, not estimated off an
   axis.

Rules the implementation holds to:

- **Graph is the default.** The URL carries `viz=table` only when the mode has
  been changed; `viz=chart` is never written.
- **One toggle per screen**, never one per card. Overview and Acceleration each
  have a single chart widget, so it sits in that widget's header. The Company tab
  has three, so it sits in that tab's own selector row. The Buckets tab's ten
  stage panels are facets of one card, so it sits in that card's header — this is
  the reason those ten cards were collapsed into one.
- **Both views take the same data**, in the same shape, from the same fetch
  (`MatrixTable` takes the `HeatRow[]` the `Heatmap` takes; `SeriesTable` takes
  the aligned arrays the charts take). They cannot disagree.
- **The Data and Quality tabs have no toggle** and this is not an omission. The
  Data tab *is* the table view — column for column identical to the CSV export —
  and drawing twelve columns of mixed units as one chart would need a dual axis.
  The Quality tab holds coverage states and log rows, not series.
- Table mode adds what a chart cannot show: the stage index table carries the
  per-month **constant-membership count** as a second column, so a month that is
  thin rather than weak is visible rather than inferred.

---

## API

All read-only. `GET` only; anything else returns 405.

| Route | Notes |
|---|---|
| `/api/health` | Always open. Row counts and the D1 binding. |
| `/api/meta` | Universe, buckets, tiers, month range, freshness, access posture. |
| `/api/analytics?from&to&tickers&buckets&tiers&only_with_data` | The twelve columns, in spec order. |
| `/api/heatmap?metric&group=bucket\|ticker&agg=weighted\|equal` | Aggregated cells. |
| `/api/company/:ticker` | Full series, raw rows, restatements. |
| `/api/quality` | Coverage matrix, findings, fetch log. |
| `/api/export.csv?…` | The twelve columns with a UTF-8 BOM so Excel opens it correctly. |

Responses carry `Cache-Control: public, max-age=300`. The data changes monthly,
so this is nearly free — but it does mean **a redeploy is not visible in a
browser for up to five minutes**. When verifying a fix, bypass it:

```bash
curl -s "https://taiwan-semicon-revenue.tech-441.workers.dev/api/heatmap?metric=yoy_acceleration_ppt&group=bucket&from=2026-01"
```

`fetch(url, {cache: 'reload'})` from the page console does the same and also
refreshes the browser's entry, so a subsequent reload of the app shows the new
values. Note the cache key is the **exact URL including parameter order** — the
SPA sends `?from=…&metric=…&group=…&agg=…`, so a hand-built URL with the
parameters in a different order is a different entry and will look fresh while
the app still shows stale numbers.

---

## Verification gates

The golden-number checks are the important ones. Both reproduce in Python, in
D1, and in the dashboard.

**2330 / 2026-03**, from the per-company MOPS endpoint:

```
revenue_twd_thousands  415191699    <- exactly this, not 415191700
revenue_yoy_month      285956830
yoy_pct                45.19
cumulative_ytd        1134103440
cum_revenue_prior      839253664
cumulative_yoy_pct     35.13
```

The `...699` matters: `pandas.read_html` displays `4.151917e+08`, which rounds
the true figure. The parser reads the comma-separated string, and a test asserts
the exact integer specifically to keep that bug from coming back. In the UI the
exact value is the hover title on the revenue cell; the visible text is
`NT$415.19bn`.

**2330 / 2026-07**, from the OpenAPI feed: `467580548`, `mom_pct 5.62`,
`yoy_pct 44.69` (MOPS reports `44.68` — a 0.01pp rounding delta that must fall
inside the 0.05pp tolerance and **not** raise a finding), `cumulative_ytd
2872064238`, `cumulative_yoy_pct 37.01`.

Because those two come from different endpoints, agreeing on the shared series
is itself the cross-source proof.

Then:

```bash
python -m twrev.cli verify --month 2026-07     # zero SOURCE_DISAGREEMENT findings
curl -s .../api/export.csv | head -1           # exact 12-column order
curl -s .../api/quality                        # 288 of 288 expected cells; 8 known-absent (6286)
```

Coverage as of the 2025-12 → 2026-07 backfill: **288 of 288** expected
company-months present, 100.0%. The eight absent cells are 6286, by design.
