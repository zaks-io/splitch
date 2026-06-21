# Metric types and their roles in Experiment analysis

## What a Metric is

A **Metric** = a fact (the event/action measured) combined with an aggregation (how it is summarized per Entity). The thing an Experiment moves or guards. Metrics are decoupled from Runs: they are not frozen into the Run's immutable config; a Metric definition change is a measurement edit (recompute over the existing Run, no sample reset). See [run-lifecycle.md](./run-lifecycle.md).

## ExperimentMetric shape

| Field              | Type                                   | Req | Meaning                                                |
| ------------------ | -------------------------------------- | --- | ------------------------------------------------------ |
| `metric_id`        | `string` (ULID)                        | ✓   | Internal identifier                                    |
| `app_id`           | `string`                               | ✓   | Owning App                                             |
| `name`             | `string`                               | ✓   | Display name                                           |
| `event_name`       | `string`                               | ✓   | The event/action tracked in the log                    |
| `metric_type`      | `MetricType`                           | ✓   | See below                                              |
| `aggregation`      | `AggregationConfig`                    | ✓   | Per-Entity aggregation spec (sum, binary, mean, ratio) |
| `role`             | `"goal" \| "guardrail" \| "secondary"` | ✓   | Role in this Experiment's analysis                     |
| `guardrail_config` | `GuardrailConfig \| null`              | ✗   | Required when `role = "guardrail"`                     |

## Metric types

### Binomial Metric (Proportion Metric)

Did the Entity perform the action? Yes (1) or no (0).

`MetricType = "binomial"`

Aggregation: per Entity, the value is `MAX(converted)` (1 if any event, 0 if none). This is a proportion — the Metric value is the fraction of Entities who converted.

"Conversion" is an informal alias for a Binomial Metric event. It is not a first-class term.

### Count Metric

Sum of event values per Entity.

`MetricType = "count"`

Aggregation: `SUM(event_count)` per Entity. Example: pages viewed per Entity.

### Revenue Metric (Mean Metric)

Monetary value or duration per Entity.

`MetricType = "revenue"`

Aggregation: `SUM(amount)` per Entity; the Metric reports mean across Entities. Example:
revenue per user. Average order value or revenue per session is a Ratio Metric.

### Ratio Metric (Quotient Metric)

One Metric divided by another; numerator and denominator are aggregated independently per Entity.

`MetricType = "ratio"`

`AggregationConfig` for Ratio:

```
{
  numerator:   { event_name: string; aggregation: "sum" | "count" }
  denominator: { event_name: string; aggregation: "sum" | "count" }
}
```

**Delta-method variance is required** for Ratio Metrics (and any Metric finer than the Entity). The naive ratio-of-means variance silently understates variance and inflates false positives. That path does not exist in the engine. The stats engine receives per-Entity `(numerator, denominator)` pairs so the covariance term is recoverable — it is not recoverable after aggregation. (ADR-0015)

### Guardrail Metric

Any Metric type watched for unintended harm. Warns when the lower-bound of the Confidence Interval breaches a downside threshold.

`role = "guardrail"`

`GuardrailConfig = { threshold: number; direction: "lower_bound_above" | "upper_bound_below" }`

A Guardrail firing does not invalidate the Experiment; it is a warning signal. Guardrail Metrics are excluded from the BH FDR family (goal-metric × Variant family only).

### Activation Metric

See [activation-event.md](./activation-event.md). A gate rather than a measured Metric. When set, it filters the analysis population and re-anchors the Conversion Window.

## Analysis unit invariant

Variance is **always** computed over per-Entity aggregates. The denominator is always `COUNT(DISTINCT Entity)`, never events or sessions. Session is a Dimension, not a denominator unit. (CONTEXT.md, ADR-0015)

## BH FDR family

The Benjamini-Hochberg FDR family = goal-metric × Variant, locked at Experiment design time.
Guardrail and secondary Metrics are excluded from the family. Primary Dimensions multiply the
comparison family only when their values are declared before Run Start. Adding Dimensions
mid-Run never expands the decision family retroactively; those outputs are Secondary /
exploratory for the current Run.

## Sources

- [CONTEXT.md](../../../CONTEXT.md) — Metric type definitions
- [ADR-0015](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [Benjamini and Hochberg (1995), controlling the false discovery rate](https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1995.tb02031.x)
