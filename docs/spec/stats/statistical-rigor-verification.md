# Statistical rigor verification

This spec turns ADR-0030 into enforceable tests. It defines what must be tested before splitch can
call an Experiment Run result decision-valid.

## Gate levels

| Gate               | Runs when          | Purpose                                                             |
| ------------------ | ------------------ | ------------------------------------------------------------------- |
| `stats:unit`       | local and CI       | Fast deterministic tests for math and contracts                     |
| `stats:golden`     | CI                 | Fixed fixtures with exact expected outputs                          |
| `stats:property`   | CI                 | Metamorphic tests over generated inputs                             |
| `stats:simulation` | nightly or full CI | Seeded Monte Carlo checks for false positives and power pathologies |
| `spec:lint`        | local and CI       | Blocks terminology/formula drift in docs/specs                      |

These names are package scripts and CI jobs. Math slices add their own fixtures to the matching gate.

## Contract tests

### Ingest and dedup

- Exposure and Activation intake rejects missing `event_id`, `source_id`, `dedup_key`, or
  `server_received_at`; Activation intake additionally rejects a missing or null `activation_ts`.
  The producer must omit `ingest_ts`, and the stored Tinybird row must contain datasource-assigned
  `ingest_ts`.
- A fresh Evaluation returns its Variant only after the retry-stable Exposure and payload are sealed
  in the durable `raw_events` outbox. Seal failure returns an error and begins no Assignment Store
  write; Queue publication failure after the seal is recovered from the outbox without SDK re-fire.
- Retrying the same raw row with the same `event_id` yields the same `dedup_key`.
- Exposure and Activation rows with the same identity and `event_id` do not collide because `type` is
  included in the key.
- Two physical `metric_events` rows with the same `dedup_key`, inserted in separate blocks and held
  in separate aggregate-state parts, produce one row from `serve_deduped_metric_events` before
  Binomial, Count, Revenue, or Ratio aggregation and therefore cannot inflate a result.
- Two physical `web_events` rows with the same `dedup_key`, inserted in separate blocks and held in
  separate aggregate-state parts, produce one row from `serve_deduped_web_events` before counts,
  journeys, or percentiles.
- Duplicate Activation rows for one Entity/Run/timestamp, inserted across separate blocks and state
  parts, produce one candidate from `serve_deduped_activations`. A fixture with a pre-Exposure
  candidate and two later candidates proves the join selects the earliest post-Exposure timestamp; a
  late physical delivery inside the Run event-time bounds remains visible. The default serving policy
  excludes `counterfactual = 1`; the explicit inclusion parameter admits both kinds without collapsing
  their candidate identity before the Exposure-relative predicate.
- Activation gate and activation-rate query contracts fail if they read physical `raw_events`
  Activation rows instead of `serve_deduped_activations`.
- Metric or Web Analytics queries that read the physical event logs directly fail contract tests.
- Each Metric/Web aggregate-state tuple, materialized grouping key, target sorting key, and serving
  grouping key are generated from one family definition; type, column, or ordering drift fails
  contract tests.
- The Activation aggregate-state type, materialized grouping key, target sorting key, and serving
  candidate identity are generated from one Activation definition; drift in
  `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, counterfactual,
activation_ts)` or its exact types fails contract tests.
- A Tinybird `422` transitions its durable write-ahead attempt to `indeterminate` and never enters
  ordinary queue retry. Reconciliation fixtures cover raw-plus-state, raw-only, absent, and
  mixed/unresolved outcomes.
- No Tinybird request is sent until its write-ahead delivery attempt is durable. A failed outcome
  transition leaves the attempt guarded and enters reconciliation without blind redelivery.
- A permanent response enters nonterminal `poison_pending`. A failed DLQ copy leaves the primary
  message unacknowledged and redelivery resumes that copy without a Tinybird request; only terminal
  `poison_transferred` permits acknowledgement.
