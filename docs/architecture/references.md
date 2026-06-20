# Reference platforms & docs

We are deliberately **not reinventing the wheel** on experimentation. splitch's experiment terms are
adopted from Statsig / Eppo / GrowthBook (per [CONTEXT.md](../../CONTEXT.md)), and the flag side from
Cloudflare Flagship + OpenFeature. This file collects the primary sources so design decisions can be
checked against established practice later.

Verified live 2026-06-20. Every decision in
[assignment-exposure-seam.md](./assignment-exposure-seam.md) is confirmed by these sources in the
vendors' own words — annotated below.

## Flag side (canonical for splitch)

- **Cloudflare Flagship — concepts**: https://developers.cloudflare.com/flagship/concepts/
  (App, Flag, Variation, Targeting Rule, Percentage Rollout, Evaluation Context). The default Provider.
- **OpenFeature — glossary**: https://openfeature.dev/specification/glossary/
  (Targeting Key, Variant, Fractional Evaluation, Provider, Client, Resolution). The SDK is
  OpenFeature-shaped; their terms win over Flagship's where they differ.
- **OpenFeature — full spec**: https://openfeature.dev/specification/

## Experiment side

### Statsig (deterministic assignment, salts)

- **How Evaluation Works**: https://docs.statsig.com/sdks/how-evaluation-works
  Confirms our **pure `assign(Run, Targeting Key)`**: "given the same user and the same state of the
  experiment, Statsig always returns the same result, even when evaluated on different platforms."
  Mechanism: SHA256(user id + per-experiment salt) → bucket out of 10000.
- **Reuse Experiment Salts**: https://www.statsig.com/updates/update/xp-salt
  Per-experiment salt = statistical independence between experiments. Relevant to how a **Run** carries
  its salt.
- **Persistent Assignment**: https://www.statsig.com/updates/update/persistentassignment
  Keeps a user bucketed even when allocation/targeting changes mid-experiment. We solve the same
  problem differently — an **assignment edit** (allocation/targeting/salt) opens a **new Run** rather than
  mutating in place; a measurement edit recomputes (ADR-0003). Worth a conscious compare before we build
  (see "Open question" below).
- **Server SDK (Go) reference**: https://docs.statsig.com/server/golangSDK/
- **Open source — server core (readable bucketing/eval code)**:
  https://github.com/statsig-io/statsig-server-core
  Org: https://github.com/statsig-io  (note: client JS uses djb2 for name obfuscation, not bucketing).

### Eppo (assignment logging, dedup, warehouse-native analysis)

- **Assignment deduplication**: https://docs.geteppo.com/sdks/sdk-features/assignment-deduplication/
  Confirms our **SDK seen-set**: "deduplicates assignment events using an internal cache... one and
  only one canonical event is transmitted," server-side LRU, tunable. Their stated reason matches ours:
  un-deduped logging bloats storage and analysis for no benefit.
- **Assignment logging**: https://docs.geteppo.com/sdks/event-logging/assignment-logging/
  The logging-callback model — SDK computes, you write the event to your warehouse. Warehouse-native,
  like our exposure-event-is-source-of-truth.
- **Diagnostics (SRM + multi-variant)**: https://docs.geteppo.com/experiment-analysis/diagnostics/
  Confirms **first-touch / one-variant-per-Entity**: "subjects seen in multiple variants will be
  removed from analysis."
- **Designing and Deploying Online Field Experiments** (academic, the canonical methods paper Eppo
  cites): https://arxiv.org/pdf/1409.3174

### GrowthBook (open source — the most readable end-to-end reference)

- **Main repo (MIT core)**: https://github.com/growthbook/growthbook
- **Stats engine source** (CUPED, Sequential, Bayesian, SRM checks):
  https://github.com/growthbook/growthbook/tree/main/packages/stats
  This is the single best place to read real experiment statistics code.
