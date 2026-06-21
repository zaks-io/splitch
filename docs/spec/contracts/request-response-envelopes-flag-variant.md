# Request/response envelopes: Flag and Variant endpoints

Wire shapes for Flag and Variant control-plane endpoints: create/patch asymmetry and the Variant
sub-resource Run-frozen guard.

Envelopes compose leaf schemas from [leaf-schemas-flag.md](./leaf-schemas-flag.md). They are **distinct**
— never fused — because create and patch have different required fields. Shared conventions live in
[request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Flag endpoints

### CreateFlagRequest

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | — |
| `name` | yes | — |
| `key` | yes | Unique per App; immutable after create |
| `enabled` | yes | — |
| `defaultVariantId` | yes | Must match one of `variants[].id` |
| `variants` | yes | `Variant[]`, min 1 |
| `targetingRules` | no | Defaults to `[]` |
| `description` | no | — |

Worker computes: `id`, `createdAt`, `updatedAt`.

### PatchFlagRequest

Accepts only non-key, non-appId fields. `key` and `appId` are immutable (audit boundary).

| Field | Required | Notes |
|---|---|---|
| `name` | no | — |
| `enabled` | no | — |
| `defaultVariantId` | no | Must match existing `variants[].id` if supplied |
| `description` | no | — |

Variants and TargetingRules are managed via sub-resource endpoints (`/variants`, `/targeting-rules`).

### FlagResponse

Returns the full Flag leaf. No storage internals (no `version`, no `createdBy`).

---

## Variant sub-resource endpoints

### CreateVariantRequest

| Field | Required | Notes |
|---|---|---|
| `flagId` | yes | — |
| `name` | yes | — |
| `value` | yes | `boolean \| string \| number \| object` |
| `description` | no | — |

### PatchVariantRequest

| Field | Required | Notes |
|---|---|---|
| `name` | no | — |
| `value` | no | **Worker rejects if any running Run's `variantSet` includes this Variant** → `RUN_FROZEN` error |
| `description` | no | — |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
