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
