# taiwan-semicon-revenue-tracker

Monthly revenue for 37 Taiwan-listed names across the AI/semiconductor supply
chain, bucketed by supply-chain stage and read through **YoY acceleration**
rather than raw growth.

**Live:** <https://taiwan-semicon-revenue.tech-441.workers.dev>

Taiwan is unusual in requiring **monthly** revenue disclosure by the 10th of the
following month. That makes it the fastest read on AI capex flowing through real
hardware — months ahead of US quarterly reporting. The question this is built to
answer is not "who is growing" but **which stage of the chain is inflecting, and
in what order**: silicon → packaging/test → substrate → rack/ODM → networking →
thermal → power → equipment, against a legacy-node control group and the analog
cycle.

A company at a steady +45% YoY is not news. A company that went from +20% to
+45% is.

## The universe

37 tickers, 10 stages, two tiers of signal quality (27 tier-1, 10 tier-2).

| Stage | n | | Stage | n |
|---|--:|---|---|--:|
| AI Silicon | 3 | | Thermal | 4 |
| Advanced Packaging / Test | 4 | | Power / Data Center Electrical | 3 |
| Substrate / AI PCB / Materials | 5 | | Semi Equipment / Consumables | 3 |
| Rack / ODM | 6 | | Legacy / Mature Node Control Group | 3 |
| Networking | 1 | | Analog Cycle | 5 |

36 are active filers. `6286` Richtek is kept in the universe with `status:
merged` — MOPS reports 不繼續公開發行, absorbed into MediaTek, so the filing
obligation ended. It renders as em dashes everywhere rather than being dropped,
because a name vanishing from a tracker is indistinguishable from a name that
never mattered.

`config/universe.yaml` is the single source of truth for stage, tier, and
lifecycle. A delisting is a YAML edit, never a code change.

## Layout

```
config/universe.yaml   the editable ticker universe, shared by both halves
config/sources.yaml    endpoint URLs + ongoing-source precedence
ingest/                Python 3.12 - one-time backfill + per-ticker repair tool
worker/                Cloudflare Worker - JSON API, monthly cron, static assets
web/                   React + Vite + TS dashboard, built into worker/public
docs/RUNBOOK.md        operations, open items, how to read the numbers
```

The split is on **request volume**, which the source choice dictates. The
backfill is 296 serially-throttled HTML requests — far beyond a Worker's CPU and
subrequest limits — so it runs off-platform in Python and emits idempotent SQL.
The ongoing refresh is a single JSON GET, so it is Worker-native. Both halves are
UTF-8 end to end.

## Data model

`raw_revenue` holds the scrape unmodified, keyed `(source_id, month, ticker)`, so
every derived number has an as-filed row behind it and cross-source disagreement
is detectable rather than averaged away. Restatements append to
`raw_revenue_history`; a superseded row is kept, never overwritten.

`analytics_monthly` is a **view**, not a copy, so it cannot drift from the raw
layer. It emits the twelve specified columns:

```
ticker, company_name, bucket, tier, month, revenue_twd_thousands,
mom_pct, yoy_pct, prior_month_yoy_pct, yoy_acceleration_ppt,
cumulative_ytd_revenue_twd_thousands, cumulative_yoy_pct
```

Three rules are load-bearing, and [docs/RUNBOOK.md](docs/RUNBOOK.md) explains
each in full:

- **An em dash is not zero.** A non-positive or absent denominator yields NULL,
  never `0` and never `inf`. "Did not file" and "earned nothing" are different
  facts. Nulls break lines rather than being interpolated; absent months draw a
  hatched stub rather than a zero-height bar; the coverage matrix keeps *filed* /
  *not filed but expected* / *no obligation* as three states rather than two.
- **Every percentage is recomputed from the integer levels**, never copied from
  the filer's own percentage fields — so `yoy_acceleration_ppt` is exactly
  `yoy_pct − prior_month_yoy_pct` and not a difference of two roundings. The
  reported fields are retained purely as a cross-check, and shown as such.
- **Aggregates are revenue-weighted from levels**, never an average of
  percentages, with numerator and denominator summed over the identical member
  set. The rebased stage index holds membership constant month to month, so a
  company joining or skipping cannot masquerade as a demand inflection.

## Quickstart

```bash
# backfill (296 requests, ~15-20 min, resumable, cached to ingest/cache/)
cd ingest && pip install -r requirements.txt
python -m twrev.cli backfill --from 2025-12 --to 2026-07
python -m twrev.cli seed --from 2025-12 --to 2026-07 --out out/seed.sql

# load
cd ../worker && npx wrangler d1 migrations apply taiwan-semicon-revenue --remote
npx wrangler d1 execute taiwan-semicon-revenue --file=../ingest/out/seed.sql --remote

# dashboard + deploy
cd ../web && npm ci && npm run build     # -> worker/public
cd ../worker && npx wrangler deploy
```

Dec 2025 is fetched as a shoulder month for two independent reasons: the
per-company MOPS endpoint carries no 上月營收, so January 2026 has no MoM without
holding December's own level; and January's `prior_month_yoy_pct` needs
December's YoY. It is stored and excluded from the default window.

## The dashboard

Six tabs, one shared filter state, all of it in the URL — so any view can be
sent to someone else and arrive identical.

| Tab | What it answers |
|---|---|
| Overview | Which stage of the chain is inflecting, and a summary of the latest month |
| Acceleration | Company × month, strongest latest month first |
| Company | One name: series, and the as-filed rows every number came from |
| Buckets | Rebased revenue index per stage, ten facets on one shared scale |
| Data | The twelve columns, sortable, identical to the CSV export |
| Quality | Coverage, findings, interior gaps, cross-source agreement |

Every chart can be **redrawn as a table of numbers** — one toggle per screen,
graph by default, `viz=table` in the URL when it isn't. It exists because a
figure that is going to be quoted should be read rather than estimated off an
axis, and because it is the accessibility relief for the one series hue that
falls under the 3:1 contrast floor. Nulls render as an em dash and never as
zero, in either view.

## Tests

```bash
cd ingest && python -m pytest
```

The network is touched in exactly one place — `CachedFetcher.get` — and
`conftest.py` forces `TWREV_OFFLINE=1`, so the suite provably cannot reach it.
Fixtures are real captured bytes, including the 6286 不繼續公開發行 response and a
not-yet-published month. The golden-row test asserts `revenue_month ==
415191699` and specifically **not** `415191700`: `pandas.read_html` displays
`4.151917e+08` and rounds the true figure, so the parser reads the
comma-separated string and the test keeps that bug from returning. Tickers are
asserted to be strings, because integer coercion of `"2330"` is the classic
silent bug here.

## Status

The dashboard, API, ingest, and quality checks are live and verified against the
deployed Worker.

Access is **open by decision**: no credential is required, and the header carries an
amber *open access* chip so that is never the silent state. Two stronger postures
are implemented and dormant — a shared key with an unlock screen, and Cloudflare
Access — each selected by setting secrets, not by editing code. Locking it down is
one command:

```bash
npx wrangler secret put DASHBOARD_KEY --cwd worker
```

Effective on the next request, no deploy. See [Access](docs/RUNBOOK.md#access).

One item is open and it needs an account change rather than code: the monthly cron
cannot register because the Cloudflare account has already spent its 5 free cron
triggers, so the refresh is run by hand once a month. Written up in
[docs/RUNBOOK.md](docs/RUNBOOK.md#open-items).
