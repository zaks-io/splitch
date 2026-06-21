# Error response contract: canonical shape, code enum, and per-error details

One base shape + discriminated union on `code`. Zod parse failures and domain-invariant failures
use the same shape. Every surface (Worker, `hc` client, CLI, MCP tool) parses one schema.

---

## Base shape

```
ErrorResponse = {
  code:    ErrorCode          // discriminator
  message: string            // human-readable; may be localized later
  details: <narrowed by code> // always present; empty object {} for codes with no structured detail
}
```

Implemented as a Zod `.discriminatedUnion('code', [...])` so TypeScript narrows `details` from `code`
without a type cast. Every code must define its detail shape, even if that shape is `{}`.
The error contract is typed by `code`.

---

## ErrorCode enum

```
ErrorCode =
  // Validation
  | 'VALIDATION_ERROR'            // Zod parse failure at the Worker boundary
  | 'ALLOCATION_INVALID'          // Run allocation percentages do not sum to 100
  | 'ACTIVATION_TIMESTAMP_INVALID'// activation_ts <= first_exposure_ts
  | 'INVALID_PAGINATION'          // bad cursor or limit
  | 'INVALID_SORT'                // unrecognized sort field

  // Run / Experiment invariants
  | 'RUN_FROZEN'                  // attempted assignment edit on a running Run
  | 'DECISION_LOCKED'             // attempted decision-family / alpha edit on a running Run
  | 'TARGETING_KEY_MISMATCH'      // targetingKey changed; a new Run is required

  // Not found
  | 'EXPERIMENT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'FLAG_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'METRIC_NOT_FOUND'
  | 'APP_NOT_FOUND'
  | 'ORGANIZATION_NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'SEGMENT_NOT_FOUND'
  | 'PRIVACY_JOB_NOT_FOUND'

  // Auth / authz
  | 'UNAUTHORIZED'                // no valid credential
  | 'CREDENTIAL_REVOKED'          // presented credential is revoked
  | 'INSUFFICIENT_SCOPES'         // credential valid but lacks required scopes
  | 'FORBIDDEN'                   // authenticated but not authorized for the resource
  | 'ORIGIN_NOT_ALLOWED'         // valid Client Key, request origin not on the key's allow-list (ADR-0034)
  | 'APP_MISMATCH'               // Client Key does not belong to the requested appId (ADR-0018)
  | 'LAST_OWNER_REQUIRED'         // deletion would leave a shared Org without an owner
  | 'PRIVACY_CONFIRMATION_REQUIRED' // destructive privacy job lacks confirmation

  // Analysis-state signals
  | 'MULTIPLE_VARIANT_CONFLICT'   // Entity bucketed to __multiple__; results untrusted

  // System
  | 'RATE_LIMITED'
  | 'PRIVACY_JOB_FAILED'
  | 'INTERNAL_SERVER_ERROR'       // includes corrupted KV blob (fail-loud per ADR-0025)
```

---

## Per-code detail shapes

