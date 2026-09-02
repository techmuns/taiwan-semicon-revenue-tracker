# Runbook

Operating notes for the Taiwan semiconductor supply-chain revenue tracker. Read
[README.md](../README.md) first for what the thing is; this file is what to do
when something needs doing.

Live: <https://taiwan-semicon-revenue.tech-441.workers.dev>

---

## There is no database. SQLite builds the data; the dashboard reads files

**Cloudflare D1 was removed on 2026-09-01.** The trigger was an outage: D1's
free-tier daily row-read limit was exceeded, every data endpoint began returning

```
D1_ERROR: Your account has exceeded D1's free tier daily row read limit.
```

and `/api/health` went on answering `ok:true` while the page showed nothing.
The runbook had estimated ~2,600 page loads before that cap. Whatever the true
number, it was reachable, and nothing external could see the dashboard was down.

**Nothing was ported.** D1 *is* Cloudflare's hosted SQLite. The migrations, the
analytics views and the bucket-heatmap statement all run unchanged against a
plain SQLite file - which `ingest/tests/test_heatmap_sql.py` had been doing in
CI since the day it was written. Leaving D1 was rehosting, not rewriting.

```
GitHub Actions (11th, 14th, 18th)
  └─ rebuild data/pipeline.sqlite from data/raw/*.jsonl   <- the durable state
  └─ scrape MOPS + the three feeds, upsert the month
  └─ assert_view_contract + golden_checks over the WHOLE store
  └─ run the heatmap SQL at publish time -> web/public/data/*.json
  └─ commit data/raw + web/public/data       <- a refresh is a reviewable diff
  └─ dispatch deploy.yml                     <- which holds the CF token

Browser -> /data/*.json, filtered client-side. No database in the request path.
```

Three things follow, and each is deliberate:

**The durable state is JSONL, not the .sqlite file.** A SQLite file is binary,
churns wholly on every write, and is unreadable in a diff. `data/raw/*.jsonl` is
the store of record and the database is rebuilt from it each run. It carries
`raw_revenue_history` (the restatements) and the original `first_seen_utc`
values - neither can be re-scraped, because MOPS serves today's version of a
filing, not the version it served in March.

**The refresh holds no Cloudflare credential.** Static assets only ship inside a
`wrangler deploy`, and giving an unattended scheduled scrape that token would
hand it the power to replace the whole Worker, access gate included - strictly
more than the D1-edit token it replaces. So refresh commits, then dispatches
deploy.yml, which holds the token and verifies the served bundle itself.

**Run `refresh` before `deploy`, always.** deploy.yml refuses to ship if
`worker/public/data/*.json` is missing, because a shell with no data shows an
error on every card.

```bash
gh workflow run refresh -f month=2026-08          # manual
gh workflow run refresh -f dry_run=true           # scrape + validate, publish nothing

# locally, end to end:
PYTHONPATH=ingest/src python -m twrev.cli refresh \
  --db data/pipeline.sqlite --state data/raw --month 2026-07
PYTHONPATH=ingest/src python -m twrev.cli export \
  --db data/pipeline.sqlite --out web/public/data
```

### What moved, and what did not

**The schedule moved first; the database followed a month later.** D1 is gone:
its free-tier daily row read limit was exceeded on 2026-09-01. What did *not*
change is the SQL. D1 is Cloudflare's hosted SQLite, so the migrations, the
`analytics_monthly` view and the bucket-heatmap statement all run unaltered
against `data/pipeline.sqlite` — the heatmap is still computed by that same
statement, just at publish time instead of per request.

### Why the Cloudflare cron had to go

It never ran. The account is at the Workers Free ceiling of **5 cron triggers
per account** — per account, not per Worker — so every deploy ended in:

```
This account has reached the Workers Free limit of 5 cron triggers per account.
[code: 10072]
```

The scheduled handler was therefore never registered and not one refresh ever
fired. `wrangler.toml` now declares no `[triggers]` block at all, so deploys are
clean again. The `scheduled` handler is gone from `worker/src/index.ts` too —
it could not work now even if a slot were freed, because the refresh builds a
SQLite file and commits JSON, neither of which a Worker can do. **Do not re-add
the trigger.**

### D1's write and storage limits were never close; the read limit is what bit

Worth writing down so nobody re-litigates it. Measured against the real store:

