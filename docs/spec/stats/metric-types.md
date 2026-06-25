# Metric types and per-Entity aggregation shapes

Metric classification, aggregation rules, and Conversion Window anchoring. Feeds directly into
variance computation ([inference-engine.md](inference-engine.md)).

## Metric taxonomy

| Type       | CONTEXT.md term | Aggregation per Entity      | Variance estimator           |
| ---------- | --------------- | --------------------------- | ---------------------------- |
| `binomial` | Binomial Metric | `0` or `1` (did/didn't)     | `p(1-p)`                     |
| `count`    | Count Metric    | sum of event values         | sample variance of sums      |
| `revenue`  | Revenue Metric  | sum of event values         | sample variance of sums      |
| `ratio`    | Ratio Metric    | `(num_sum, denom_sum)` pair | delta method with covariance |

A "Conversion" is informal language for a Binomial Metric event. It is not a first-class type.

## Aggregation rules per type

### Binomial Metric

```
y_i = 1 if entity_i had >= 1 qualifying event in Conversion Window, else 0
```

- Input: event log filtered to `[window_anchor, window_anchor + window_duration)`.
- Aggregation: one boolean fold per Entity per Run.
- Denominator for variance: unique Entities in the arm (deduped, first-touch).
- Winsorization: **never applied** (0/1 has no tail).

### Count Metric

```
y_i = SUM(event_value) for entity_i in Conversion Window
```

- Input: numeric event values (e.g., pages viewed = 1 per pageview event).
- Aggregation: per-Entity sum.
- Denominator: unique Entities.
- Winsorization: **applied by default** at 99.9th percentile before variance (ADR-0016).

### Revenue (Mean) Metric

```
y_i = SUM(event_value) for entity_i in Conversion Window
```

- Aggregation: per-Entity sum of monetary or duration values in window; result reports the mean
  of those sums across Entities.
- Denominator: unique Entities.
- Winsorization: **applied by default** at 99.9th percentile before variance (ADR-0016).
- Average order value, revenue per session, and similar denominator-normalized Metrics are Ratio
  Metrics, not Revenue Metrics.

### Ratio Metric

```
num_i   = SUM(numerator_event_value) for entity_i
denom_i = SUM(denominator_event_value) for entity_i
ratio   = SUM(num_i) / SUM(denom_i)   (population-level)
```

- Both numerator and denominator are aggregated **independently** to Entity level.
- They are delivered as a `(num_value, denom_value)` pair per Entity row (see
  [data-contracts.md](data-contracts.md)) — the covariance term requires the pair.
- Entities with `denom_i = 0` stay in the pair with a zero denominator; they are not dropped from
  the randomized population. Only an arm-level denominator mean of zero makes the ratio
  unestimable.
- Winsorization: applied per-metric to `num_i` and `denom_i` independently, if configured.
- **No naive ratio-of-means path exists.** Delta method is the only variance path.

### Guardrail Metric

A regular Metric (any type) annotated with a `downside_threshold`.

| Field                | Type     | Meaning                                                       |
| -------------------- | -------- | ------------------------------------------------------------- |
| `base_metric_id`     | `string` | The underlying Metric being guarded                           |
| `downside_threshold` | `number` | Minimum acceptable relative-lift lower bound (e.g., `-0.005`) |

Guardrail fires when `ci_lower < downside_threshold`. Excluded from the BH FDR family (see
[multiple-comparisons-fdr.md](multiple-comparisons-fdr.md)).

## Conversion Window

```
window_anchor    = COALESCE(activation_ts, first_exposure_ts)
window_end       = window_anchor + window_duration
event_in_window  = event_ts >= window_anchor AND event_ts < window_end
```

| Config field      | Type       | Scope      | Default                                 |
| ----------------- | ---------- | ---------- | --------------------------------------- |
| `window_duration` | `duration` | per-Metric | Experiment-level default (e.g., 7 days) |

Events before `window_anchor` or after `window_end` do not count toward the Metric.

### Activation re-anchor

When an Activation gate is set, `window_anchor = activation_ts` (the true entry moment).
`first_exposure_ts` is still available for:

- CUPED pre-period (always anchored at `first_exposure_ts`; immutable).
- Full-exposed SRM denominator (all Exposed Entities, not just activated).

See [srm-and-health.md](srm-and-health.md) for the two SRM populations.

### Pre-exposure activation rule

`activation_ts > first_exposure_ts` is enforced at the pipeline layer (ADR-0012). A pre-exposure
activation event is silently dropped from the activated set. The stats engine can assume all
activation rows satisfy this invariant.

## Metric definition fields

| Field                | Type                                    | Required | Meaning                                                                 |
| -------------------- | --------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `metric_id`          | `string`                                | yes      | Unique within App                                                       |
| `metric_type`        | `binomial \| count \| revenue \| ratio` | yes      |                                                                         |
| `event_name`         | `string`                                | yes      | Event type to match in log                                              |
| `event_value_field`  | `string \| null`                        | cond.    | Required for count/revenue/ratio num                                    |
| `denom_event_name`   | `string \| null`                        | cond.    | Required for ratio denominator                                          |
| `denom_value_field`  | `string \| null`                        | cond.    | Required for ratio denominator                                          |
| `window_duration`    | `duration`                              | yes      | Per-Metric window override                                              |
| `winsorize`          | `boolean`                               | yes      | Default `true` for count/revenue/ratio, `false` for binomial (ADR-0016) |
| `winsorize_pct`      | `number`                                | yes      | Default `99.9`; ignored if winsorize=false                              |
| `downside_threshold` | `number \| null`                        | no       | Set to make this a Guardrail Metric                                     |

## Measurement edits (no new Run)

Metric definition changes are **measurement edits** (ADR-0002). They recompute
over the existing Run losslessly; the raw event log is re-queried. No new Run, no sample reset.

Exception: changing the **Activation Metric** (the gate definition) is an **assignment edit** and
opens a new Run. The Activation Metric is frozen per Run.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md)
- CONTEXT.md §Metric definitions
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
