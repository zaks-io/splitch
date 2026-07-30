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

| Field         | Required | Notes                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `appId`       | yes      | Duplicates the path for route-derived MCP tool input; must match path     |
| `name`        | yes      | — (DEFINITION)                                                            |
| `key`         | yes      | Unique per App; immutable after create (DEFINITION)                       |
| `schema`      | no       | Supported JSON Schema subset or null; every Variant value must satisfy it |
| `variants`    | yes      | `{ name, value, isDefault, description? }[]`; exactly one default         |
| `description` | no       | —                                                                         |

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

| Field         | Required | Notes                                                                                           |
| ------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `name`        | no       | —                                                                                               |
| `value`       | no       | **Worker rejects if any running Run's `variantSet` includes this Variant** → `RUN_FROZEN` error |
| `description` | no       | —                                                                                               |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
