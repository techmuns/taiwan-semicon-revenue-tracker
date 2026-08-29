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
config/universe.yaml      the editable ticker universe - stage, tier, lifecycle
config/sources.yaml       endpoint URLs + ongoing-source precedence
config/relationships.yaml who contains whom - drives de-duplication of totals
config/segments.yaml      named slices of the universe, e.g. the HPC pilot
ingest/                   Python 3.12 - backfill, monthly refresh, config checks
worker/                   Cloudflare Worker - JSON API over D1, static assets
web/                      React + Vite + TS dashboard, built into worker/public
docs/RUNBOOK.md           operations, open items, how to read the numbers
docs/SEGMENT_PILOT.md     how to add a themed slice, and what its number means
```

The four `config/*.yaml` files are the editing surface. A stage change, a
delisting, a new segment or a newly-verified parent/subsidiary pair is a YAML
edit plus one command — never a code change and never a migration:

```bash
cd ingest && PYTHONPATH=src python -m twrev.cli validate --write
```

`validate` checks every file offline in under a second and regenerates the
TypeScript constants the browser and the Worker import. Without `--write` it
asserts those generated files are current, which is what CI runs.

The split is on **request volume**, which the source choice dictates. The
backfill is 296 serially-throttled HTML requests — far beyond a Worker's CPU and
subrequest limits — so it runs off-platform in Python and emits idempotent SQL.
The ongoing refresh is a single JSON GET, so it is Worker-native. Both halves are
UTF-8 end to end.

## Data model

`raw_revenue` holds the scrape unmodified, keyed `(source_id, month, ticker)`, so
every derived number has an as-filed row behind it and cross-source disagreement
would be detectable rather than averaged away. In practice nothing currently
writes two sources for one cell: the two OpenAPI feeds that carry the universe
partition it (上市 vs 上櫃, 31 names and 5), and the MOPS repair pass only runs
for names the feeds missed. The key supports the check; no data exercises it. Restatements append to
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

There is no Quality tab. Data-integrity signals do not sit behind a click,
because the reader who most needs them — the one about to quote a number — is
the one least likely to go looking. A missing month or an `error`/`warn` finding
draws a strip above the content on **whichever tab is open**, and nothing renders
when nothing is wrong.

| Tab | What it answers |
|---|---|
| Overview | Which stage of the chain is inflecting, and a summary of the latest month |
| Insights | Which stage is most unlike the others this month, who inside it is large enough to be driving it, and the segment pilot |
| Acceleration | Company × month, strongest latest month first |
| Company | One name: series, and the as-filed rows every number came from |
| Buckets | Rebased revenue index per stage, ten facets on one shared scale |
| Data | The twelve columns, sortable, identical to the CSV export |

Every chart can be **redrawn as a table of numbers** — one toggle per screen,
graph by default, `viz=table` in the URL when it isn't. It exists because a
figure that is going to be quoted should be read rather than estimated off an
axis, and because it is the accessibility relief for the one series hue that
falls under the 3:1 contrast floor. Nulls render as an em dash and never as
zero, in either view.

## Totals are de-duplicated

The dashboard sums 37 companies. That is only correct if no company's reported
revenue already contains another's — and one does: **Wistron consolidates
Wiwynn**, and both file. Counting both overstated the universe total by 4.55%
and the Rack / ODM stage by 6.70%, and pulled that stage's revenue-weighted YoY
from a true 67.81% to 65.68%.

Every **sum across companies** now excludes the child: the universe total, the
per-stage aggregate in the Worker's SQL, the stage index on the Buckets tab and
the segment aggregate. Nothing else changes — Wiwynn's own row, series,
acceleration and place in the Data tab and the CSV are all exactly as filed,
because a subsidiary's own revenue is perfectly real. It is only *adding* it to
its parent's that double counts.

`config/relationships.yaml` also carries 18 **supply links** between tracked
companies, shown on the Insights tab and used for nothing else — no total, no
growth rate and no ranking is computed from an edge, and a test asserts that.
Each row shows whether a source *names* the buyer or the pairing is *inferred
from stage structure*, because those are not the same claim. Competitors are
deliberately not listed: every competitor pair is two companies in the same
`bucket`, which `universe.yaml` already records and every screen already shows.

Those links are also drawn as a **map** on the Insights tab — two columns,
because every recorded link is one hop, ordered by a barycentre sweep that cuts
edge crossings from 72 to 14. Hovering a company isolates it and its
counterparties, which is the one question the table beside it cannot answer.

The test is **accounting treatment, not ownership percentage**, and that is the
trap. Two pairs in this universe have nearly identical stakes and opposite
answers: TSMC holds ~35% of Global Unichip and equity-methods it (not a double
count); Wistron holds ~35–40% of Wiwynn and consolidates it (a double count).
Both are recorded in `config/relationships.yaml`, the second so nobody
"fixes" a non-problem by pattern-matching on the stake.

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

The monthly refresh runs on **GitHub Actions**, not on a Cloudflare cron. The
account is at the Workers Free ceiling of 5 cron triggers *per account*, so the
Worker's schedule never registered and not one refresh ever fired; Actions has
no such cap. **D1 is unchanged** — it is still the store of record, the Worker
still answers every endpoint out of it, and the run applies its seed to that
same database. D1's own limits were never close: ~300 rows written a month
against 100,000 a day, and 200 KB of a 5 GB allowance.

Actions is also the better host for the scrape. The Worker had a subrequest
budget, which is why it only repaired tier-1 names; a runner has none, so the
run reads all 36 trackable names from MOPS *and* the OpenAPI feeds — which is
what finally gives the cross-source check two independent readings of one filing
to compare. Written up in
[docs/RUNBOOK.md](docs/RUNBOOK.md#the-monthly-refresh-runs-on-github-actions-d1-is-unchanged).