| | Usage | Free allowance | Headroom |
|---|---|---|---|
| Writes | ~100 rows/run, ~300/month | 100,000/day | 0.3% of **one day's** budget, per month |
| Reads | ~1,900 rows/page load | 5,000,000/day | ~2,600 page loads/day |
| Storage | 200 KB | 5 GB | 0.004% |

Two different quotas ran out, four weeks apart. The first was a quota on
*scheduled jobs* — the 5-cron ceiling above, nothing to do with the database.
The second was the **reads** row of this table: ~2,600 page loads a day is a
real number, and on 2026-09-01 a backfill loop reached it and took every data
endpoint down. Writes and storage never mattered; the read limit did.

### Actions is also the better host for the scrape

The Worker had a subrequest budget, which is why its repair path fetched MOPS
for **tier-1 names only**. A runner has none, so the Actions run reads all 36
trackable names from MOPS *and* the feeds — and that is what finally gives the
cross-source check something to compare.

Under the Worker it was structurally impossible: the feeds partition the
universe (`t187ap05_L` carries 31 of the 37, `mopsfin_t187ap05_O` the other 5,
and a company is 上市 or 上櫃 but never both) while `t187ap05_P`, the feed the
brief names, carries **none** of them. MOPS only ran where the feeds had already
missed, so no company-month was ever held by two sources. A verified run now
reports **36 company-months carried by two sources, 0 disagreements**. A
disagreement raises `SOURCE_DISAGREEMENT`, which reaches the reader through
`AlertStrip` on every tab.

### The gates, in order

1. **Scrape** — MOPS for all 36 trackable names, plus one explicit retry pass
   over cells that exhausted their attempts.
2. **Cross-source** — every cell compared against the OpenAPI feeds.
3. **View** — the rows are written into `data/pipeline.sqlite`, built from the
   real migrations, so `analytics_monthly` is *executed* and its 12-column
   contract asserted.
4. **Golden checks** — units, ticker types, column completeness, `month_idx`
   agreement, and the `2330/2026-03 = 415,191,699` reference cell.
5. **Publish** — `twrev.cli export` runs the same SQL, including the
   bucket-heatmap statement, and writes `web/public/data/*.json`.
6. **Commit, then deploy** — refresh commits the JSONL state and the published
   files, then dispatches `deploy.yml`, which holds the Cloudflare token and
   verifies the served bundle is the one it just built.

A failure at 1–5 commits nothing: the JSONL state is written back only after the
gates pass, so a bad run cannot overwrite good state.

### What fails the run, and what does not

Three passes a month exist because filers trickle in and MOPS is intermittent,
so a straggler is not a failure:

- Up to `MAX_SOFT_FAILURES` (3) missing cells → warn, exit 0, next pass collects them.
- More than that, or any non-`FETCH_FAILED` error finding → exit 1.
- Golden checks failing → exit 1, nothing applied.

The reference-cell assertion is waived when a single-month refresh legitimately
cannot contain it; **the units, type and column checks always run**. Waiving the
whole set over an out-of-scope month is how a units change would slip through.

### The seed cannot damage the months either side of it

`raw_revenue` is an upsert gated on `row_hash` — no `DELETE` at all — and the
`fetch_log` and `quality_findings` deletes are scoped to the month being
refreshed. `universe`, `source_feed` and `source_config` are rewritten wholesale
from the YAML on purpose, so config stays authoritative. Re-applying the same
seed converges rather than duplicating.

### MOPS is User-Agent sniffed — do not "tidy" the headers

MOPS returns *"FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED"* to a default
`curl` agent **and to a Linux Chrome agent**. It serves data only to the Windows
Chrome UA in `http.py:DEFAULT_HEADERS`. UA sniffing, not an IP block — cloud
runners are fine. Those headers are load-bearing.

It also serves a block page on first contact and the real page on retry, so
expect `rejected` in the fetcher stats to run at roughly one per cell.

### The secret — refresh has none

`refresh.yml` holds **no Cloudflare credential at all**, deliberately. Static
assets ship only inside a `wrangler deploy`, so the token that publishes can
replace the entire Worker, access gate included — strictly more power than the
D1-edit token it replaces, and not something an unattended scheduled scrape
should hold. So refresh commits and dispatches; `deploy.yml` is the only
workflow with `CLOUDFLARE_API_TOKEN`, a repository secret from the account that
owns the Worker (`a441977d…`).

### GitHub disables schedules after 60 days of repo inactivity

A real hazard for a monthly job on a quiet repo: the workflow silently stops
firing. `workflow_dispatch` is the escape hatch, and any push resets the clock.

