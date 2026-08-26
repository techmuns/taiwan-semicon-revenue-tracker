# Runbook

Operating notes for the Taiwan semiconductor supply-chain revenue tracker. Read
[README.md](../README.md) first for what the thing is; this file is what to do
when something needs doing.

Live: <https://taiwan-semicon-revenue.tech-441.workers.dev>

---

## The monthly refresh runs on GitHub Actions

`.github/workflows/refresh.yml`, on the 11th, 14th and 18th at 01:00 UTC, plus
`workflow_dispatch` for a manual run. It scrapes MOPS for every company, reads
the three OpenAPI feeds as a second opinion, and writes a SQLite store.

```bash
# manual run, from the Actions tab or:
gh workflow run refresh -f month=2026-08

# locally, against a scratch store:
PYTHONPATH=ingest/src python -m twrev.cli refresh --db /tmp/test.sqlite --month 2026-07
```

### Why it is not a Cloudflare cron

Because that never ran. The account is at the Workers Free ceiling of **5 cron
triggers per account** — the limit is per account, not per Worker, and the five
were already spent elsewhere — so every `wrangler deploy` ended with:

```
This account has reached the Workers Free limit of 5 cron triggers per account.
[code: 10072]
```

The scheduled handler was therefore never registered and not one refresh ever
fired. A GitHub Actions schedule has no such cap.

It is also the better home on the merits. The Worker had a subrequest budget,
which is why its repair path fetched MOPS for **tier-1 names only**; a runner has
none, so the Actions run scrapes all 36 trackable names from MOPS *and* reads the
feeds. That is what finally gives the cross-source check something to compare —
see below.

To be clear about what this did **not** fix: this project was never near a rate
limit. The store is 296 rows and ~192 KB against D1's 5M-row-reads/day free
tier. What was exhausted was a quota on *scheduled jobs*, nothing else.

### The store

A SQLite file, `data/pipeline.sqlite`, carried on the orphan branch
`pipeline-state` and force-pushed on every run. Force-push is deliberate: the
branch holds state, not history, so a fresh single commit each month keeps the
repository from growing a binary revision forever.

It is the **same schema D1 runs** — `store.connect()` applies
`worker/migrations/*.sql` verbatim. The two engines were diffed before the
switch: 296 company-months × 12 columns of `analytics_monthly`, **zero
divergences**. `store.py` still describes itself as a verification harness in
its docstring; that is how it began, and it is now the store of record.

A first run with no `pipeline-state` branch is the bootstrap case, not an error:
`refresh` creates the file from the migrations.

### Cross-source checking is real now

Under the Worker it was structurally impossible. The feeds partition the
universe — `t187ap05_L` carries 31 of the 37, `mopsfin_t187ap05_O` the other 5,
and a company is 上市 or 上櫃 but never both — while `t187ap05_P`, the feed the
brief names, carries **none** of them (it is the 公開發行公司 dataset). MOPS only
ran for names the feeds had already missed, so no company-month was ever held by
two sources and `openapi.compare` had nothing to compare.

Scraping every name via MOPS *and* reading the feeds gives the same cell from two
independent renderings of one filing. A verified run: **36 company-months carried
by two sources, 0 disagreements**. A disagreement raises
`SOURCE_DISAGREEMENT`, which reaches the reader through `AlertStrip` on every
tab.

### What fails the run, and what does not

Three passes a month exist because filers trickle in and MOPS is intermittent.
So a straggler is not a failure:

- Up to `MAX_SOFT_FAILURES` (3) missing cells → warn, exit 0, next pass collects them.
- More than that, or any non-`FETCH_FAILED` error finding → exit 1.
- Golden checks (`2330/2026-03`) failing → exit 1, nothing persisted.

The golden gate is **skipped** when the store does not yet contain the reference
cell, since on a fresh store its absence means "new store", not "bad data".

MOPS serves a block page on first contact and the real page on retry — expect
`rejected` in the fetcher stats to run at roughly one per cell. `refresh` also
does one explicit retry pass over cells that exhausted their attempts.

