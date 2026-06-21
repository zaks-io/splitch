# Provider port — stateless flag-config resolver

The Provider is a **stateless read-side resolver**: its only state is an invalidatable cache
of flag config. It never holds per-Entity assignment memory, Exposure history, or holdover
state. The evaluate path consults the Provider for live config; it consults the Assignment
Store for holdover state. Neither is behind the other. (ADR-0007.)

## Port interface

```
interface Provider {
  // Resolve live Run config for one Experiment.
  // Experiment carries liveRunId hydrated (one query, not two).
  getExperiment(appId: string, experimentId: string): ExperimentConfig

  // Resolve Flag definition + Targeting rules for the evaluate path.
  getFlag(appId: string, flagKey: string): FlagConfig

  // Bulk fetch all Flags for an App (used at request start to pre-load hot-path context).
  getFlags(appId: string): FlagConfig[]
}
```

The Provider **does not** run rule matching, segment evaluation, or Fractional Evaluation.
It returns the rule set; the evaluate path iterates and matches.

## ExperimentConfig shape

| Field | Type | Required | Meaning |
|---|---|---|---|
| `experimentId` | string | yes | Stable Experiment identity |
| `appId` | string | yes | Isolation scope |
| `liveRunId` | string \| null | yes | Hydrated: the current live Run; null if no Run is live yet |
| `liveRun` | `RunConfig \| null` | yes | Full frozen RunConfig for the live Run (hydrated inline) |
| `status` | `'draft' \| 'running' \| 'ended'` | yes | Current lifecycle state |

`RunConfig` shape: see [assign-pure-function.md](./assign-pure-function.md).

## FlagConfig shape

| Field | Type | Required | Meaning |
|---|---|---|---|
| `flagKey` | string | yes | Unique within App |
| `appId` | string | yes | Isolation scope |
| `enabled` | boolean | yes | If false: return Default Variant on all requests |
| `defaultVariant` | string | yes | Variant name returned when disabled or no rule matches |
| `variants` | `{ name: string; value: boolean \| string \| number \| object }[]` | yes | All possible Variants; value type is JSON |
| `targetingRules` | `TargetingRule[]` | yes | Priority-ordered; evaluate path iterates, first match wins |

## TargetingRule shape

| Field | Type | Required | Meaning |
|---|---|---|---|
| `ruleId` | string | yes | Stable rule identity; appears in test-evaluation reason |
| `ruleName` | string | yes | Human-readable label |
| `priority` | integer | yes | Lower = matched first; evaluate path sorts ascending |
| `conditions` | `Condition[]` | yes | All must match (AND); each Condition is `{attribute, operator, value}` |
| `variant` | string | yes | Variant name to serve when rule matches |
| `percentageRollout` | `{ weights: { variantName: string; weight: number }[] } \| null` | optional | If set, Fractional Evaluation applies within matched Entities; weights sum to 1.0 |

## Condition shape

| Field | Type | Required | Meaning |
|---|---|---|---|
| `attribute` | string | yes | Key in EvaluationContext (e.g. `"country"`, `"plan"`) |
| `operator` | `'eq' \| 'neq' \| 'in' \| 'not_in' \| 'gt' \| 'lt' \| 'gte' \| 'lte' \| 'contains' \| 'segment_in' \| 'segment_not_in'` | yes | Comparison or Segment membership |
| `value` | `string \| number \| boolean \| string[]` | yes | Operand |

`segment_in` / `segment_not_in`: the `value` is a Segment ID. Segment membership = the
Entity matches the Segment's own Conditions. Segments are Conditions, not a separate
authorization layer.

## EvaluationContext shape

| Field | Type | Required | Meaning |
|---|---|---|---|
| `targetingKey` | string | yes | The Entity identifier; first-class field; used for Fractional Evaluation hashing |
| `idType` | string | yes | Entity type (e.g. `"user"`, `"workspace"`); guards Assignment Store key |
| `[attribute]` | `string \| number \| boolean` | optional | Arbitrary attributes available to Targeting Rule Conditions |

`targetingKey` is required and first-class. All attributes in context are available to
Condition matching. `idType` must match the Experiment's configured Entity type and must be
explicit on every evaluate request.

## Cache invalidation

Provider caches flag config invalidatably. When a WebSocket nudge is received (ADR-0019),
the Provider invalidates its cache and re-fetches the affected App's config. Drafts never
appear in the cache; only published (`running`) config is distributed.

## Seam boundary

**What's on this side (Provider):** flag config, Run frozen config, Targeting rules,
Variant definitions, enabled state, Default Variant.

**What's on the other side (evaluate path):** rule iteration, first-match logic, Fractional
Evaluation bucketing, holdover replay, Exposure firing.

**Deletion test:** two real Provider adapters exist (Cloudflare Flagship, flagd reference);
each returns the same FlagConfig shape. The evaluate path's rule-matching logic is
Provider-agnostic. Seam is real.

**Failure contract:** If Provider.getExperiment() or getFlag() throws (network error, KV
miss), the evaluate path returns the Default Variant. No Exposure is fired on a Provider
error. The error is logged (fail-loud principle).

## Sources

- [../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