### The two restatements already happened

`3661` and `6415` file their 備註 note in the layout `RE_NOTE_KY` handles, added
in `a976750` — *after* the rows then in D1 were seeded. Those rows carried
`note = NULL`, so the first Actions refresh changed `row_hash` on both and
tripped the restatement trigger. That is the parser fix landing, **not** a filer
revision, and the two rows it produced are the whole of
`data/raw/raw_revenue_history.jsonl`. It happened once and will not repeat.

Verified at the time: 34 of 36 company-months byte-identical to D1 including
`row_hash`; the two that differed, differed only in `note` and its hash.

### The static export is the product now

`twrev.cli export` writes the whole dashboard as files under `web/public/data`,
and `ingest/tools/check_export_parity.py` proved it matched the live API exactly
before the cutover (analytics, meta, seven companies, and the CSV byte for byte
— zero divergences). The dashboard reads those files and nothing else.

The one thing that could not simply become a file was the bucket-heatmap
aggregation: it runs over whatever filters are live, and ticker selection is an
arbitrary subset of 37 names. It is not aggregated in the browser either. The
UI exposes no ticker control for that view, so the reachable cells are
enumerable — `export` runs the original statement, unchanged and character for
character, out of `ingest/src/twrev/sql/heatmap_bucket.sql`, and publishes every
one of them.

---

## Access

The posture is **derived from which secrets are set**, never hardcoded, and the
running service states it — `/api/health` reports `access.mode`, and a 401
carries an `X-Access-Mode` header. Most specific wins (`worker/src/access.ts`):