- Tinybird `429`, `500`, and `503` use the bounded retry ceiling; permanent responses do not.
- Raw-only reconciliation populates the missing aggregate state from raw truth without replaying the
  raw Events API request.
- A repair fixture proves the scoped read/intake block, in-flight drain, exact target-slice delete,
  bounded append population, Metric/Web retry-key count and zero-mismatch canonical-row
  reconciliation, Activation Entity/Run/counterfactual/timestamp candidate counts with zero timestamp
  mismatches, and resume ordering. Any failed step keeps the scope blocked.
- Forward deployment fixtures require `BACKFILL skip` on all three state targets and a deploy plan
  with no automatic all-history population. Initial population uses source App, Environment, and
  half-open source-time month bounds; Activation additionally filters `type = 'activation'`.
- Raw and state fixtures at the beginning, middle, and end of a UTC day expire at the same exact
  timestamp under matching retention.
- Activation raw/state fixtures expire at the same exact `activation_ts`-derived retention boundary.
- `server_received_at` controls first-touch ordering.
- For Exposure and Activation rows, Tinybird stamps `ingest_ts` at physical insertion with
  `DEFAULT now64(3)`. A delayed Queue delivery after a completed snapshot remains in the tail, and an
  empty snapshot falls back to the Unix epoch rather than hiding all tail rows.
- The Exposure snapshot reads `ingest_ts < watermark` and its tenant-scoped tail reads
  `ingest_ts >= watermark`; an insertion exactly equal to the watermark appears once after final UNION
  dedup, never zero or twice.
- Every Exposure serving source requires injected `app_id` and `environment_id` predicates before
  snapshot read, watermark aggregation, raw-tail read, or final aggregation.
- Exposure tail `EXPLAIN` fixtures require insertion-month partition pruning and the
  `(app_id, environment_id, ingest_ts, ...)` primary-key prefix; rows read may scale with the scoped
  post-snapshot tail, not total retained event-time history.
- Replacing the same Exposure snapshot twice and rebuilding `cp_srm_counts` and
  `cp_activation_rate` leaves identical rollup counts. No rollup materialized view is attached to
  either `raw_events` or `deduped_exposures`.
- For Metric and Web rows, Tinybird, not the producer, stamps `ingest_ts` at physical insertion with
  `DEFAULT now64(6)`.
- Late Metric/Web queue delivery and manual DLQ replay receive a new physical `ingest_ts` and dedup
  correctly through `argMinMerge` even when `server_received_at` is old.

### Run Start decision spec

- Start persists a decision spec snapshot with alpha, horizon/tuning, decision family, Guardrail
  thresholds, Primary Dimensions, winsorization config, and CUPED-eligible covariates.
- Post-start changes to locked fields return `DECISION_LOCKED` for decision-valid mutation.
- Post-start Metrics, Dimensions, and exploratory Guardrails produce `exploratory: true`,
  `decision_valid: false`, and `in_bh_family: false`.
- Stats reads use the Run snapshot, not mutable Experiment fields.

## Golden tests

Golden tests use small hand-auditable fixtures with exact expected output. They should live next to the
stats engine implementation once code exists.

| Area               | Required fixture                                                              |
| ------------------ | ----------------------------------------------------------------------------- |
| Binomial           | two-arm conversion rates with known Bernoulli variance                        |
| Count              | per-Entity sums, not event counts, drive variance                             |
| Revenue            | per-Entity revenue sums, reported as mean across Entities                     |
| Ratio              | `(num_value, denom_value)` covariance term changes CI versus naive variance   |
| Zero denominator   | `denom_i = 0` rows retained; arm-level `B = 0` fails loud                     |
| Relative lift      | `R_t / R_c - 1`; `R_c = 0` returns undefined relative lift, not fake infinity |
| Winsorization      | pooled cap is applied, sample size unchanged, arm-specific cap fixture fails  |
| CUPED              | pre-period covariate adjusts variance; insufficient coverage reports `none`   |
| CUPED fallback     | only locked/pre-period/historical covariates can be selected                  |
| BH FDR             | locked family rank/order produces expected adjusted significance              |
| Guardrail          | CI lower-bound breach triggers independently of BH significance               |
| SRM                | observed counts versus allocation triggers at `p < 0.001`                     |
| Activation balance | activated / not-activated by arm triggers at `p < 0.001`                      |
| `__multiple__`     | conflicted Entity excluded from arms and counted in health output             |