- **Understanding Experiment Results**: https://docs.growthbook.io/app/experiment-results
- **Troubleshooting / SRM**: https://docs.growthbook.io/kb/experiments/troubleshooting-experiments
  Confirms our **SRM = chi-square vs declared split**: "standard chi-squared test... compares observed
  units to expected units... p-value for the probability of this split if truly unbiased."
- **Experiment Phases**: https://docs.growthbook.io/app/experiment-configuration
  Their **Phase** ≈ our **Run** (time-boxed analysis window). Their docs warn "Be very careful using
  phases" — heed this when we design Run transitions.
- **Sticky Bucketing**: https://docs.growthbook.io/app/sticky-bucketing
  Same problem as Statsig Persistent Assignment (see open question).
- **Carryover bias** (why re-bucketing across changes is dangerous):
  https://docs.growthbook.io/kb/experiments/carryover-bias
- **Glossary**: https://docs.growthbook.io/kb/glossary

## Resolved: sticky bucketing vs. new Run (Run lifecycle grill, 2026-06-20)

All three platforms ship **Sticky Bucketing / Persistent Assignment** (keep a user in their original
Variant across a config change). splitch's answer: **both, at different layers.**

- A **material** edit opens a **new Run** → fresh, clean dataset (dataset cleanliness).
- At the Run boundary, a holdover Entity (one already *exposed* under a prior Run) keeps its prior
  Variant for **experience** but is **not re-counted** in the new Run (continuity *without*
  contaminating the new dataset).

So the platforms' sticky-bucketing store maps to our **holdover-Variant store**:
`(Experiment, Targeting Key) -> (runId, Variant)`, written at first Exposure — the one piece of durable
per-Entity state on the seam. See [assignment-exposure-seam.md](./assignment-exposure-seam.md) §
"Run lifecycle". Carryover bias is avoided on *both* axes (clean data AND no jarring experience flip).

## Cloudflare storage primitives (Assignment Store substrate grill, 2026-06-20)

Verified for ADR-0009 (KV read + per-key Durable Object write). The substrate split is Cloudflare's own
documented control-plane/data-plane pattern.

- **Workers KV — how it works** (eventually consistent, edge-cached, ~10ms hot reads, up to ~60s
  propagation): https://developers.cloudflare.com/kv/concepts/how-kv-works/
- **KV limits** (1 write/sec/key): https://developers.cloudflare.com/kv/platform/limits/
- **Durable Objects — concepts** (single-threaded, global uniqueness, "millions of objects"):
  https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- **Rules of Durable Objects** (one DO per coordination atom; a single hot DO is the bottleneck
  anti-pattern; shard into more DOs): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- **DO limits** (unlimited object count; ~1,000 req/s soft per object):
  https://developers.cloudflare.com/durable-objects/platform/limits/
- **DO pricing** (idle/hibernating DOs incur no duration cost; only bytes at rest):
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- **DO data location** (lives in one location, network hop from far POPs; locationHint best-effort):
  https://developers.cloudflare.com/durable-objects/reference/data-location/
- **DO storage API + input gates** (atomic get-then-put via serialization; keep non-storage I/O out of the
  critical section): https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- **Use KV from a Durable Object** (the serialize-writes-to-KV pattern):
  https://developers.cloudflare.com/durable-objects/examples/use-kv-from-durable-objects/
- **Control/data-plane reference architecture** (Coordinator DO write-throughs to KV for global reads):
  https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/
- **D1 read replication** (regional single-primary, async eventually-consistent replicas — why D1 is the
  wrong hot-path holdover store): https://developers.cloudflare.com/d1/best-practices/read-replication/

## Exposure pipeline architecture (Exposure pipeline seam grill, 2026-06-20)

Verified for ADR-0010 (raw append-only log + query-time dedup, ELT) and ADR-0011 (`__multiple__`
quarantine). The whole warehouse-native field does raw-log + windowed first-touch dedup at analysis time;
at-least-once + idempotent dedup key is the settled delivery model.

- **Eppo — Assignment SQL** (compiles a pipeline that deduplicates assignments; "only the first record"
  per subject-experiment): https://docs.geteppo.com/data-management/definitions/assignment-sql/