### MOPS is User-Agent sniffed — do not "tidy" the headers

MOPS returns *"FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED"* to a default
`curl` agent **and to a Linux Chrome agent**. It serves data only to the Windows
Chrome UA in `http.py:DEFAULT_HEADERS`. This is UA sniffing, not an IP block —
cloud runners are fine. Those headers are load-bearing.

### GitHub disables schedules after 60 days of repo inactivity

A real hazard for a monthly job on a quiet repo: the workflow silently stops
firing. `workflow_dispatch` is the manual escape hatch, and any push resets the
clock.

### Expect two restatements on the first production refresh

`3661` and `6415` file their 備註 note in the layout `RE_NOTE_KY` handles, which
was added in `a976750` — *after* the current D1 rows were seeded. So the live
rows carry `note = NULL` for those two and the refreshed rows carry the real
text, which changes `row_hash` and trips the restatement trigger.

Verified: 34 of 36 company-months are byte-identical to D1 including `row_hash`;
the two that differ, differ only in `note` and its hash, and the note is
genuinely present in the MOPS bytes. This is the parser fix landing, **not** a
filer revision. It will happen once.

---

## Access

The posture is **derived from which secrets are set**, never hardcoded, and the
running service states it — `/api/meta` reports `access.mode`, and a 401 carries an
`X-Access-Mode` header. Most specific wins (`worker/src/access.ts`):

| Mode | Set | Behaviour |
|---|---|---|
| `cf-access` | `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` | Verifies `Cf-Access-Jwt-Assertion` against the team JWKS. |
| `secret` | `DASHBOARD_KEY` | Shared key, exchanged at `POST /auth` for an HttpOnly cookie. |
| `open` | nothing | No access control. **Current state.** |

Current mode is **`open`** — anyone with the URL reads everything, including the
bucket and tier framing. This is a decision, not an oversight: the key was set on
2026-08-21 and **deliberately removed on 2026-08-22** at the owner's instruction,
because the tracker is to work without a credential. Check the posture at any time,
without one:

```bash
curl -s https://taiwan-semicon-revenue.tech-441.workers.dev/api/meta | grep -o '"mode":"[a-z-]*"'
```

The dashboard states it too: the header shows an amber **open access** chip whenever
`/api/meta` reports `public: true`, which exists so that "we left it public and
forgot" cannot be the silent state.

### Turning a key back on

One command, effective on the next request, no deploy and no code change:

```bash
npx wrangler secret put DASHBOARD_KEY --cwd worker
```

Everything on the reading end is already built and stays in the bundle:

- Any `/api/*` 401 puts the SPA on its unlock screen
  (`web/src/components/KeyGate.tsx`) rather than six identical "unauthorized" cards.
  The key is POSTed once — never a query string, which would land in browser
  history, in any intermediary's logs, and in Cloudflare's own request logs — and
  exchanged for a 30-day HttpOnly `twrev_session` cookie. Nothing is written to
  `localStorage`.
- `Lock` in the header appears only in `secret` mode. It hits `/logout` and clears
  the cookie — the only way to end a session on a shared machine before the 30 days
  elapse.
- Re-running `secret put` with a new value locks out every existing session at once,
  because each cookie holds the old value. Rotation is also revocation.

To go back to open, delete it:

```bash
npx wrangler secret delete DASHBOARD_KEY --cwd worker
```

A secret change deploys a new Worker version by itself. It does **not** need a
`wrangler deploy` and it does not touch the assets — which is worth knowing, because
a `Source: Secret Change` entry in `wrangler deployments list` is how a posture flip
shows up in the deploy history.

**The five-minute lag.** Successful `/api/*` responses are `max-age=300`, so turning
a key on does not lock an open tab out immediately: it keeps serving cached 200s
until they expire, and the first thing to 401 is a route that tab had never fetched.
A 401 itself is `no-store`, so nothing caches the rejection. This is exactly how the
2026-08-21 flip surfaced — as a lone `/api/company/5347 · HTTP 401` on a dashboard
whose other tabs still looked fine.