## Property and metamorphic tests

These tests prove invariants that should hold across many shapes of input.

- Reordering raw events does not change first-touch output.
- Duplicating raw Exposure events does not change deduped counts or Metric results.
- Adding raw events after the snapshot watermark appears through the tail exactly once.
- Adding a Secondary Metric post-start cannot change any locked result's `is_significant`.
- Adding a Secondary Dimension post-start cannot change BH family size `m`.
- Scaling all additive Metric values by a positive constant scales point estimates and CIs but does
  not change p-values.
- Splitting one Entity's events into more rows does not change per-Entity Metric values.
- Removing SDK seen-set suppression increases raw rows but does not change deduped results.
- Replacing arm-specific winsor caps with pooled caps is required; generated fixtures with asymmetric
  tails must fail if caps are computed separately by arm.

## Simulation tests

Simulation tests are seeded and versioned. They are regression alarms, not formal proofs. Thresholds
must account for Monte Carlo error and should be documented with the seed and iteration count.

| Test                                 | Null expectation                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Fixed-horizon no peeking             | Type I error near alpha at the locked sample size                                     |
| Sequential repeated looks            | Type I error near alpha under arbitrary looks                                         |
| Naive repeated fixed-horizon peeking | Fails in a control test, proving the harness can detect inflation                     |
| BH FDR                               | False discovery proportion controlled near configured q across Metric families        |
| Entity aggregation                   | Event-as-independent fake implementation fails under clustered data                   |
| Ratio covariance                     | Naive ratio variance fake implementation fails under correlated numerator/denominator |
| CUPED                                | Pre-period covariate reduces variance without shifting null mean                      |
| Winsorization                        | Heavy-tail fixture reduces variance and keeps sample size unchanged                   |
| SRM                                  | Biased allocation trips SRM at high probability                                       |
| Activation balance                   | Treatment-affected gate trips activation-balance diagnostic                           |

Monte Carlo gates should run in two modes:

- **Smoke mode:** low iteration count in regular CI to catch obvious regressions.
- **Audit mode:** higher iteration count nightly or before a stats-engine release.

## Spec lint

The docs and specs should fail lint on phrases or formulas that represent known statistical drift:

- the retired publish lifecycle verb with Experiment Runs.
- event-time snapshot tailing instead of `ingest_ts` watermarking.
- the old BH-family token instead of `decision_family`.
- wording that drops Ratio zero-denominator Entities.
- arm-specific caps as accepted winsorization behavior.
- legacy pooled-variance, interval-width, or alpha-derived p-value formulas as the aCS contract.
- any result schema missing `decision_valid` for decision-bearing outputs.

## Review checklist

Any PR touching ingest, dedup, Run Start, Metric aggregation, confidence intervals, FDR, Guardrails,
Activation gates, or result rendering must answer:

1. Which ADR/spec governs the change?
2. Which invariant could regress?
3. Which unit, golden, property, or simulation test covers it?
4. Does the API still expose enough metadata to audit decision validity?
5. If a statistical source changed, what paper or vendor reference supports the change?

## Sources

- [ADR-0030](../../adr/0030-statistical-rigor-is-an-enforced-product-contract.md)
- [ADR-0014](../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)
- [ADR-0015](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [ADR-0016](../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md)
- [Johari, Koomen, Pekelis, and Walsh, always-valid inference](https://pubsonline.informs.org/doi/10.1287/opre.2021.2135)
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
- [Benjamini and Hochberg, controlling the false discovery rate](https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1995.tb02031.x)