- **GrowthBook — data sources** (return multiple rows per exposure on purpose; dedup at query time):
  https://docs.growthbook.io/app/datasources
- **GrowthBook — experiment-units-query.ts** (`GROUP BY user`, `MIN(timestamp)`, `__multiple__` sentinel
  for conflicting variants): https://github.com/growthbook/growthbook/blob/main/packages/back-end/src/integrations/sql/queries/experiment-units-query.ts
- **GrowthBook — Multiple Exposures health check** (~1% tolerated):
  https://docs.growthbook.io/app/experiment-results
- **Statsig — how we stream 1T events/day** (raw persisted first; best-effort early dedup via Memcache hash
  is a cost optimization, not the authority): https://www.statsig.com/blog/how-statsig-streams-1-trillion-events-a-day
- **Statsig Warehouse Native — pipeline** (first-exposure dedup as a pipeline step; daily deduplicated
  digest): https://docs.statsig.com/statsig-warehouse-native/pipeline-overview/
- **Snowplow — deduplication** (at-least-once delivery, no exactly-once; dedup on event_id, earliest
  collector_tstamp wins = first-touch): https://docs.snowplow.io/docs/modeling-your-data/modeling-your-data-with-dbt/package-mechanics/deduplication/
- **Kafka — delivery semantics** (at-least-once default; exactly-once is the hard problem):
  https://docs.confluent.io/kafka/design/delivery-semantics.html
- **Confluent — idempotent reader pattern** (dedup against a seen-id store):
  https://developer.confluent.io/patterns/event-processing/idempotent-reader/
- **BigQuery — streaming dedup** (best-effort ingest dedup "should not be relied upon"; dedup downstream with
  `ROW_NUMBER() OVER (PARTITION BY id) = 1`): https://docs.cloud.google.com/bigquery/docs/streaming-data-into-bigquery
- **Snowflake — QUALIFY** (`QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1`, canonical first-touch):
  https://docs.snowflake.com/en/sql-reference/constructs/qualify

## Activation gate semantics (Activation gate seam grill, 2026-06-20)

Verified for ADR-0012 (ordering, re-anchor, bias guardrails) and ADR-0013 (first-class event, additive
counterfactual). The field is split on re-anchoring; the post-treatment selection-bias guidance is strongest
in the Kohavi/Microsoft OCE literature, not the vendor docs.

- **Statsig — qualifying events** (filter exposures; "must occur after the exposure"; re-anchor toggle
  replaces exposure ts with qualifying-event ts):
  https://docs.statsig.com/statsig-warehouse-native/configuration/qualifying-events
- **Statsig — filtering exposures** (generic post-assignment-bias caution):
  https://docs.statsig.com/statsig-warehouse-native/features/filtering-exposures
