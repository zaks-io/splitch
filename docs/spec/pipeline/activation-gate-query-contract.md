# Activation gate query contract — filter, re-anchor, and bias guardrails

Composes onto the first-touch dedup output (see [dedup-query-contract.md](./dedup-query-contract.md)). When an Experiment has an Activation Metric set, this gate filters the analysis population to activated Entities, re-anchors the Conversion Window, and computes two bias guardrails. The Activation Metric definition is **frozen per Run**.

## Activation gate scope

The gate is a **binary property on a Run**. When `run.activationMetric` is set, ALL Metrics for that Run are gated — the activated population is the analysis unit for everything. Per-Metric gating is not part of the contract.

## Inputs

- `exposed`: deduped first-touch output per `(targeting_key_hash, run_id)` with `__multiple__` already excluded (produced by [dedup-query-contract.md](./dedup-query-contract.md))
- `serve_deduped_activations`: deduplicated Activation candidates per Entity, Run, counterfactual
  kind, and `activation_ts` after aggregate-state merge, bounded by injected App, Environment, exact
  Run, and the Run's half-open activation-time analysis interval (ADR-0013)

## Activation JOIN query

```sql
WITH exposed AS (
  -- deduped first-touch output, __multiple__ excluded
  SELECT app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, variant, first_exposure_ts
  FROM serve_deduped_exposures
  WHERE variant != '__multiple__'
    AND app_id = {app_id: String}
    AND environment_id = {environment_id: String}
    AND run_id = {run_id: String}
),
activations AS (
  SELECT
    app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
    activation_ts
  FROM serve_deduped_activations
  WHERE app_id = {app_id: String}
    AND environment_id = {environment_id: String}
    AND run_id = {run_id: String}
    AND activation_ts >= {activation_from: DateTime64(3)}
    AND activation_ts < {activation_to: DateTime64(3)}
),
activated AS (
  SELECT
    e.app_id,
    e.environment_id,
    e.experiment_id,
    e.run_id,
    e.id_type,
    e.targeting_key_hash,
    e.variant,
    e.first_exposure_ts,
    MIN(a.activation_ts) AS activation_ts
  FROM exposed e
  INNER JOIN activations a
    ON  a.app_id = e.app_id
    AND a.environment_id = e.environment_id
    AND a.experiment_id = e.experiment_id
    AND a.run_id = e.run_id
    AND a.id_type = e.id_type
    AND a.targeting_key_hash = e.targeting_key_hash
    AND a.activation_ts > e.first_exposure_ts
  GROUP BY
    e.app_id,
    e.environment_id,
    e.experiment_id,
    e.run_id,
    e.id_type,
    e.targeting_key_hash,
    e.variant,
    e.first_exposure_ts
)
SELECT
  app_id,
  environment_id,
  experiment_id,
  run_id,
  id_type,
  targeting_key_hash,
  variant,
  first_exposure_ts,
  activation_ts,
  activation_ts AS window_anchor
FROM activated
```

`activation_from` and `activation_to` are server-derived from the retained Run and requested analysis
cutoff, never caller-selected free ranges. The serving Pipe translates them to event-date partition
bounds before `minMerge`; its explicit `include_counterfactual` parameter applies counterfactual
policy before merge. It preserves distinct candidate timestamps. The Exposure-relative JOIN rejects
pre-Exposure candidates before `MIN(a.activation_ts)` chooses the first valid Activation. Late Queue
delivery remains correct because partitioning follows `activation_ts`, not physical insertion time.

### Ordering invariant

`activation_ts > first_exposure_ts` is a hard filter. A pre-exposure activation is post-treatment selection bias and never counts (ADR-0012, Kohavi/OCE literature). Entities with only pre-exposure activations are treated as un-activated.

### Conversion Window anchor

`window_anchor = COALESCE(activation_ts, first_exposure_ts)` is a clean branch, not a superposition:

- When the gate is active: `window_anchor = activation_ts` (activation is the true entry moment)
- When no gate: `window_anchor = first_exposure_ts` (standard anchor, no gate involved)

The downstream Metric aggregation window always starts at `window_anchor`. CUPED pre-period stays anchored at `first_exposure_ts` regardless of gate — "before exposed" is immutable.

## Bias guardrails

Both guardrails are computed from the exposed + activated populations together:

### Guardrail 1: activated-population SRM

```sql
-- chi-square input: observed activated Entities per arm
SELECT
  run_id,
  variant,
  COUNT(DISTINCT targeting_key_hash)   AS activated_count
FROM <gate_output>               -- the INNER JOIN result above
GROUP BY run_id, variant
```

Compare `activated_count` per Variant against the Run's `declared_allocation` using chi-square (p < 0.001 threshold). A skewed activated population with a clean full-exposed SRM is the canonical fingerprint of a Treatment-affected gate (ADR-0012, Microsoft OCE).

### Guardrail 2: per-arm activation rate

```sql
-- numerator: activated Entities per arm
-- denominator: exposed Entities per arm (from dedup output, __multiple__ excluded)
SELECT
  run_id,
  e.variant,
  COUNT(DISTINCT a.targeting_key_hash)              AS activated,
  COUNT(DISTINCT e.targeting_key_hash)              AS exposed,
  activated / exposed                          AS activation_rate
FROM exposed e
LEFT JOIN activations a
  ON  a.targeting_key_hash = e.targeting_key_hash
  AND a.run_id        = e.run_id
  AND a.activation_ts > e.first_exposure_ts
GROUP BY run_id, e.variant
```

Activation-rate balance is tested with a chi-square test over the 2 × Variant table
`activated` / `not_activated` by arm, threshold `p < 0.001`. The output also reports the largest
absolute activation-rate gap across arms. The p-value is the alert; the rate gap explains WHY the
activated-population SRM fired.

**Either guardrail firing → gated results are untrusted.** Both guardrails always compute when a gate is set; they are not opt-in.

## Full-exposed SRM

The full-exposed SRM (from [dedup-query-contract.md](./dedup-query-contract.md)) always runs in parallel. The two SRMs together form the canonical bias fingerprint:

| full-exposed SRM | activated-population SRM | Interpretation                                    |
| ---------------- | ------------------------ | ------------------------------------------------- |
| Clean            | Clean                    | No bias detected                                  |
| Fires            | Any                      | Bucketing broken — experiment invalid             |
| Clean            | Fires                    | Treatment-affected gate — gated results untrusted |

## Counterfactual extension point (additive, ADR-0013)

Activation rows default to `counterfactual = false`. When SDK-side counterfactual evaluation is built
(deferred), Control-arm would-have-activated events enter the same raw log as
`counterfactual = true`, materialize into the same Activation state, and flow through the same serving
join and anchor. No schema change or raw serving path is added. The
`include_counterfactual` serving parameter gates their inclusion before `minMerge`.

## Output shape (per-Entity gated population)

```
{ app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, variant, first_exposure_ts, activation_ts, window_anchor }
```

This is handed to the stats engine for Metric aggregation. The stats engine uses `window_anchor` as the Conversion Window start.

## Sources

- [ADR-0012](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md) — gate semantics, re-anchor, two guardrails
- [ADR-0013](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md) — activation as first-class event, counterfactual additive
- [activation-gate-seam.md](../../architecture/activation-gate-seam.md) — query composition
- [Fabijan et al., Diagnosing Sample Ratio Mismatch in Online Controlled Experiments](https://dl.acm.org/doi/10.1145/3292500.3330722)
- [Deng and Hu, Diluted Treatment Effect Estimation for Trigger Analysis](https://exp-platform.com/Documents/wsdm2015-dilution.pdf)
