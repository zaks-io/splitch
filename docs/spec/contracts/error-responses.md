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
  | 'RUN_NOT_RUNNING'            // End (or other running-only op) called on a non-running Run
  | 'EXPERIMENT_RUNNING'         // operation (e.g. delete) blocked while the Experiment has a running Run
  | 'EXPERIMENT_NO_DRAFT'        // Start attempted when the draft has no changes from the current Run
  | 'VARIANT_NOT_AVAILABLE'      // a referenced Variant is not in the Flag's available set for this Environment (ADR-0028)

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
  | 'LAST_ENVIRONMENT_REQUIRED'   // deletion would leave an App without an Environment
  | 'PRIVACY_CONFIRMATION_REQUIRED' // destructive privacy job lacks confirmation
  | 'CONFIRMATION_REQUIRED'       // Environment Policy gates this change type; resend with confirm: true (ADR-0029)

  // Analysis-state signals
  | 'MULTIPLE_VARIANT_CONFLICT'   // Entity bucketed to __multiple__; results untrusted

  // System
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'         // Provider config could not be resolved; retryable (503 + Retry-After).
                                 //   SDK maps this to OpenFeature errorCode PROVIDER_NOT_READY (ADR-0036)
  | 'PRIVACY_JOB_FAILED'
  | 'INTERNAL_SERVER_ERROR'       // includes corrupted KV blob (fail-loud per ADR-0025)
