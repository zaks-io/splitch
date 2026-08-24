# Request/response envelopes: Flag and Variant endpoints

Wire shapes for Flag and Variant control-plane endpoints: create/patch asymmetry and the Variant
sub-resource Run-frozen guard.

Envelopes compose leaf schemas from [leaf-schemas-flag.md](./leaf-schemas-flag.md). They are **distinct**
— never fused — because create and patch have different required fields. Shared conventions live in
[request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Flag endpoints

Flag DEFINITION (`key`, name, value schema, Variant catalog, Default Variant) is App-level. Flag
CONFIGURATION (`enabled`, `availableVariantNames`, `targetingRules`) is per-Environment (ADR-0027) and is
not accepted by these App-level endpoints.

### CreateFlagRequest

| Field             | Required | Notes                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------- |
| `appId`           | yes      | Duplicates the path for route-derived MCP tool input; must match path            |
| `name`            | yes      | — (DEFINITION)                                                                   |
| `key`             | yes      | Unique per App; immutable after create (DEFINITION)                              |
| `schema`          | no       | Supported JSON Schema subset or null; every Variant value must satisfy it        |
| `variants`        | yes      | `{ name, value, isDefault, description? }[]`; exactly one default                |
| `description`     | no       | —                                                                                |
| `idempotency_key` | yes      | `flags_create` is an Idempotency-Key route; sent as the `Idempotency-Key` header |

Worker computes: `id`, `defaultVariantId`, `createdAt`, `updatedAt`.

### PatchFlagRequest

Accepts only non-key, non-appId App-level definition fields. `enabled`,
`availableVariantNames`, `defaultVariantId`, and targeting fields are rejected here.

| Field         | Required | Notes                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------- |
| `name`        | no       | DEFINITION                                                                    |
| `schema`      | no       | Supported JSON Schema subset or null; existing Variant values must satisfy it |
| `description` | no       | —                                                                             |

Variants and TargetingRules are managed via sub-resource endpoints (`/variants`, `/targeting-rules`).

### FlagResponse

Returns the App-level Flag definition. No per-Environment fields (`enabled`, availability, targeting) and
no storage internals (`version`, `createdBy`).

### FlagListResponse

`flags_list` accepts an optional, non-empty `environmentId`. Omission requests the App-level catalog
alone. Supplying an Environment ID requests the same bounded catalog with a
`flagConfiguration` summary on every item:

```
{
  items: Array<FlagResponse & {
    flagConfiguration?: {
      enabled: boolean,
      rollout: number | null,
      defaultVariant: string
    }
  }>,
  readTruncated: boolean,
  readLimit: positive integer
}
```

The summary is exact and intentionally smaller than `FlagConfigResponse`: `rollout` is the baseline
percentage or `null`, `defaultVariant` is the Variant name, and availability and Targeting Rules are
absent. `flagConfiguration` is absent from every item when `environmentId` is omitted and required
on every item when it is supplied. An empty `environmentId` is invalid rather than equivalent to
omission.

---

## Flag Configuration endpoint

The per-Environment counterpart to the App-level Flag endpoints above. One envelope,
`FlagConfigResponse`, is returned by every route that reads or writes a Flag Configuration
(`flag_config_get`, `flag_config_update`, `flag_targeting_rules_replace`, and both sides of the
`flags_promote` diff), so a caller never has to reconcile two shapes for the same resource.

### FlagConfigResponse

| Field                   | Required | Notes                                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `flagId`                | yes      | The App-level Flag this Configuration belongs to                                   |
| `environmentId`         | yes      | The Environment grain; `experiment` and availability are scoped to it              |
| `version`               | yes      | Monotonic Configuration version                                                    |
| `enabled`               | yes      | The kill switch for this Environment                                               |
| `availableVariantNames` | yes      | Catalog subset servable here, by Variant NAME; empty = never narrowed              |
| `targetingRules`        | yes      | Ordered, first-match-wins                                                          |
| `rollout`               | yes      | Baseline PercentageRollout for traffic matching no rule, or `null`                 |
| `experiment`            | yes      | `{ id, name }` of the controlling Experiment, or `null` when none controls it here |

`experiment` is **nullable-not-absent**, mirroring `FlagConfigKV.experimentId` in
[storage-schemas-kv.md](./storage-schemas-kv.md): a reader is told "no Experiment controls this"
rather than left to infer it from a missing key. It is resolved inside the same read from the
Experiment row the Configuration snapshot already loads, so a caller rendering the
"Controlled by Experiment X" lock affordance never issues a second lookup that could disagree with
the Configuration it is locking. It is non-null only for a **running** Experiment — a draft or ended
Experiment attached to this Flag locks nothing. It is derived from D1, the authoritative store the
write guards themselves consult, and from the same `status === "running"` test that sets
`FlagConfigKV.experimentId`, so the lock and the pointer cannot disagree. A lagging KV read replica
therefore cannot report a lock the write path would refuse to enforce, nor wedge the read.

`rollout` is the full PercentageRollout leaf, so it carries the server-minted `salt`. The salt is
never operator-facing: no editor surface displays or accepts it
([frontend/flag-editing-ux.md](../frontend/flag-editing-ux.md)).

### FlagConfigMutationResponse

Flag Configuration patch and Targeting Rule replacement return:

```
{
  config: FlagConfigResponse
  approvalRequest: ApprovalRequest | null
}
```

`approvalRequest` is null under `allow` and contains the applied request under `confirm`. Promotion
uses the same field alongside its selected Configuration diff. A pending future `approve` or omitted
required Review returns `APPROVAL_REVIEW_REQUIRED` instead of pretending the target changed.

---

## Variant sub-resource endpoints

### CreateVariantRequest

| Field         | Required | Notes                                                           |
| ------------- | -------- | --------------------------------------------------------------- |
| `appId`       | yes      | Duplicates the path for derived MCP tool input; must match path |
| `flagId`      | yes      | Duplicates the path for derived MCP tool input; must match path |
| `name`        | yes      | —                                                               |
| `value`       | yes      | `boolean \| string \| number \| object`                         |
| `isDefault`   | no       | If true, this Variant becomes the one Default Variant           |
| `description` | no       | —                                                               |

### PatchVariantRequest

| Field             | Required | Notes                                                                                                 |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `name`            | no       | —                                                                                                     |
| `value`           | no       | Worker rejects if any running Run's `variantSet` includes this Variant with `RUN_FROZEN`              |
| `description`     | no       | —                                                                                                     |
| `review`          | no       | `{ action: 'approve_and_apply' }`; inline canonical Review when an impacted Policy requires `confirm` |
| `idempotency_key` | yes      | Owns the App-level Approval Request and any inline Review across retries                              |

### App-level Variant value Approval target

A Variant value is App-level, so a caller cannot choose one Environment whose Policy authorizes a
change that affects others. For a `value` patch, the Worker computes every Environment where the
Variant is effectively servable and evaluates each Environment's `targetingRolloutValue` Policy.
The strictest required Review authority wins:

- all `allow`: no Review is required; the value change enters the shared validated application
  seam directly;
- any `confirm`, no future `approve`: the proposer may invoke `approve_and_apply`;
- any future `approve`: the proposer cannot self-review; an authorized distinct principal must
  invoke that same action.

The Approval target is `flag_variant`, keyed by the Variant ID. Its opaque `target.version` hashes
the parent `flags.version` and a sorted vector of impacted
`(environmentId, flagConfigVersion, targetingRolloutValue Policy level)` values. The proposal stores
that policy context and the immutable current/proposed value diff. A parent Flag, availability,
Configuration version, or relevant Policy change before Review makes the request `stale`. The
request cannot be revived or applied.

`name` and `description` remain ordinary App-level metadata edits. Only a `value` change uses the
Policy and Approval contract. A mixed patch applies all fields atomically through the value-change
Approval Request so metadata cannot land while the reviewed value fails.

There is no Variant-specific confirmation pipeline. `review.action = 'approve_and_apply'` is the
same Review action used by Flag Configuration changes, Promotion, and Experiment Run Start.

Applied response:

```
{
  flag: FlagResponse
  approvalRequest: ApprovalRequest | null
}
```

The request is null when no Review was required and contains the applied request otherwise.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
