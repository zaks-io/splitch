# Provider port — stateless flag-config resolver

The Provider is a **stateless read-side resolver**: its only state is an invalidatable cache
of flag config. It never holds per-Entity assignment memory, Exposure history, or holdover
state. The evaluate path consults the Provider for live config; it consults the Assignment
Store for holdover state. Neither is behind the other. (ADR-0007.)

## Port interface

```
interface Provider {
  // Resolve live Run config for one Experiment in one Environment.
  // Experiment carries liveRunId hydrated (one query, not two).
  getExperiment(appId: string, environmentId: string, experimentId: string): ExperimentConfig

  // Resolve Flag Configuration + Targeting rules for the evaluate path, in one Environment.
  getFlag(appId: string, environmentId: string, flagKey: string): FlagConfig

  // Bulk fetch all Flag Configurations for an Environment (used at request start to pre-load context).
  getFlags(appId: string, environmentId: string): FlagConfig[]
}
```

`environmentId` is co-scoped with `appId` because Flag Configuration, Experiments, and Experiment
Runs are per-Environment (ADR-0027). The edge resolves `environmentId` from the presented SDK key
before consulting the Provider.

The Provider **does not** run rule matching, segment evaluation, or Fractional Evaluation.
It returns the rule set; the evaluate path iterates and matches.

## ExperimentConfig shape

| Field           | Type                              | Required | Meaning                                                               |
| --------------- | --------------------------------- | -------- | --------------------------------------------------------------------- |
| `experimentId`  | string                            | yes      | Stable Experiment identity                                            |
| `appId`         | string                            | yes      | Isolation scope                                                       |
| `environmentId` | string                            | yes      | Co-scoped with `appId`; Experiment/Run are per-Environment (ADR-0027) |
| `liveRunId`     | string \| null                    | yes      | Hydrated: the current live Run; null if no Run is live yet            |
| `liveRun`       | `RunConfig \| null`               | yes      | Full frozen RunConfig for the live Run (hydrated inline)              |
| `status`        | `'draft' \| 'running' \| 'ended'` | yes      | Current lifecycle state                                               |

`RunConfig` shape: see [assign-pure-function.md](./assign-pure-function.md).

## FlagConfig shape

| Field            | Type                                                               | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flagKey`        | string                                                             | yes      | Unique within App                                                                                                                                                                                                                                                                                                                                                                                            |
| `appId`          | string                                                             | yes      | Isolation scope                                                                                                                                                                                                                                                                                                                                                                                              |
| `environmentId`  | string                                                             | yes      | Co-scoped with `appId`; Flag Configuration is per-Environment (ADR-0027)                                                                                                                                                                                                                                                                                                                                     |
| `experimentId`   | string \| null                                                     | yes      | Controlling Experiment in this Environment, or null if none. Read in this same `getFlag` call so flag → experiment never needs a second lookup                                                                                                                                                                                                                                                               |
| `enabled`        | boolean                                                            | yes      | If false: return Default Variant on all requests                                                                                                                                                                                                                                                                                                                                                             |
| `defaultVariant` | string                                                             | yes      | Variant **name** returned when disabled or no rule matches. The Provider resolves it from the stored `FlagConfigKV.defaultVariantId` (an ID; see [contracts/storage-schemas-kv.md](../contracts/storage-schemas-kv.md)) into the name — the evaluate path works in names throughout (assign() returns a name; Exposure logs a name; see [contracts/leaf-schemas-flag.md](../contracts/leaf-schemas-flag.md)) |
| `variants`       | `{ name: string; value: boolean \| string \| number \| object }[]` | yes      | All possible Variants; value type is JSON. Resolved view of the stored catalog (which also carries `id`); the evaluate path keys on `name`                                                                                                                                                                                                                                                                   |
| `targetingRules` | `ResolvedTargetingRule[]`                                          | yes      | Priority-ordered concrete Conditions; evaluate path iterates, first match wins                                                                                                                                                                                                                                                                                                                               |

## TargetingRule shape

| Field               | Type                                                             | Required | Meaning                                                                           |
| ------------------- | ---------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `ruleId`            | string                                                           | yes      | Stable rule identity; appears in test-evaluation reason                           |
| `ruleName`          | string                                                           | yes      | Human-readable label                                                              |
| `priority`          | integer                                                          | yes      | Lower = matched first; evaluate path sorts ascending                              |
| `conditions`        | `Condition[]`                                                    | yes      | All must match (AND); each Condition is `{attribute, operator, value}`            |
| `variant`           | string                                                           | yes      | Variant name to serve when rule matches                                           |
| `percentageRollout` | `{ weights: { variantName: string; weight: number }[] } \| null` | optional | If set, Fractional Evaluation applies within matched Entities; weights sum to 1.0 |

## Condition shape

| Field       | Type                                                                                                | Required | Meaning                                               |
| ----------- | --------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `attribute` | string                                                                                              | yes      | Key in EvaluationContext (e.g. `"country"`, `"plan"`) |
| `operator`  | `'eq' \| 'neq' \| 'in' \| 'not_in' \| 'gt' \| 'lt' \| 'gte' \| 'lte' \| 'matches' \| 'not_matches'` | yes      | Direct comparison                                     |
| `value`     | `string \| number \| boolean \| string[]`                                                           | yes      | Operand                                               |

Segment references are resolved by the control plane before this Provider view exists. The Provider
never receives a Segment id and performs no Segment lookup.

## EvaluationContext shape

| Field          | Type                          | Required | Meaning                                                                          |
| -------------- | ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| `targetingKey` | string                        | yes      | The Entity identifier; first-class field; used for Fractional Evaluation hashing |
| `idType`       | string                        | yes      | Entity type (e.g. `"user"`, `"workspace"`); guards Assignment Store key          |
| `[attribute]`  | `string \| number \| boolean` | optional | Arbitrary attributes available to Targeting Rule Conditions                      |

`targetingKey` is required and first-class. All attributes in context are available to
Condition matching. `idType` must match the Experiment's configured Entity type and must be
explicit on every evaluate request.

## Cache invalidation

Provider caches flag config invalidatably. When a WebSocket nudge is received (ADR-0019),
the Provider invalidates its cache and re-fetches the affected App's config. Drafts never
appear in the cache; only live (`running`) config is distributed.

## Seam boundary

**What's on this side (Provider):** flag config, Run frozen config, Targeting rules,
Variant definitions, enabled state, Default Variant.

**What's on the other side (evaluate path):** rule iteration, first-match logic, Fractional
Evaluation bucketing, holdover replay, Exposure firing.

**Deletion test:** two real Provider adapters exist (Cloudflare Flagship, flagd reference);
each returns the same FlagConfig shape. The evaluate path's rule-matching logic is
Provider-agnostic. Seam is real.

**Failure contract (fail-loud, ADR-0036):** If Provider.getExperiment() or getFlag() throws
(network error, KV miss), the evaluate path returns the Default Variant \*\*with `reason: ERROR`

- an `errorCode`\** and fires no Exposure. The error is logged loudly — the failure is always
  observable in the result, never a silent default. (A *disabled\* flag, by contrast, is a
  legitimate `reason: DISABLED`, not an error.)

## Sources

- [../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
