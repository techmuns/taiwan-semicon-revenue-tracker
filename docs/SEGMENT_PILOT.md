# Running a segment pilot

How to add a themed slice of the universe — "high-performance compute", "advanced
packaging", "power" — see it on the dashboard, and know what its number means.

The whole workflow is two file edits and one command. There is no migration, no
schema change and no code, which is the point: a segment is a question about the
companies, not a change to the pipeline.

---

## Read this first: what a segment figure actually is

**A segment here is a NAMED SET OF COMPANIES, and its figure is the sum of those
companies' TOTAL revenue.** It is not their revenue *in* that segment.

That is not a limitation of the implementation. It is what the source contains.
Taiwan's monthly disclosure (MOPS 每月營收) is a single consolidated net revenue
figure per company, plus last month, the year-ago month, the two year-to-date
totals and a free-text 備註 note. There is no product line in it, no end market,
no geography and no segment. So:

> "TSMC's HPC revenue in July" is **not in this pipeline** and cannot be derived
> from it by any amount of arithmetic.

It exists in the quarterly IFRS 8 operating-segment note and in investor decks —
a different source, a different cadence, a different lag, and for several of the
37 names a single reported segment, meaning no split at all. Getting it would be
a **data-sourcing project**, not a visualization change. See
[Adding real segment splits](#adding-real-segment-splits) at the end.

What you *can* do today — and what this workflow does — is pick the companies
whose revenue is geared to a theme and track them as a group, across stages,
with the same weighting rules as everything else on the dashboard. That is a
real, useful, honest number. The `basis` line exists so that it is never
mistaken for the other one.

---

## The workflow

### 1. Choose the members

Open `config/universe.yaml` and pick tickers. The useful ones cut *across*
stages — a segment that lives inside one bucket is a bucket, and you already
have those.

The HPC pilot spans seven of the ten stages: silicon (2330, 3443, 3661),
packaging (3711), substrate (3037, 8046), rack (6669, 3231, 2382), networking
(2345), thermal (3017) and power (2308). It deliberately excludes the Legacy and
Analog buckets, which exist in this universe as the control group — a "compute"
segment that included the control group could not be compared against it.

### 2. Add the segment

In `config/segments.yaml`:

```yaml
segments:
  - key: packaging_test          # lowercase, digits, underscores; reaches a URL
    label: Advanced packaging and test
    basis: >-
      Total reported revenue of the companies below, not their packaging-only
      revenue. Monthly filings carry no product split; membership is an
      editorial call recorded in config/segments.yaml.
    members:
      - "3711"   # ASE Technology
      - "2449"   # KYEC
      - "6239"   # Powertech
      - "6147"   # Chipbond
    notes: >-
      Anything a reader needs in order to not misread the figure.
```

`basis` is **required**. There is deliberately no way to define a segment
without also writing down what its number measures, because that sentence is
the difference between a true statement and a false one.

### 3. Validate and generate

```bash
cd ingest && PYTHONPATH=src python -m twrev.cli validate --write
```

`validate` checks every member is in the universe, that no member is listed
twice, that the key is well formed and that a segment has at least two members.
`--write` regenerates `web/src/generated/segments.ts`, which is the only copy
the browser reads.

Without `--write` it *asserts* the generated file is current and fails if it is
not — that is what CI runs, so a config edit whose regeneration was forgotten
cannot reach `main`.

### 4. Look at it

```bash
npm --prefix web run dev     # then open the Insights tab
```

The segment card shows revenue, revenue-weighted YoY, coverage (how many members
filed), the member list, and `basis` as a footnote under the figure.

### 5. Commit both files

`config/segments.yaml` **and** `web/src/generated/segments.ts`. The generated
file is committed on purpose — the browser imports it at build time, and CI
fails if the two disagree.

---

## What the arithmetic does for you

**De-duplication.** A segment may list both a parent and a subsidiary whose
revenue is already inside it — the HPC pilot lists Wistron *and* Wiwynn, because
membership is a claim about which businesses belong to the theme. The aggregate
removes the child before summing, exactly as the universe total does, so listing
both cannot inflate the figure. The pairs live in
`config/relationships.yaml`.

**Weighting.** Segment YoY is revenue-weighted from levels, never an average of
percentages — the same rule as every other aggregate here. Averaging ratios
would weight a NT$300m substrate maker the same as TSMC.

**Filters still apply.** A segment does not override the stage/tier/ticker
filters. If a filter excludes a member, the coverage cell says so rather than
silently shrinking the denominator.

---

## Adding real segment splits

If you want "TSMC's HPC share was 59.4% in Q1", that number has to be read out
of a document and typed in. `config/segments.yaml` has an `observations:` list
for exactly that, and it rejects anything that is not a quotation:

```yaml
observations:
  - ticker: "2330"
    segment: hpc
    period: 2026-Q1                # YYYY-Qn or YYYY-MM, and Qn is the honest one
    share_pct: 59.4                # or revenue_twd_thousands
    source: "TSMC 2026 Q1 consolidated statements, segment note"
    as_of: 2026-05-01
```

`source` and `as_of` are required. `period` must be `YYYY-Qn` or `YYYY-MM`, and
the distinction is enforced because segment splits are quarterly while the
revenue on this dashboard is monthly — a quarterly figure written as a month
would end up silently compared against one.

The list is **empty today**, and a test asserts that it is. That is not a
placeholder: it means no figure on the dashboard is a segment split, and if one
ever becomes one, the test fails and somebody has to look at the source before
it ships.

Before starting that work, be aware of what it involves:

- **Cadence.** Quarterly at best. Interpolating to monthly would be inventing
  data; nothing here will do it for you.
- **Coverage.** Several of the 37 report one operating segment. For those the
  answer is "100%", which is true and useless.
- **Definitions differ.** One company's "HPC" is another's "Computing and
  Consumer". Splits are not comparable across companies without a mapping that
  is itself an editorial judgement.
- **Lag.** The segment note lands weeks after the monthly revenue it would
  qualify, so a segment share is always describing an older period than the
  revenue beside it.

None of that makes it not worth doing. It does make it a sourcing project with
its own schema, its own provenance and its own caveats — which is why the shape
is here, empty, rather than approximated.