```

---

## Per-code detail shapes

| code                            | details shape                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`              | `{ issues: Array<{ path: string[], message: string }> }` — Zod `.format()` output                                                                                                                                                                         |
| `ALLOCATION_INVALID`            | `{ expected: 100, got: number, variantAllocations: Record<string, number> }`                                                                                                                                                                              |
| `ACTIVATION_TIMESTAMP_INVALID`  | `{ activationTs: string, firstExposureTs: string, message: 'activation must occur after first exposure' }`                                                                                                                                                |
| `INVALID_PAGINATION`            | `{ field: 'cursor' \| 'limit', reason: string }`                                                                                                                                                                                                          |
| `INVALID_SORT`                  | `{ field: string, allowedFields: string[] }`                                                                                                                                                                                                              |
| `RUN_FROZEN`                    | `{ frozenFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                                                                         |
| `DECISION_LOCKED`               | `{ lockedFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                                                                         |
| `TARGETING_KEY_MISMATCH`        | `{ currentTargetingKey: string, attemptedTargetingKey: string, experimentId: string, recommendedAction: RecommendedAction }`                                                                                                                              |
| `RUN_NOT_RUNNING`               | `{ runId: string, currentState: 'draft' \| 'ended', attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                                                                          |
| `EXPERIMENT_RUNNING`            | `{ experimentId: string, runningRunId: string, attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                                                                               |
| `EXPERIMENT_NO_DRAFT`           | `{ experimentId: string, currentRunId: string \| null, recommendedAction: RecommendedAction }`                                                                                                                                                            |
| `VARIANT_NOT_AVAILABLE`         | `{ flagId: string, environmentId: string, missingVariants: string[], recommendedAction: RecommendedAction }`                                                                                                                                              |
| `INSUFFICIENT_SCOPES`           | `{ requiredScopes: string[], heldScopes: string[] }`                                                                                                                                                                                                      |
| `LAST_OWNER_REQUIRED`           | `{ orgId: string }`                                                                                                                                                                                                                                       |
| `LAST_ENVIRONMENT_REQUIRED`     | `{ appId: string }`                                                                                                                                                                                                                                       |
| `PRIVACY_CONFIRMATION_REQUIRED` | `{ confirmationRequired: true, confirmationExpiresAt: string }`                                                                                                                                                                                           |
| `CONFIRMATION_REQUIRED`         | `{ gate: PolicyChangeType, environmentId: string, attemptedOp: string, recommendedAction: 'RETRY_WITH_CONFIRMATION' }` — `gate` names the Environment-Policy change type that requires confirmation (ADR-0029); resend the same call with `confirm: true` |
| `PRIVACY_JOB_FAILED`            | `{ requestId: string, failedStores: string[] }`                                                                                                                                                                                                           |
| `MULTIPLE_VARIANT_CONFLICT`     | `{ experimentId: string, runId: string, idType: string, targetingKeyHash: string }`                                                                                                                                                                       |
| `RATE_LIMITED`                  | `{ retryAfterMs: number }`                                                                                                                                                                                                                                |
| `SERVICE_UNAVAILABLE`           | `{ retryAfterMs: number }` — Provider unresolvable; mirrors the `Retry-After` response header                                                                                                                                                             |
| `ORIGIN_NOT_ALLOWED`            | `{ origin: string, hint: string }` — names the offending origin + how to fix (add to allow-list / open key)                                                                                                                                               |
| `APP_MISMATCH`                  | `{}`                                                                                                                                                                                                                                                      |
| All `*_NOT_FOUND` codes         | `{}`                                                                                                                                                                                                                                                      |
| `UNAUTHORIZED`                  | `{}`                                                                                                                                                                                                                                                      |
| `CREDENTIAL_REVOKED`            | `{}`                                                                                                                                                                                                                                                      |
| `FORBIDDEN`                     | `{}`                                                                                                                                                                                                                                                      |
| `INTERNAL_SERVER_ERROR`         | `{}`                                                                                                                                                                                                                                                      |

---

## RecommendedAction: machine-stable recovery guidance

Operational `409` errors carry a `recommendedAction` — a stable enum token naming the **next
step** that resolves the conflict. An agent branches on the token (never on prose); the
human-readable `message` still carries the same remedy for a person reading a CLI error. The
token is part of the contract: it is stable across `message` wording changes and localization.

```
RecommendedAction =
  | 'CREATE_NEW_RUN'         // the change is frozen on the running Run; clone into a new draft Run and apply it there
  | 'END_RUNNING_RUN_FIRST'  // a running Run blocks this op; End it, then retry
  | 'START_A_RUN'            // the op needs a running Run; Start one first
  | 'EDIT_DRAFT_THEN_START'  // make a change to the draft, then Start (the draft currently matches the live Run)
  | 'ADD_VARIANT_TO_ENV'     // a referenced Variant is not promoted to this Environment; promote it (ADR-0028), then retry
  | 'RETRY_AFTER'            // transient; retry after the window in retryAfterMs / Retry-After
  | 'RETRY_WITH_CONFIRMATION'// the Environment Policy gates this change type; resend the same call with confirm: true (ADR-0029)
```

Per-code mapping (the action is deterministic per code, but lives in `details` so the agent reads
one field rather than maintaining a code→action table of its own):

| code                     | `recommendedAction`       | what the agent does                                                                                 |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `RUN_FROZEN`             | `CREATE_NEW_RUN`          | the edit touches a frozen field; open a new draft Run and apply it there (ADR-0003)                 |
| `DECISION_LOCKED`        | `CREATE_NEW_RUN`          | the decision-family / alpha edit is locked on the running Run; new Run required                     |
| `TARGETING_KEY_MISMATCH` | `CREATE_NEW_RUN`          | the targetingKey changed; a new Run is required to rebucket                                         |
| `RUN_NOT_RUNNING`        | `START_A_RUN`             | End (or other running-only op) hit a non-running Run; Start a Run first                             |
| `EXPERIMENT_RUNNING`     | `END_RUNNING_RUN_FIRST`   | the op (e.g. delete) is blocked while a Run is live; End it, then retry                             |
| `EXPERIMENT_NO_DRAFT`    | `EDIT_DRAFT_THEN_START`   | Start found no draft changes vs the current Run; edit the draft, then Start                         |
| `VARIANT_NOT_AVAILABLE`  | `ADD_VARIANT_TO_ENV`      | a referenced Variant is not in this Environment's available set; promote it                         |
| `CONFIRMATION_REQUIRED`  | `RETRY_WITH_CONFIRMATION` | the Environment Policy gates this change type; resend the same call with `confirm: true` (ADR-0029) |

`recommendedAction` is **advisory recovery, not authorization**: following it does not bypass any
gate. A `CREATE_NEW_RUN` action still goes through the normal create-Run path with its own
validation and Environment Policy confirmation (ADR-0029). The field exists so an agent's
error-recovery branch is a stable token lookup, not prose parsing — the same fail-loud-then-guide
principle the error contract is built on (ADR-0036).

---

## RUN_FROZEN detail: frozen field list

The `frozenFields` array names exactly which fields are immutable on a running Run.
An agent reads this to know what it cannot change without a new Run:

```
frozenFields = [
  'salt', 'allocation', 'variantSet', 'targetingRules', 'targetingSegmentId',
  'experiment.targetingKey', // lives on Experiment; changing it triggers RUN_FROZEN with a running Run
  'activationMetricId',      // Activation Metric is an assignment edit
]
```

---

## CONFIRMATION_REQUIRED: the Environment-Policy confirmation handshake

When an Environment Policy gates a change type at `confirm` (ADR-0029), the gated write
(`experiments_start`, `flag_config_update`, `flags_promote`, enabled-state toggle) is rejected with
`409 CONFIRMATION_REQUIRED` **unless the request carries `confirm: true`**. This is the one
confirmation contract for every skin:

- **Input.** Every gated write schema includes an optional `confirm?: boolean` field (default
  `false`). The CLI `--confirm` flag sets it; the MCP tool exposes it as a derived input field; the
  panel's Confirmation modal sets it on submit. No separate ceremony, no extra round-trip endpoint.
- **`gate`.** `details.gate` is a `PolicyChangeType` so the agent/human knows _which_ change type
  tripped the gate without re-reading the Policy:

  ```
  PolicyChangeType =
    | 'variant_availability'   // promote a Variant into this Environment's available set
    | 'targeting_rollout_value'// change what is served and to whom
    | 'enabled_state'          // the kill switch
    | 'start_experiment_run'   // open a Run for measurement in this Environment
  ```

- **Recovery.** `recommendedAction: 'RETRY_WITH_CONFIRMATION'` — resend the identical call with
  `confirm: true`. An agent that knows the token needs no prompt; the recovery is deterministic. The
  kill switch (turning a flag **off**) is never gated (ADR-0029) and so never returns this code.
- **Reading the gate ahead of time.** `environments_get` returns the Environment Policy inline so a
  caller can decide to send `confirm: true` on the first attempt instead of round-tripping through the 409. (There is no separate policy endpoint; the CLI `env-policy get` projects the same field.)

`confirm: true` satisfies the gate; it does not widen authorization. A confirmed change still
passes full Worker validation and is recorded as a self-reviewed Approval Request (ADR-0029).

---

## ResolutionDetails: the SDK-synthesized evaluate/verify result

The data-plane wire response is intentionally minimal — `DataPlaneEvaluateResponse = { variant }`
(see [request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md)). The
SDK **synthesizes** the OpenFeature `ResolutionDetails` the caller receives from that wire response
plus the HTTP status. This is the shape every accessor (`evaluate`, `evaluateDetails`, `peekVariant`,
`verify`) returns, defined once in
[leaf-schemas-runtime.md](./leaf-schemas-runtime.md#resolutiondetails-openfeature-sdk-return-shape):

```
ResolutionDetails = {
  value:        VariantValue        // the resolved Variant value (Default Variant on a failure-fallback)
  variantName:  string | null       // null when no Variant resolved (error/default)
  reason:       ResolutionReason     // SPLIT | DEFAULT | DISABLED | CACHED | STALE | ERROR
  errorCode?:   ErrorCode            // present iff reason === 'ERROR'; the same ErrorCode enum above
  errorMessage?: string             // human-readable; present iff reason === 'ERROR'
}
```

Under a Client Key the `reason` is the non-revealing set and never names the matched rule (ADR-0018);
under an API Key `verify` returns the full reason (ADR-0037). The mapping from HTTP status to
`reason`/`errorCode` — the contract that makes fail-loud _usable_ by the SDK — is in
[../sdk/public-evaluate-endpoint.md](../sdk/public-evaluate-endpoint.md#http-status-to-resolutiondetails-mapping).

---

## Per-endpoint error contracts (representative)

**POST /api/apps/:appId/envs/:environmentId/experiments/:id/start** (open a new Experiment Run)

- `ALLOCATION_INVALID` — percentages don't sum to 100
- `VALIDATION_ERROR` — malformed request body
- `EXPERIMENT_NOT_FOUND` — `experimentId` not found in App/Environment
- `RUN_FROZEN` — Experiment already has a running Run (must end it before opening a new one via Start)

**PATCH /api/apps/:appId/envs/:environmentId/experiments/:id/runs/:runId** (non-material patch only)

- `RUN_FROZEN` — if request body includes any frozen field (`salt`, `allocation`, `variantSet`, `targetingRules`, `targetingSegmentId`)
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

| code group                                                                                                                                                                                                                                                                                    | HTTP status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `VALIDATION_ERROR`, `ALLOCATION_INVALID`, `ACTIVATION_TIMESTAMP_INVALID`, `INVALID_*`                                                                                                                                                                                                         | 400         |
| `UNAUTHORIZED`                                                                                                                                                                                                                                                                                | 401         |
| `CREDENTIAL_REVOKED`, `FORBIDDEN`, `INSUFFICIENT_SCOPES`, `ORIGIN_NOT_ALLOWED`, `APP_MISMATCH`                                                                                                                                                                                                | 403         |
| `*_NOT_FOUND`                                                                                                                                                                                                                                                                                 | 404         |
| `RUN_FROZEN`, `DECISION_LOCKED`, `TARGETING_KEY_MISMATCH`, `RUN_NOT_RUNNING`, `EXPERIMENT_RUNNING`, `EXPERIMENT_NO_DRAFT`, `VARIANT_NOT_AVAILABLE`, `MULTIPLE_VARIANT_CONFLICT`, `LAST_OWNER_REQUIRED`, `LAST_ENVIRONMENT_REQUIRED`, `PRIVACY_CONFIRMATION_REQUIRED`, `CONFIRMATION_REQUIRED` | 409         |
| `RATE_LIMITED`                                                                                                                                                                                                                                                                                | 429         |
| `PRIVACY_JOB_FAILED`, `INTERNAL_SERVER_ERROR`                                                                                                                                                                                                                                                 | 500         |
| `SERVICE_UNAVAILABLE`                                                                                                                                                                                                                                                                         | 503         |

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