| code                            | details shape                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`              | `{ issues: Array<{ path: string[], message: string }> }` — Zod `.format()` output                           |
| `ALLOCATION_INVALID`            | `{ expected: 100, got: number, variantAllocations: Record<string, number> }`                                |
| `ACTIVATION_TIMESTAMP_INVALID`  | `{ activationTs: string, firstExposureTs: string, message: 'activation must occur after first exposure' }`  |
| `INVALID_PAGINATION`            | `{ field: 'cursor' \| 'limit', reason: string }`                                                            |
| `INVALID_SORT`                  | `{ field: string, allowedFields: string[] }`                                                                |
| `RUN_FROZEN`                    | `{ frozenFields: string[], currentRunId: string, attemptedChange: string }`                                 |
| `DECISION_LOCKED`               | `{ lockedFields: string[], currentRunId: string, attemptedChange: string }`                                 |
| `TARGETING_KEY_MISMATCH`        | `{ currentTargetingKey: string, attemptedTargetingKey: string, experimentId: string }`                      |
| `INSUFFICIENT_SCOPES`           | `{ requiredScopes: string[], heldScopes: string[] }`                                                        |
| `LAST_OWNER_REQUIRED`           | `{ orgId: string }`                                                                                         |
| `PRIVACY_CONFIRMATION_REQUIRED` | `{ confirmationRequired: true, confirmationExpiresAt: string }`                                             |
| `PRIVACY_JOB_FAILED`            | `{ requestId: string, failedStores: string[] }`                                                             |
| `MULTIPLE_VARIANT_CONFLICT`     | `{ experimentId: string, runId: string, idType: string, targetingKeyHash: string }`                         |
| `RATE_LIMITED`                  | `{ retryAfterMs: number }`                                                                                  |
| `ORIGIN_NOT_ALLOWED`            | `{ origin: string, hint: string }` — names the offending origin + how to fix (add to allow-list / open key) |
| `APP_MISMATCH`                  | `{}`                                                                                                        |
| All `*_NOT_FOUND` codes         | `{}`                                                                                                        |
| `UNAUTHORIZED`                  | `{}`                                                                                                        |
| `CREDENTIAL_REVOKED`            | `{}`                                                                                                        |
| `FORBIDDEN`                     | `{}`                                                                                                        |
| `INTERNAL_SERVER_ERROR`         | `{}`                                                                                                        |

---

## RUN_FROZEN detail: frozen field list

The `frozenFields` array names exactly which fields are immutable on a running Run.
An agent reads this to know what it cannot change without a new Run:

```
frozenFields = [
  'salt', 'allocation', 'variantSet', 'targetingSegmentId',
  'experiment.targetingKey', // lives on Experiment; changing it triggers RUN_FROZEN with a running Run
  'activationMetricId',      // Activation Metric is an assignment edit
]
```

---

## Per-endpoint error contracts (representative)

**POST /api/apps/:appId/envs/:environmentId/experiments/:id/start** (open a new Experiment Run)

- `ALLOCATION_INVALID` — percentages don't sum to 100
- `VALIDATION_ERROR` — malformed request body
- `EXPERIMENT_NOT_FOUND` — `experimentId` not found in App/Environment
- `RUN_FROZEN` — Experiment already has a running Run (must end it before opening a new one via Start)

**PATCH /api/apps/:appId/envs/:environmentId/experiments/:id/runs/:runId** (non-material patch only)

- `RUN_FROZEN` — if request body includes any frozen field (`salt`, `allocation`, `variantSet`, `targetingSegmentId`)
- `RUN_NOT_FOUND`
- `VALIDATION_ERROR`

**PATCH /api/apps/:appId/envs/:environmentId/experiments/:experimentId** (pause / resume / measurement edits)

- `EXPERIMENT_NOT_FOUND`
- `RUN_FROZEN` — if patch includes `targetingKey` and there is a running Run
- `DECISION_LOCKED` — if patch changes confidence level, horizon/tuning fields, goal Metric membership, Guardrail thresholds, or Primary Dimensions for a running Run's decision-valid result
- `ACTIVATION_TIMESTAMP_INVALID` — if `activationMetricId` changed and there are prior Exposures with invalid ordering
- `VALIDATION_ERROR`

**PATCH /api/metrics/:metricId** (measurement edit, no new Run)

- `METRIC_NOT_FOUND`
- `VALIDATION_ERROR`
  — Note: Metric patches never return `RUN_FROZEN`; they recompute over the existing Run (ADR-0003).

**PATCH /api/flags/:flagId/variants/:variantId**

- `RUN_FROZEN` — if any running Run's `variantSet` includes this Variant (value is frozen per Run)
- `FLAG_NOT_FOUND` / `VARIANT_NOT_FOUND`
- `VALIDATION_ERROR`

**POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval** (dry-run, control-plane token)

- `FLAG_NOT_FOUND`
- `VALIDATION_ERROR`
  — Note: never returns Exposure-related errors; never writes.

**POST /api/sdk/evaluate** (data-plane, Client Key)

- `APP_NOT_FOUND` / `FLAG_NOT_FOUND` / `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `APP_MISMATCH` / `ORIGIN_NOT_ALLOWED` / `RATE_LIMITED`
  — Note: no `RUN_FROZEN`, no `INSUFFICIENT_SCOPES` (Client Key holds only `evaluate`, enforced structurally). Response is the OpenFeature `ResolutionDetails` shape (`value`, `variantName`, `reason`, `errorCode?`, `errorMessage?`) — the `reason` is the **non-revealing** set under a Client Key and never names the matched rule (ADR-0018, ADR-0036). A failure-fallback carries `reason: ERROR` + `errorCode`, never silent.

**POST /api/sdk/verify** (data-plane setup confirmation, Client Key or API Key — ADR-0037)

- `APP_NOT_FOUND` / `FLAG_NOT_FOUND` / `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `APP_MISMATCH` / `ORIGIN_NOT_ALLOWED` / `RATE_LIMITED`
  — Note: never fires an Exposure. Returns `ResolutionDetails`; under a Client Key the `reason` is the non-revealing set (never names the rule), under an API Key it returns the full reason. Fail-loud like evaluate.

---

## HTTP status mapping

| code group                                                                                                                                     | HTTP status |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `VALIDATION_ERROR`, `ALLOCATION_INVALID`, `ACTIVATION_TIMESTAMP_INVALID`, `INVALID_*`                                                          | 400         |
| `UNAUTHORIZED`                                                                                                                                 | 401         |
| `CREDENTIAL_REVOKED`, `FORBIDDEN`, `INSUFFICIENT_SCOPES`, `ORIGIN_NOT_ALLOWED`, `APP_MISMATCH`                                                 | 403         |
| `*_NOT_FOUND`                                                                                                                                  | 404         |
| `RUN_FROZEN`, `DECISION_LOCKED`, `TARGETING_KEY_MISMATCH`, `MULTIPLE_VARIANT_CONFLICT`, `LAST_OWNER_REQUIRED`, `PRIVACY_CONFIRMATION_REQUIRED` | 409         |
| `RATE_LIMITED`                                                                                                                                 | 429         |
| `PRIVACY_JOB_FAILED`, `INTERNAL_SERVER_ERROR`                                                                                                  | 500         |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [../../adr/0037-client-side-configuration-verification-tiered-by-credential.md](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
