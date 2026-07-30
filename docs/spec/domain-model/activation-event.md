# Activation Metric: gate semantics, ordering constraint, re-anchoring, and bias guardrails

## What activation is

An **Activation Metric** gates analysis to Entities who performed a defined action (the "activation") after their first Exposure. It is a query-time filter composing with first-touch dedup — not a separate pipeline or event type.

An Entity is **activated** when it performs the activation action with `activation_ts > first_exposure_ts`. Pre-exposure activations never count: filtering on pre-exposure data breaks randomization (post-treatment selection bias per Kohavi/OCE literature).

## Activation as a first-class logged event

Activation is its own row type on the same append-only Exposure log (ADR-0010, ADR-0013), identified by `type = "activation"`. See [assignment-exposure-run.md](./assignment-exposure-run.md) for the unified row shape.

### Activation row additional fields

| Field                | Type              | Req | Meaning                                                                                                 |
| -------------------- | ----------------- | --- | ------------------------------------------------------------------------------------------------------- |
| `app_id`             | `string`          | ✓   | Data-isolation key                                                                                      |
| `environment_id`     | `string`          | ✓   | Environment scope; Exposures/activations are per-Environment (ADR-0027)                                 |
| `experiment_id`      | `string`          | ✓   | Owning Experiment                                                                                       |
| `run_id`             | `string`          | ✓   | Experiment Run at activation time                                                                       |
| `targeting_key_hash` | `string`          | ✓   | HMAC-derived Entity identifier                                                                          |
| `id_type`            | `string`          | ✓   | Entity type; always explicit                                                                            |
| `server_received_at` | `timestamp`       | ✓   | Server-received-at                                                                                      |
| `type`               | `"activation"`    | ✓   | Discriminator                                                                                           |
| `counterfactual`     | `boolean \| null` | ✗   | `null` unless emitted by Control-arm would-have-activated events (additive extension, no schema change) |

Counterfactual triggering is additive: the future Kohavi-correct gate is implemented as the Control arm emitting an activation row with `counterfactual: true`. Same log, same join, same anchor, same SRM. Zero schema change. (ADR-0013)

## Activation config (frozen per Run)

`ActivationMetricConfig = { event_name: string; conditions?: Condition[] }`

The Activation Metric config is **frozen at Run creation** — it is an assignment-affecting edit. Setting or changing it opens a new Run on Start.

If the gate is set but no activation events are logged at analysis time, the activated population is empty (0 Entities); both guardrails fire. Analysis runs on an empty set — this is the correct, permissive behavior. No upfront requirement to wire the event before setting the gate.

## Conversion Window re-anchoring

When an Activation Metric is set, the Conversion Window anchor shifts:

`window_anchor = COALESCE(activation_ts, first_exposure_ts)`

- Activated Entity: `window_anchor = activation_ts` (true entry moment)
- Un-activated Entity: excluded from gated analysis entirely (not anchored at `first_exposure_ts`)

The anchor for **CUPED pre-period** stays fixed at `first_exposure_ts` even when activation re-anchors the Conversion Window. Pre-period = "before exposed", immutable. It does not shift to "before activated."

**Gating scope:** the Activation gate is a binary Experiment property — when set, it gates **all Metrics** in the Experiment's analysis. There is no per-Metric gating.

## Query composition

```
activated_entities = (
  SELECT e.targeting_key_hash, e.id_type, e.run_id,
         MIN(e.server_received_at) AS first_exposure_ts,
         MIN(a.server_received_at) AS activation_ts
  FROM   deduped_exposures e
  JOIN   raw_events a
    ON   a.experiment_id = e.experiment_id
    AND  a.run_id = e.run_id
    AND  a.targeting_key_hash = e.targeting_key_hash
    AND  a.id_type = e.id_type
    AND  a.type = 'activation'
    AND  a.server_received_at > e.first_exposure_ts  -- ordering constraint
  GROUP BY e.targeting_key_hash, e.id_type, e.run_id
)
```

`__multiple__` quarantine applies upstream (before this join). Entities in `__multiple__` are excluded from activated analysis as well.

## Bias guardrails (mandatory)

**Both guardrails are always computed when an Activation Metric is set. Neither is optional.**

### 1. Activated-population SRM

Chi-square on the activated Entities per arm per Run (p < 0.001), separate from the full-exposed SRM.

- Full-exposed SRM clean + activated-population SRM fires = canonical fingerprint of a Treatment-affected gate (GrowthBook/Microsoft OCE diagnosis)
- Either SRM (full-exposed or activated-population) firing → gated results are **untrusted**

### 2. Per-arm activation rate as a first-class Metric

`activation_rate = COUNT(activated) / COUNT(exposed)` per arm.

Divergence across arms is tested with a chi-square test over activated / not-activated by arm,
threshold `p < 0.001`. The result also reports the largest absolute activation-rate gap. This
Metric is always computed alongside goal Metrics when a gate is set.

**Either guardrail firing means the gated results are untrusted.** The system surfaces this prominently; the gated scorecard is visually flagged "UNTRUSTED" when either fires.

No reference vendor ships this exact built-in per-arm activation-rate balance diagnostic with SRM-style alerting. It goes beyond vendor minimum because the failure mode (Treatment-affected gate) is silent without it. (ADR-0012)

## Sources

- [ADR-0012](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [ADR-0013](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [activation-gate-seam.md](../../architecture/activation-gate-seam.md)
- [Deng and Hu, Diluted Treatment Effect Estimation for Trigger Analysis](https://exp-platform.com/Documents/wsdm2015-dilution.pdf)
