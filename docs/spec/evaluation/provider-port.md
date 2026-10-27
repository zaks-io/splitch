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
  getExperiment(appId: string, environmentId: string, experimentId: string): Promise<ExperimentConfig>

  // Resolve Flag Configuration + Targeting rules for the evaluate path, in one Environment.
  getFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig>

  // Bulk fetch all Flag Configurations for an Environment (used at request start to pre-load context).
  getFlags(appId: string, environmentId: string): Promise<FlagConfig[]>
}
```

`environmentId` is co-scoped with `appId` because Flag Configuration, Experiments, and Experiment
Runs are per-Environment (ADR-0027). The edge resolves `environmentId` from the presented SDK key
before consulting the Provider.

The Provider **does not** run rule matching, segment evaluation, or Fractional Evaluation.
It returns the rule set; the evaluate path iterates and matches.

## ExperimentConfig shape

| Field              | Type                              | Required | Meaning                                                               |
| ------------------ | --------------------------------- | -------- | --------------------------------------------------------------------- |
| `experimentId`     | string                            | yes      | Stable Experiment identity                                            |
| `appId`            | string                            | yes      | Isolation scope                                                       |
| `environmentId`    | string                            | yes      | Co-scoped with `appId`; Experiment/Run are per-Environment (ADR-0027) |
| `liveRunId`        | string \| null                    | yes      | Hydrated: the current live Run; null if no Run is live yet            |
| `liveRun`          | `RunConfig \| null`               | yes      | Full frozen RunConfig for the live Run (hydrated inline)              |
| `targetingKeyType` | string                            | yes      | Pinned Entity type; must match request `idType`                       |
| `status`           | `'draft' \| 'running' \| 'ended'` | yes      | Current lifecycle state                                               |

`RunConfig` shape: see [assign-pure-function.md](./assign-pure-function.md).

## FlagConfig shape

| Field                   | Type                        | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flagKey`               | string                      | yes      | Unique within App                                                                                                                                                                                                                                                                                                                                                                                            |
| `appId`                 | string                      | yes      | Isolation scope                                                                                                                                                                                                                                                                                                                                                                                              |
| `environmentId`         | string                      | yes      | Co-scoped with `appId`; Flag Configuration is per-Environment (ADR-0027)                                                                                                                                                                                                                                                                                                                                     |
| `experimentId`          | string \| null              | yes      | Controlling Experiment in this Environment, or null if none. Read in this same `getFlag` call so flag → experiment never needs a second lookup                                                                                                                                                                                                                                                               |
| `enabled`               | boolean                     | yes      | If false: return Default Variant on all requests                                                                                                                                                                                                                                                                                                                                                             |
| `defaultVariant`        | string                      | yes      | Variant **name** returned when disabled or no rule matches. The Provider resolves it from the stored `FlagConfigKV.defaultVariantId` (an ID; see [contracts/storage-schemas-kv.md](../contracts/storage-schemas-kv.md)) into the name — the evaluate path works in names throughout (assign() returns a name; Exposure logs a name; see [contracts/leaf-schemas-flag.md](../contracts/leaf-schemas-flag.md)) |
| `variants`              | `Variant[]`                 | yes      | All possible Variants; value type is JSON. Resolved view of the stored catalog (which also carries `id`); the evaluate path keys on `name`                                                                                                                                                                                                                                                                   |
| `availableVariantNames` | `string[]`                  | yes      | Environment-available Variants used by baseline rollout                                                                                                                                                                                                                                                                                                                                                      |
| `rollout`               | `PercentageRollout \| null` | yes      | Baseline percentage and salt, used after unmatched Flag rules without a live Run                                                                                                                                                                                                                                                                                                                             |
| `targetingRules`        | `ResolvedTargetingRule[]`   | yes      | Priority-ordered concrete Conditions; evaluate path iterates, first match wins                                                                                                                                                                                                                                                                                                                               |

## TargetingRule shape

| Field               | Type                                           | Required | Meaning                                                                                        |
| ------------------- | ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`                | string                                         | yes      | Stable rule identity; appears in test-evaluation reason                                        |
| `priority`          | integer                                        | yes      | Lower = matched first; evaluate path sorts ascending                                           |
| `conditions`        | `Condition[]`                                  | yes      | All must match (AND); each Condition is `{attribute, operator, value}`                         |
| `variantId`         | string                                         | yes      | Variant ID resolved against the Flag catalog when the rule matches                             |
| `percentageRollout` | `{ percentage: number; salt: string } \| null` | optional | If set, selects the rule Variant for this percentage (0 to 100), otherwise the Default Variant |

## Condition shape

| Field       | Type                                                                                                | Required | Meaning                                                          |
| ----------- | --------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `attribute` | string                                                                                              | yes      | Key in EvaluationContext.attributes (e.g. `"country"`, `"plan"`) |
| `operator`  | `'eq' \| 'neq' \| 'in' \| 'not_in' \| 'gt' \| 'lt' \| 'gte' \| 'lte' \| 'matches' \| 'not_matches'` | yes      | Direct comparison                                                |
| `value`     | `string \| number \| boolean \| string[]`                                                           | yes      | Operand                                                          |

Segment references are resolved by the control plane before this Provider view exists. The Provider
never receives a Segment id and performs no Segment lookup.

## EvaluationContext shape

| Field          | Type                                                       | Required | Meaning                                                                          |
| -------------- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `targetingKey` | string                                                     | yes      | The Entity identifier; first-class field; used for Fractional Evaluation hashing |
| `idType`       | string                                                     | yes      | Entity type (e.g. `"user"`, `"workspace"`); guards Assignment Store key          |
| `attributes`   | `Record<string, boolean \| string \| number \| unknown[]>` | yes      | Attributes available to Targeting Rule Conditions                                |

`targetingKey` is required and first-class. All entries in `attributes` are available to
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

**Adapters:** the Evaluation Worker uses `KvProvider`; local Convex and Cloudflare integrations
use `configSnapshotProvider` from the shared evaluation core. Both expose the same Provider
contract, and tests substitute a fake. Rule matching remains in the shared evaluate path.

**Failure contract (fail-loud, ADR-0036):** Provider errors produce an error result with
`errorCode`, no Exposure decision, and a loud log. The known Default Variant name is retained when
available; an error before Flag resolution can have `variant: null`. A Provider freshness failure may
carry `reason: STALE`; other errors carry `ERROR`. HTTP accessors render the canonical error
envelope, and the SDK supplies the caller's default. A disabled Flag is a legitimate `DISABLED`
resolution.

## Sources

- [../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
