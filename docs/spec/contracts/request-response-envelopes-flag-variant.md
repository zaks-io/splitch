# Request/response envelopes: Flag and Variant endpoints

Wire shapes for Flag and Variant control-plane endpoints: create/patch asymmetry and the Variant
sub-resource Run-frozen guard.

Envelopes compose leaf schemas from [leaf-schemas-flag.md](./leaf-schemas-flag.md). They are **distinct**
— never fused — because create and patch have different required fields. Shared conventions live in
[request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Flag endpoints

Flag DEFINITION (`key`, name, Variant catalog) is App-level; Flag CONFIGURATION (`enabled`,
`availableVariantNames`, `defaultVariantId`, `targetingRules`) is per-Environment (ADR-0027). The create
request seeds the DEFINITION plus an initial CONFIGURATION for `environmentId`.

### CreateFlagRequest

| Field                   | Required | Notes                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `appId`                 | yes      | —                                                                      |
| `environmentId`         | yes      | Environment the initial CONFIGURATION is written for (ADR-0027)        |
| `name`                  | yes      | — (DEFINITION)                                                         |
| `key`                   | yes      | Unique per App; immutable after create (DEFINITION)                    |
| `variants`              | yes      | `Variant[]`, min 1; the App-level Variant catalog (DEFINITION)         |
| `enabled`               | yes      | Per-Environment (CONFIGURATION)                                        |
| `availableVariantNames` | no       | Per-Environment subset of the catalog; defaults to all (CONFIGURATION) |
| `defaultVariantId`      | yes      | Must match one of `variants[].id` (CONFIGURATION)                      |
| `targetingRules`        | no       | Defaults to `[]` (CONFIGURATION)                                       |
| `description`           | no       | —                                                                      |

Worker computes: `id`, `createdAt`, `updatedAt`.

### PatchFlagRequest

Accepts only non-key, non-appId fields. `key` and `appId` are immutable (audit boundary).
CONFIGURATION fields (`enabled`, `availableVariantNames`, `defaultVariantId`) patch against the
Environment in the path (ADR-0027).

| Field                   | Required | Notes                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `name`                  | no       | DEFINITION                                                                     |
| `enabled`               | no       | per-Environment CONFIGURATION                                                  |
| `availableVariantNames` | no       | per-Environment CONFIGURATION                                                  |
| `defaultVariantId`      | no       | Must match existing `variants[].id` if supplied; per-Environment CONFIGURATION |
| `description`           | no       | —                                                                              |

Variants and TargetingRules are managed via sub-resource endpoints (`/variants`, `/targeting-rules`).

### FlagResponse

Returns the full Flag leaf. No storage internals (no `version`, no `createdBy`).

---

## Variant sub-resource endpoints

### CreateVariantRequest

| Field         | Required | Notes                                   |
| ------------- | -------- | --------------------------------------- |
| `flagId`      | yes      | —                                       |
| `name`        | yes      | —                                       |
| `value`       | yes      | `boolean \| string \| number \| object` |
| `description` | no       | —                                       |

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