- **Eppo — entry points** (re-anchors automatically: time-limited metrics "based on the timestamp of the
  Entry Point, not the assignment"): https://docs.geteppo.com/guides/advanced-experimentation/entry_points/
- **Eppo — filter assignments by entry point**:
  https://docs.geteppo.com/experiment-analysis/configuration/filter-assignments-by-entry-point/
- **GrowthBook — Activation Metric + the bias warning** ("can cause bias that is not picked up by SRM
  errors… avoid whenever possible"): https://docs.growthbook.io/kb/experiments/troubleshooting-experiments
  and https://docs.growthbook.io/app/experiment-configuration
- **GrowthBook — keeps window at first exposure** (does NOT re-anchor; conversion window lower bound = first
  exposure + delay): https://docs.growthbook.io/app/metrics/legacy
- **Kohavi/Fabijan et al., KDD 2019 — SRM & post-treatment filtering** ("no post-treatment data… for
  filtering"): https://exp-platform.com/Documents/2019_KDDFabijanGupchupFuptaOmhoverVermeerDmitriev.pdf
- **Microsoft — diagnosing SRM** (triggered-analysis SRM with trustworthy untriggered analysis = misconfigured
  trigger): https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/
- **Kohavi & Longbotham — counterfactual triggering** (include control entities that *would have* triggered):
  https://exp-platform.com/Documents/2023-03-11EncyclopeiaMLDSABTestingFinal.pdf

## Metric analysis / stats engine (Metric analysis seam grill, 2026-06-20)

Verified for ADR-0014 (sequential always-valid + frequentist + aCS), ADR-0015 (delta method, aggregate to
randomization unit), ADR-0016 (CUPED + winsorization, conditional). The peeking trap and the clustered-
variance trap are the two silent, high-bias errors this seam exists to prevent.

### Sequential / always-valid inference
- **Johari, Pekelis, Walsh — Always Valid Inference** (the foundational paper; "always valid p-values…
  continuous monitoring"): https://arxiv.org/abs/1512.04922
- **Optimizely — Stats Engine** (peeking inflates A/A false-declaration to 26–57%; mSPRT + FDR):
  https://www.optimizely.com/insights/blog/statistics-for-the-internet-age-the-story-behind-optimizelys-new-stats-engine/
- **Eppo — sequential is the default** (time-uniform confidence sequences; "you can peek… at any time"):
  https://docs.geteppo.com/statistics/confidence-intervals/analysis-methods/
- **GrowthBook — Asymptotic Confidence Sequences** (aCS; look as often as you like):
  https://docs.growthbook.io/statistics/sequential
- **Statsig — sequential testing** (mSPRT, opt-in):
  https://docs.statsig.com/experiments/advanced-setup/sequential-testing

### Bayesian vs frequentist
- **GrowthBook — Bayesian default** (chance-to-win; uninformative prior): https://docs.growthbook.io/statistics/overview
- **Statsig — frequentist by default** (Bayesian opt-in): https://docs.statsig.com/experiments-plus/bayesian/

### Variance correctness — delta method & clustered data
- **Deng, Knoblich, Lu — Applying the Delta Method in Metric Analytics** (KDD 2018; naive method
  under-estimates variance for clustered metrics): https://arxiv.org/abs/1803.06336
- **Eppo — ratio metrics / delta method** (formula with covariance term):
  https://docs.geteppo.com/data-management/metrics/ratio-metric/
- **Eppo — clustered experiments** (treating cluster obs as independent underestimates variance):
  https://docs.geteppo.com/guides/advanced-experimentation/analyzing-clustered-experiments/
- **Statsig — delta method** (numerator/denominator correlated; same users):
  https://docs.statsig.com/experiments/statistical-methods/methodologies/delta-method
- **GrowthBook — statistics details** (delta method for unit ≠ randomization unit; relative-lift CI is a
  delta-method ratio): https://docs.growthbook.io/statistics/details

### CUPED & winsorization
- **Deng, Xu, Kohavi, Walker — CUPED** (WSDM 2013; ~50% variance reduction):
  https://www.exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf
- **Statsig — variance reduction (CUPED auto-on) & winsorization (99.9%)**:
  https://docs.statsig.com/experiments/statistical-methods/variance-reduction ,
  https://docs.statsig.com/stats-engine/methodologies/winsorization/
- **Eppo — CUPED++ (conditional; no pre-period for new users)**: https://docs.geteppo.com/statistics/cuped/

### Multiple comparisons & guardrails
- **Benjamini & Hochberg (1995) FDR** — the standard; Statsig BH:
  https://docs.statsig.com/experiments/statistical-methods/methodologies/benjamini-hochberg-procedure
- **GrowthBook — multiple corrections** (Holm-Bonferroni or BH): https://docs.growthbook.io/statistics/multiple-corrections
- **Eppo — preferential Bonferroni / FWER** (the considered alternative): https://docs.geteppo.com/statistics/multiple-testing/
- **Eppo — guardrails (CI lower-bound breach)**: https://docs.geteppo.com/data-management/organizing-metrics/guardrails/
- **Spotify — guardrails as non-inferiority test**: https://confidence.spotify.com/blog/better-decisions-with-guardrails