### Why not Cloudflare Access

It is the strongest of the three and it **cannot protect a `*.workers.dev`
hostname** — it needs a domain onboarded to the account, a Zero Trust application
over the route, then both `CF_ACCESS_*` values as secrets. No domain is onboarded,
so it is unavailable regardless of preference. The `cf-access` path is written and
tested; it needs only the two secrets to take over, with no code change.

`/api/health` stays open in every mode, deliberately: a monitor has to be able to
see "up" without a credential, and it carries no revenue figures. So does `/`
itself — the asset server answers it before the Worker runs, and the shell holds no
figures.

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
6. Writes `quality_findings`. Anything at `error` or `warn` reaches the reader
   automatically: `/api/meta.alerts.severe_findings` carries it and `AlertStrip`
   draws it above the content on every tab. `info` findings stay out of the UI —
   each one is already stated in `universe.notes` on the company it concerns.

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
python -m twrev.cli seed --from 2026-07 --to 2026-07 --out out/seed.sql
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
| `seed --from --to --out out/seed.sql` | Emit D1 SQL from the cache. The window is required, and scopes the idempotent DELETEs. |
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
cd worker && npx wrangler login           # pick the account below
cd worker && npx wrangler deploy
```

### Which account, and why it is pinned

The live service is in the account behind `taiwan-semicon-revenue.tech-441.workers.dev`:

```
a441977d2344922f96303859b74754d8
```

`wrangler.toml` pins that as `account_id`. Before it did, the target came from
whatever `CLOUDFLARE_ACCOUNT_ID` / `CF_ACCOUNT_ID` was in the shell, and a shell
holding another account's token did **not** fail — `wrangler deployments list`
returned `This Worker does not exist on your account [code: 10007]`, which means
`deploy` would have *created* a second Worker of the same name at a different
`*.workers.dev` hostname, bound to a `database_id` that account cannot read. The
deploy reports success; the real dashboard goes on serving stale code. Pinned,
the same wrong token now fails loudly with `Authentication error [code: 10000]`.

An account ID is not a secret — it is in every dashboard URL, which is where to
find it: `https://dash.cloudflare.com/<account-id>/home`. The API token is the
secret, and belongs in the environment or `wrangler secret`, never in the repo.

Confirm you are in the right account **before** deploying. This must list the
existing Worker rather than erroring:

```bash
npx wrangler deployments list --cwd worker
```

Then confirm the deploy actually landed — `/api/*` is cached for five minutes,
so use curl rather than the browser:

```bash
B=https://taiwan-semicon-revenue.tech-441.workers.dev
curl -s -o /dev/null -w 'invalid filter -> %{http_code} (want 400)\n' "$B/api/analytics?tickers=2330.TW&from=2026-07"
curl -s -o /dev/null -w 'unknown ticker -> %{http_code} (want 404)\n' "$B/api/company/2338"
```

`npx wrangler rollback` reverts to the previous version if anything looks wrong.

### The cron error on every deploy is expected — for now

The deploy still prints `This account has reached the Workers Free limit of 5
cron triggers per account`, because `worker/wrangler.toml` still declares
`crons`. It is not a failed deploy — wrangler says so itself: "Trigger
configuration … was only partially updated" — and the Worker, its bindings and
the assets all land. Do not retry on account of it.

The refresh no longer depends on that trigger ever registering; it runs on
GitHub Actions. The `crons` line and `worker/src/cron.ts` come out when the
Worker is stripped back to `/health` plus assets, at which point this error
stops appearing.

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
  findings, once per company-month. The UI reads those findings back through
  `/api/meta.alerts.consolidated` and footnotes the two places a level is
  actually summed - the Summary revenue tile and the Data table - rather than
  listing them, so it is impossible to quote a level without having been told.
  The list is derived from the findings, not hardcoded, so a third such filer
  footnotes itself.

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
- **The Data tab has no toggle** and this is not an omission. It *is* the table
  view — column for column identical to the CSV export — and drawing twelve
  columns of mixed units as one chart would need a dual axis.