**Read the posture from `/api/health`, never from `/data/meta.json`.** That file
carries an `access` block too, but it is written by the exporter on a GitHub
runner that cannot see the Worker's secrets, so it is frozen at `open` and would
report `open` for a fully gated deployment. Health is evaluated live, and is the
one route that answers without a credential.

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
curl -s https://taiwan-semicon-revenue.tech-441.workers.dev/api/health | grep -o '"mode": *"[a-z-]*"'
```

The dashboard states it too: the header shows an amber **open access** chip whenever
`/api/health` reports `public: true`, which exists so that "we left it public and
forgot" cannot be the silent state. The chip itself was removed at the owner's
request; the Lock button in the header is what remains, and it appears exactly
when health reports `secret`.

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

**The lag.** Turning a key on does not lock an open tab out immediately: cached
`/data/*` responses keep serving 200s until they expire, and the first thing to
401 is a file that tab had never fetched. A 401 itself is `no-store`, so nothing
caches the rejection. This is exactly how the 2026-08-21 flip surfaced — as a
lone `/api/company/5347 · HTTP 401` on a dashboard whose other tabs still looked
fine. The same shape applies to the files that replaced those routes.

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
   automatically: `meta.alerts.severe_findings` carries it and `AlertStrip`
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
| `seed --from --to --out out/seed.sql` | Emit seed SQL from the cache, applied with `sqlite3 data/pipeline.sqlite < …`. The window is required, and scopes the idempotent DELETEs. |
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
lifecycle. It is mirrored into the store's `universe` table at seed time and
read from there by every export, so the SQL and the dashboard read the same
values.

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

### Check an edit before it ships

```bash
cd ingest && PYTHONPATH=src python -m twrev.cli validate
```

Offline, under a second, no network and no database. It checks all four config
files — universe, sources, relationships, segments — and asserts that the
TypeScript generated from the last two is current. Add `--write` to regenerate.

This is the gate between a typo and a wrong stage on the published site, because
a `bucket:` edit is live after the next refresh with no code change and no
review step of its own. CI runs the same command without `--write`.

---

## Relationships and de-duplication

`config/relationships.yaml` records which tracked companies contain which other
tracked companies. It exists because the dashboard SUMS 37 names, and that is
only correct if no name's reported revenue already includes another's.

One does. **Wistron (3231) consolidates Wiwynn (6669)**, and both file monthly.
Measured on 2026-07 against the live store:

| | counting both | de-duplicated |
|---|---|---|
| Universe revenue | 2,705,290,452 | 2,587,604,922 (**4.55% lower**) |
| Rack / ODM revenue | 1,873,094,715 | 1,755,409,185 (**6.28% lower**) |
| Rack / ODM weighted YoY | 65.68% | **67.81%** |
| Rack / ODM acceleration | +5.39 ppt | +4.98 ppt |

An entry removes the child from **sums only** — the universe total, the Worker's
per-stage aggregate, the Buckets stage index and the segment aggregate. The
child's own row, series, acceleration, Data-tab line and CSV row are untouched,
because a subsidiary's own filed revenue is perfectly real.

### The test is accounting treatment, not ownership percentage

This is the trap, and the intuitive rule is wrong. Two pairs in this universe
have nearly identical stakes and opposite answers:

- TSMC (2330) holds **~35%** of Global Unichip (3443) → **equity method**. GUC's
  revenue is *not* inside TSMC's. Not a double count.
- Wistron (3231) holds **~35–40%** of Wiwynn (6669) → **consolidated**. Control
  is retained (the disposals were filed as 「未導致緯創對緯穎喪失控制力」), so
  Wiwynn's revenue *is* inside Wistron's. A double count.

Only the parent's consolidated statements settle it. The cleared pair is
recorded in the same file precisely so nobody "fixes" a non-problem later by
pattern-matching on the stake.

### Adding a pair

**Adding a pair deletes revenue from a headline total.** Getting it wrong in the
eager direction is worse than the bug it fixes, so the loader enforces six
invariants and each has a test that proves it raises: no self-consolidation, at
most one parent per child, no cycles, no pair in both lists, `treatment:
consolidated` required in `consolidation`, and both sides present in the
universe. Then:

```bash
cd ingest && PYTHONPATH=src python -m twrev.cli validate --write
```

Commit the YAML **and** the two generated files
(`web/src/generated/relationships.ts`, `worker/src/generated/relationships.ts`).

### Why this is generated TypeScript and not a database column

A `consolidated_into` column on `universe` would be the obvious design and is
the wrong one here. The seed applies as a **single transaction**, so a seed
referencing a column the schema does not have yet aborts the whole month's
revenue update — turning a cosmetic ordering problem into a missed filing month.
That was sharper when migrations were applied by hand to a remote D1 and could
lag the code; the store is now rebuilt from `worker/migrations/*.sql` on every
run, so the two cannot drift. The build-time constant stays regardless: the
value is read by the browser bundle, which has no database to ask.

### Supply links

The same file's `supplies` list carries 18 links between tracked companies,
rendered on the Insights tab. **No number on the dashboard is computed from an
edge** - not a total, not a growth rate, not a ranking. A test asserts that the
exclusion set is a function of `consolidation` alone, so naming a company in an
edge can never remove it from a sum.

`confidence` is load-bearing and is rendered on every row, because the rows are
not the same kind of claim:

- **high - "named in a source".** A document names the buyer: Auras' customer
  list names Quanta, Wistron and Inventec; ASE's 20-F names TSMC; Gudeng's,
  Kinik's and Topco's published customer lists name TSMC.
- **medium - "inferred from stage".** The supplier's market position is
  documented and the buyer is one of the assemblers that stage sells into, but
  no disclosure pairs the two by name. All eleven of these are power or thermal
  selling into rack assembly, where the direction is not in doubt and only the
  specific pairing is structural.

`competes` is **empty on purpose**, and that is not an omission. Every
competitor pair the research returned was two companies in the *same bucket* -
Unimicron/Kinsus/Nan Ya PCB, AVC/Auras/Sunonwealth/Jentech, UMC/VIS/PSMC. That
is already in `config/universe.yaml` and already on every screen; a second copy
of it could only drift from the first.

### The map, and why it is two columns

The Insights tab draws the links as a node-link map beside the table, because
the table cannot answer questions about *shape*: is this stage a source or a
sink, does anything feed a supplier, how much of the universe is connected at
all. Hovering a company isolates it and its counterparties.

**Two columns, not a ten-stage cascade**, because one hop is all the data has:
eight suppliers sell into six buyers and nothing sells into a supplier. The
column ordering is a two-layer barycentre sweep rather than chain order —
measured, ordering both columns by chain position gives **72 edge crossings**
and the sweep gives **14**, because the left column (Thermal, Power, Packaging,
Equipment) and the right (Rack, AI Silicon) run in opposite chain directions, so
chain order guarantees a full crossing. Every stage is still one contiguous
labelled group; the vertical axis was never a scale.

**Node size is deliberately not revenue.** TSMC is ~400x Gudeng, so on an honest
scale the small names vanish — and a thick link between two large nodes reads as
a large *flow*, which no filing states. Fill is the same diverging acceleration
scale the heatmaps use, each node prints its own value, and a company that did
not file gets the same 45-degree hatch a missing heatmap cell gets.

**A graph database was considered and rejected.** The graph is 37 nodes and 24
edges, one hop deep, with exactly three 2-hop paths of which two are already
direct edges. Traversal is what a graph database is for and there is nothing
here to traverse. Neo4j would also add a second store of company identity free
to drift from `universe.yaml`, a second credential in CI, and — on the free tier
— an instance that pauses when idle, against a pipeline that writes three days a
month. Revisit if the universe grows multi-tier supply chains or deep ownership
trees; at one hop, an array filter beats a network round trip.

**On the "risk flag" these links were meant to power:** they are ranked by the
*gap* between the two ends' acceleration, not marked with a badge. On the month
this shipped, 12 of 18 pairs moved in opposite directions - a flag firing on two
thirds of the rows is not a flag, it is the weather. The size of the gap is a
continuous quantity a reader can judge, and the footnote states the base rate so
nobody reads twelve alerts where there are none.

---

## Segments

`config/segments.yaml` defines named slices of the universe — the shipped one is
a 12-company high-performance-compute pilot spanning seven stages. Adding
another is two file edits and `validate --write`; the walkthrough is
[SEGMENT_PILOT.md](SEGMENT_PILOT.md).

**Know what a segment figure is before quoting one.** It is the sum of its
members' **total** revenue, not their revenue in that segment. The monthly
filing is one consolidated number per company — no product line, no end market,
no geography — so "TSMC's HPC revenue in July" is not in this pipeline and
cannot be derived from it. That number lives in the quarterly IFRS 8 segment
note: a different source, a different cadence, and a **data-sourcing project**
rather than a visualization change.

`Segment.basis` is a required field for exactly that reason, and every surface
that renders a segment renders it. The `observations:` list is where a
hand-transcribed split would go; it requires a `source` and an `as_of`, it is
empty, and a test asserts it stays empty so that a figure cannot become a
segment split without someone deliberately updating that test.

---

## Known properties that are not bugs

Two things an audit will flag every time. Both are accurate descriptions of the
code; neither is reachable, and the reasons are worth keeping written down.

**`authoritative_revenue` ranks purely on `source_id`.** So a higher-precedence
row carrying a NULL `revenue_month` would mask a lower-precedence row that has
the figure - reproducible in SQL by inserting both by hand. The ingest cannot
produce that pair: `backfill.run` appends a row only `if outcome.row is not
None`, and every failure path - fetch failure, parse failure, not-an-issuer -
yields `None` and writes no row at all. So a NULL-revenue `mops_company` row
does not exist; the live store has 288 raw rows and zero with a NULL revenue.
If the ingest is ever changed to persist a placeholder row, add
`CASE WHEN revenue_month IS NULL THEN 1 ELSE 0 END` ahead of the source rank -
and note that is a view migration: edit `worker/migrations/*.sql`, which the
next run applies to a freshly built store.

**The source-precedence CASE is a hardcoded list.** It is, and migration 0002's
own comment says it must never drift from `config/sources.yaml`. It is now
CHECKED rather than fixed in SQL: `twrev validate` parses the CASE out of
`0001_init.sql` and asserts it names exactly the YAML's sources in the same
order, so a config edit that needs a matching SQL edit fails CI before either
reaches production. Making the view read `source_feed` instead would need a
migration, and the check is cheaper than the migration it would replace.

---

## CI

`.github/workflows/ci.yml`, on every push and pull request. Python tests, then
`twrev validate` (config + generated-file drift), then the web build (theme
parity → `tsc` → vite) and the Worker typecheck.

Everything in it is **offline**: `conftest.py` forces `TWREV_OFFLINE=1`, so no
check can pass because MOPS happened to be up or fail because it happened to be
down. Before this existed the monthly refresh was the only workflow in the repo,
which meant a broken parser or view would surface on the 11th, inside the one
job whose purpose is writing that month's data to production.

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

Then confirm the deploy actually landed. The data ships *inside* the deploy, so
this checks the published files, not just the code:

```bash
B=https://taiwan-semicon-revenue.tech-441.workers.dev
curl -s "$B/api/health"                                                    # ok:true, latest_month, universe_n
curl -s -o /dev/null -w 'analytics -> %{http_code} (want 200)\n' "$B/data/analytics.json"
curl -s -o /dev/null -w 'heatmap   -> %{http_code} (want 200)\n' "$B/data/heatmap.json"
curl -s -o /dev/null -w 'retired   -> %{http_code} (want 410)\n' "$B/api/analytics"
```

`/api/health` 503s when `meta.json` is missing or empty, so a deploy that shipped
code without data fails this check rather than showing empty cards.

`npx wrangler rollback` reverts to the previous version if anything looks wrong.

### Deploys are clean now

They used to end in `This account has reached the Workers Free limit of 5 cron
triggers per account`. `wrangler.toml` declares no `[triggers]` block any more —
the refresh runs on GitHub Actions — so that error is gone. If it comes back,
someone re-added `crons`, and it will fail for the same reason it always did.

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
- **Sums across companies exclude consolidated subsidiaries.** Wiwynn's revenue
  is inside Wistron's, so the universe total, the stage aggregates, the stage
  index and the segment aggregate all count it once. Per-company views count it
  normally — its own filed revenue is its own. See *Relationships and
  de-duplication* above.
- **The Insights tab's "standout stage" is a ranking, not a significance test.**
  It scores each stage against the median and MAD of the other stages *in the
  same month*, in MAD units. It is deliberately not a z-score against a stage's
  own history: at n=7 months the largest |z| a sample can produce is 2.268, so a
  3-sigma alert could never fire and a 2-sigma one fires on the series maximum or
  minimum every time — measured on the live store, 100% of |z| > 2 flags were the
  series max or min, and lag-1 autocorrelation was −0.310. Ten stages is also far
  too few to quote a false-positive rate for, and they are not independent draws.
  The panel says "most unlike the others" and never says "significant".
- **Acceleration is the difference of the two DISPLAYED YoY columns**, not a
  recomputation from the raw levels, and that is deliberate. A reader
  subtracting the two YoY columns in the CSV gets exactly the
  `yoy_acceleration_ppt` column. The two conventions differ by at most 0.01pp -
  on the live store, 59 of 252 cells differ in the last decimal - which is
  immaterial next to a table that does not add up. An audit pass read this as a
  defect; it is not, and a test pins it.
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
  `meta.alerts.consolidated` and footnotes the two places a level is
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
| "Registered datasources only" | The datasource is this project's own published JSON, built by its own pipeline. |

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

There are two Worker routes left. Everything else is a file.

| Route | Notes |
|---|---|
| `/api/health` | Always open. Reads the published `/data/meta.json` through the assets binding and 503s if it is missing or empty — a publish check, not a liveness ping. It touches no database. |
| `/auth`, `/logout` | The access gate. |
| every former `/api/*` data route | **410 Gone**, naming its replacement file in the body. 410 rather than 404: a 404 says "wrong URL" and invites a retry. |

The data itself, published by `twrev.cli export` and served through the gate
(`run_worker_first = ["/data/*"]` in `wrangler.toml`, so the credential check
still applies):

| File | Was |
|---|---|
| `/data/meta.json` | `/api/meta` |
| `/data/analytics.json` | `/api/analytics` — all rows, unfiltered; filtering is `web/src/dataset.ts` |
| `/data/heatmap.json` | `/api/heatmap` — every reachable cell, precomputed |
| `/data/company/<ticker>.json` | `/api/company/:ticker` |
| `/data/quality.json` | `/api/quality` |
| `/data/export.csv` | `/api/export.csv` — UTF-8 BOM so Excel opens it correctly |

Responses are cached. The data changes monthly, so this is nearly free — but it
does mean **a redeploy is not visible in a browser immediately**. When verifying
a fix, bypass it:

```bash
curl -s "https://taiwan-semicon-revenue.tech-441.workers.dev/data/heatmap.json" | head -c 300
```

`fetch(url, {cache: 'reload'})` from the page console does the same and also
refreshes the browser's entry, so a subsequent reload of the app shows the new
values. The URLs are now fixed file paths rather than parameterised queries, so
the old trap — a hand-built URL whose parameters were in a different order being
a different cache entry, looking fresh while the app showed stale numbers — no
longer applies.

---

## Verification gates

The golden-number checks are the important ones. Both reproduce in Python, in
`data/pipeline.sqlite`, and in the dashboard.

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
curl -s .../data/export.csv | head -1          # exact 12-column order
curl -s .../data/quality.json                  # 288 of 288 expected cells; 8 known-absent (6286)
```

Coverage as of the 2025-12 → 2026-07 backfill: **288 of 288** expected
company-months present, 100.0%. The eight absent cells are 6286, by design.
