# Activation Metric: gate semantics, ordering constraint, re-anchoring, and bias guardrails

## What activation is

An **Activation Metric** gates analysis to Entities who performed a defined action (the "activation") after their first Exposure. It is a query-time filter composing with first-touch dedup — not a separate pipeline or event type.

An Entity is **activated** when it performs the activation action with `activation_ts > first_exposure_ts`. Pre-exposure activations never count: filtering on pre-exposure data breaks randomization (post-treatment selection bias per Kohavi/OCE literature).

## Activation as a first-class logged event

Activation is its own row type on the same append-only Exposure log (ADR-0010, ADR-0013), identified by `type = "activation"`. See [assignment-exposure-run.md](./assignment-exposure-run.md) for the unified row shape.

Applications create it through `activate(eventName, event)`. The call validates
and durably claims the declared Metric Event, resolves every live Run whose
frozen Activation Metric uses that Event Definition, and appends one Activation
row per match. Callers provide Entity identity and the product event only. They
never provide Experiment, Run, or Variant identity. A call with no matching live
Run fails before claiming the Metric Event, so a retry after configuration
propagates can still succeed.

### Activation row additional fields

| Field                | Type             | Req | Meaning                                                                                                              |
| -------------------- | ---------------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| `app_id`             | `string`         | ✓   | Data-isolation key                                                                                                   |
| `environment_id`     | `string`         | ✓   | Environment scope; Exposures/activations are per-Environment (ADR-0027)                                              |
| `experiment_id`      | `string`         | ✓   | Owning Experiment                                                                                                    |
| `run_id`             | `string`         | ✓   | Experiment Run at activation time                                                                                    |
| `targeting_key_hash` | `string`         | ✓   | HMAC-derived Entity identifier                                                                                       |
| `id_type`            | `string`         | ✓   | Entity type; always explicit                                                                                         |
| `server_received_at` | `timestamp`      | ✓   | Server-received-at                                                                                                   |
| `type`               | `"activation"`   | ✓   | Discriminator                                                                                                        |
| `counterfactual`     | `boolean`        | ✓   | `false` for ordinary rows; `true` for Control-arm would-have-activated events (additive extension, no schema change) |
| `variant`            | `string \| null` | ✓   | `null` for API-materialized Activations; the first Exposure supplies the analyzed Variant                            |

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
  SELECT e.app_id, e.environment_id, e.experiment_id, e.targeting_key_hash, e.id_type, e.run_id,
         e.variant, e.first_exposure_ts,
         MIN(a.activation_ts) AS activation_ts
  FROM   serve_deduped_exposures e
  JOIN   serve_deduped_activations a
    ON   a.app_id = e.app_id
    AND  a.environment_id = e.environment_id
    AND  a.experiment_id = e.experiment_id
    AND  a.run_id = e.run_id
    AND  a.targeting_key_hash = e.targeting_key_hash
    AND  a.id_type = e.id_type
    AND  a.activation_ts > e.first_exposure_ts  -- ordering constraint
  WHERE  e.variant != '__multiple__'
    AND  e.app_id = {app_id}
    AND  e.environment_id = {environment_id}
    AND  e.run_id = {run_id}
  GROUP BY e.app_id, e.environment_id, e.experiment_id, e.targeting_key_hash, e.id_type,
           e.run_id, e.variant, e.first_exposure_ts
)
```

`__multiple__` quarantine applies upstream (before this join). Entities in `__multiple__` are excluded from activated analysis as well.
Both serving sources require injected App, Environment, exact Run, and half-open event-time bounds;
the abbreviated query above omits only those repeated server-derived time predicates. The join
preserves Activation candidates until the post-Exposure predicate, then chooses the earliest valid
candidate. It never scans physical `raw_events`.

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