- Table mode adds what a chart cannot show: the stage index table carries the
  per-month **constant-membership count** as a second column, so a month that is
  thin rather than weak is visible rather than inferred.

### Light and dark

The bulb in the header switches theme. Three rules make it behave:

- **Absent means follow the OS.** Only an explicit choice is stored, so a
  first-time visitor gets whatever their machine already asked for. The bulb then
  writes `twrev_theme` to `localStorage`, and that wins over the OS in *both*
  directions — the `:not([data-theme="light"])` guard in `tokens.css` is what lets
  an explicit light choice beat an OS set to dark.
- **Theme is deliberately NOT in the URL.** Every other piece of view state is,
  so a view can be sent to someone and arrive identical. Theme is a property of
  the *reader*, not the view: a link carrying it would impose your theme on
  whoever opened it.
- **No flash.** A blocking inline script in `index.html` stamps the attribute
  before first paint. The bundle is deferred, so without it a dark-theme reader
  would get one white frame on every navigation.

**The dark palette is selected, not flipped.** Its steps were chosen for the dark
surface and validated against it — reusing the light hexes *fails* the palette
validator (orange `#eb6834` sits at OKLCH L 0.671, outside the dark lightness
band). The three series slots pass every check in both modes, and in dark they
also clear 3:1, which retires the aqua contrast WARN that light mode carries.

The diverging heatmap **inverts**. In light, magnitude reads as darkness: the
midpoint is the lightest step and the extremes are darkest. On a dark surface
near-zero must recede toward the *surface*, so the ramp turns over — midpoint
`#383835`, extremes lightest. The arms stay OKLCH lightness-mirrored (the one new
value, `#ea9a94`, was computed as the mirror of `seq-250` at the categorical-red
hue, the same method the light red arm used).

That inversion drags the ink with it, which is why `scale.ts` now reads
`--ink-on-div-0..3` instead of a hardcoded `#ffffff`:

| Mode | bands 0, ±1 | ±2 | ±3 |
|---|---|---|---|
| Light | dark ink | dark ink | **white** |
| Dark | **white** | dark ink | dark ink |

The old literal would have printed white on a pale blue cell.

The dark tokens are declared under two scopes (a media query for the OS, an
attribute selector for the toggle) because CSS cannot fold a media query into a
selector list. `web/scripts/check-theme-parity.mjs` asserts the two blocks declare
the same tokens with the same values, so the duplication cannot drift:

```bash
node web/scripts/check-theme-parity.mjs
```

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
| `/api/quality` | Coverage matrix, findings, fetch log. **Operator-only — no UI reader.** Kept because this table is the record when a cron run looks wrong, and the post-deploy check below curls it. What a reader needs from it rides on `/api/meta.alerts` instead. |
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
is itself the cross-source proof. Note this is a proof done **by hand, once**:
there is no standing cross-source check in the dashboard, because no ticker is
ever carried by two feeds. `t187ap05_L` (上市) covers 31 of the universe and
`mopsfin_t187ap05_O` (上櫃) covers the other 5, and a company is one or the
other; `t187ap05_P`, the brief's specified feed, carries none of them. The MOPS
repair pass only fetches names the feeds missed. Verified live 2026-08-25: zero
tickers appear in more than one feed. A standing check would need a deliberate
spot-check fetch of names a feed already covered.

Then:

```bash
python -m twrev.cli verify --month 2026-07     # zero SOURCE_DISAGREEMENT findings
curl -s .../api/export.csv | head -1           # exact 12-column order
curl -s .../api/quality                        # 288 of 288 expected cells; 8 known-absent (6286)
```

Coverage as of the 2025-12 → 2026-07 backfill: **288 of 288** expected
company-months present, 100.0%. The eight absent cells are 6286, by design.
