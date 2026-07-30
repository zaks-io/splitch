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
  | 'EVENT_SCHEMA_MISMATCH'       // Metric Event fields/Dimensions do not match accepting version
  | 'ENTITY_TYPE_MISMATCH'        // Metric Event or Metric/Run join uses incompatible Entity type

  // Run / Experiment invariants
  | 'RUN_FROZEN'                  // attempted assignment edit on a running Run
  | 'DECISION_LOCKED'             // attempted decision-family / alpha edit on a running Run
  | 'TARGETING_KEY_MISMATCH'      // targetingKey changed; a new Run is required
  | 'RUN_NOT_RUNNING'            // End (or other running-only op) called on a non-running Run
  | 'EXPERIMENT_RUNNING'         // operation (e.g. delete) blocked while the Experiment has a running Run
  | 'EXPERIMENT_NO_DRAFT'        // Start attempted when the draft has no changes from the current Run
  | 'VARIANT_NOT_AVAILABLE'      // a referenced Variant is not in the Flag's available set for this Environment (ADR-0028)
  | 'RESOURCE_NOT_EMPTY'         // destructive delete blocked because non-cascaded child resources remain
  | 'EVENT_DEFINITION_UNPUBLISHED'// Event Definition has no version available for ingest
  | 'EVENT_DEFINITION_IMMUTABLE' // attempted patch/delete of a published Event Definition Version
  | 'EVENT_ID_CONFLICT'          // caller reused Metric Event eventId with a different payload

  // Not found
  | 'EXPERIMENT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'FLAG_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'METRIC_NOT_FOUND'
  | 'EVENT_DEFINITION_NOT_FOUND'
  | 'EVENT_DEFINITION_VERSION_NOT_FOUND'
  | 'APP_NOT_FOUND'
  | 'ORGANIZATION_NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'SEGMENT_NOT_FOUND'
  | 'PRIVACY_JOB_NOT_FOUND'
  | 'APPROVAL_REQUEST_NOT_FOUND'

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
  | 'APPROVAL_REVIEW_REQUIRED'    // durable Approval Request is pending Review
  | 'APPROVAL_REVIEW_FORBIDDEN'   // principal may not perform this Review
  | 'APPROVAL_REQUEST_STALE'      // target version changed; request is terminal
  | 'APPROVAL_REQUEST_RESOLVED'   // a different Review already resolved the request
  | 'APPROVAL_APPLICATION_FAILED' // application rolled back; request remains pending
  | 'IDEMPOTENCY_KEY_CONFLICT'    // same key was reused with a different canonical payload

  // Analysis-state signals
  | 'MULTIPLE_VARIANT_CONFLICT'   // Entity bucketed to __multiple__; results untrusted

  // System
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'         // Provider config could not be resolved; retryable (503 + Retry-After).
                                 //   SDK maps this to OpenFeature errorCode PROVIDER_NOT_READY (ADR-0036)
  | 'PRIVACY_JOB_FAILED'
  | 'INTERNAL_SERVER_ERROR'       // includes corrupted KV blob (fail-loud per ADR-0025)
```

During the contracts-first transition, deprecated `CONFIRMATION_REQUIRED` remains emitted only by
the legacy `flag-config-policy` runtime path until SPL-150 replaces it with the Approval runtime and
removes the code, status mapping, and `REVIEW_APPROVAL_REQUEST` details token.

---

## Per-code detail shapes

| code                            | details shape                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`              | `{ issues: Array<{ path: string[], message: string }> }` — Zod `.format()` output                                                                                                                   |
| `ALLOCATION_INVALID`            | `{ expected: 100, got: number, variantAllocations: Record<string, number> }`                                                                                                                        |
| `ACTIVATION_TIMESTAMP_INVALID`  | `{ activationTs: string, firstExposureTs: string, message: 'activation must occur after first exposure' }`                                                                                          |
| `INVALID_PAGINATION`            | `{ field: 'cursor' \| 'limit', reason: string }`                                                                                                                                                    |
| `INVALID_SORT`                  | `{ field: string, allowedFields: string[] }`                                                                                                                                                        |
| `EVENT_SCHEMA_MISMATCH`         | `{ eventName: string, eventDefinitionVersionId: string, issues: Array<{ path: string[], message: string }> }` — paths identify unknown/missing/type-invalid fields, Dimensions, or nested JSON keys |
| `ENTITY_TYPE_MISMATCH`          | `{ expectedIdType: string, receivedIdType: string, eventDefinitionId: string, metricId?: string, runId?: string }`                                                                                  |
| `RUN_FROZEN`                    | `{ frozenFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                   |
| `DECISION_LOCKED`               | `{ lockedFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                   |
| `TARGETING_KEY_MISMATCH`        | `{ currentTargetingKey: string, attemptedTargetingKey: string, experimentId: string, recommendedAction: RecommendedAction }`                                                                        |
| `RUN_NOT_RUNNING`               | `{ runId: string, currentState: 'draft' \| 'ended', attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                    |
| `EXPERIMENT_RUNNING`            | `{ experimentId: string, runningRunId: string, attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                         |
| `EXPERIMENT_NO_DRAFT`           | `{ experimentId: string, currentRunId: string \| null, recommendedAction: RecommendedAction }`                                                                                                      |
| `VARIANT_NOT_AVAILABLE`         | `{ flagId: string, environmentId: string, missingVariants: string[], recommendedAction: RecommendedAction }`                                                                                        |
| `RESOURCE_NOT_EMPTY`            | `{ resourceType: 'app' \| 'environment', resourceId: string, childType: string, childCount: number, attemptedOp: string }`                                                                          |
| `EVENT_DEFINITION_UNPUBLISHED`  | `{ eventDefinitionId: string, eventName: string }`                                                                                                                                                  |
| `EVENT_DEFINITION_IMMUTABLE`    | `{ eventDefinitionId: string, eventDefinitionVersionId: string, attemptedOp: string }`                                                                                                              |
| `EVENT_ID_CONFLICT`             | `{ eventId: string }`                                                                                                                                                                               |
| `INSUFFICIENT_SCOPES`           | `{ requiredScopes: string[], heldScopes: string[] }`                                                                                                                                                |
| `LAST_OWNER_REQUIRED`           | `{ orgId: string }`                                                                                                                                                                                 |
| `LAST_ENVIRONMENT_REQUIRED`     | `{ appId: string }`                                                                                                                                                                                 |
| `PRIVACY_CONFIRMATION_REQUIRED` | `{ confirmationRequired: true, confirmationExpiresAt: string }`                                                                                                                                     |
| `APPROVAL_REVIEW_REQUIRED`      | `{ approvalRequestId: string, status: 'pending', policyContexts: ApprovalPolicyContext[], recommendedAction: 'REVIEW_APPROVAL_REQUEST' }`                                                           |
| `APPROVAL_REVIEW_FORBIDDEN`     | `{ approvalRequestId: string, action: ReviewAction, reason: 'SELF_REVIEW_NOT_ALLOWED' \| 'ROLE_NOT_ALLOWED' }`                                                                                      |
| `APPROVAL_REQUEST_STALE`        | `{ approvalRequestId: string, targetVersion: string, currentTargetVersion: string, recommendedAction: 'REFRESH_AND_REPROPOSE' }`                                                                    |
| `APPROVAL_REQUEST_RESOLVED`     | `{ approvalRequestId: string, status: 'applied' \| 'declined' \| 'stale', reviewId: string \| null }`                                                                                               |
| `APPROVAL_APPLICATION_FAILED`   | `{ approvalRequestId: string, reviewId: string, applicationError: { code: ErrorCode, details: object }, recommendedAction: 'RETRY_REVIEW' }`                                                        |
| `IDEMPOTENCY_KEY_CONFLICT`      | `{ scope: 'approval_request' \| 'review', idempotencyKey: string }`                                                                                                                                 |
| `PRIVACY_JOB_FAILED`            | `{ requestId: string, failedStores: string[] }`                                                                                                                                                     |
| `MULTIPLE_VARIANT_CONFLICT`     | `{ experimentId: string, runId: string, idType: string, targetingKeyHash: string }`                                                                                                                 |
| `RATE_LIMITED`                  | `{ retryAfterMs: number }`                                                                                                                                                                          |
| `SERVICE_UNAVAILABLE`           | `{ retryAfterMs: number }` — Provider unresolvable; mirrors the `Retry-After` response header                                                                                                       |
| `ORIGIN_NOT_ALLOWED`            | `{ origin: string, hint: string }` — names the offending origin + how to fix (add to allow-list / open key)                                                                                         |
| `APP_MISMATCH`                  | `{}`                                                                                                                                                                                                |
| All `*_NOT_FOUND` codes         | `{}`                                                                                                                                                                                                |
| `UNAUTHORIZED`                  | `{}`                                                                                                                                                                                                |
| `CREDENTIAL_REVOKED`            | `{}`                                                                                                                                                                                                |
| `FORBIDDEN`                     | `{}`                                                                                                                                                                                                |
| `INTERNAL_SERVER_ERROR`         | `{}`                                                                                                                                                                                                |

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
  | 'REVIEW_APPROVAL_REQUEST'// perform an authorized Review on the durable pending request
  | 'REFRESH_AND_REPROPOSE'  // target changed; read current state and create a new request
  | 'RETRY_REVIEW'           // application failed without mutation; retry with a new idempotency key
```

Per-code mapping (the action is deterministic per code, but lives in `details` so the agent reads
one field rather than maintaining a code→action table of its own):

| code                          | `recommendedAction`       | what the agent does                                                                 |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `RUN_FROZEN`                  | `CREATE_NEW_RUN`          | the edit touches a frozen field; open a new draft Run and apply it there (ADR-0003) |
| `DECISION_LOCKED`             | `CREATE_NEW_RUN`          | the decision-family / alpha edit is locked on the running Run; new Run required     |
| `TARGETING_KEY_MISMATCH`      | `CREATE_NEW_RUN`          | the targetingKey changed; a new Run is required to rebucket                         |
| `RUN_NOT_RUNNING`             | `START_A_RUN`             | End (or other running-only op) hit a non-running Run; Start a Run first             |
| `EXPERIMENT_RUNNING`          | `END_RUNNING_RUN_FIRST`   | the op (e.g. delete) is blocked while a Run is live; End it, then retry             |
| `EXPERIMENT_NO_DRAFT`         | `EDIT_DRAFT_THEN_START`   | Start found no draft changes vs the current Run; edit the draft, then Start         |
| `VARIANT_NOT_AVAILABLE`       | `ADD_VARIANT_TO_ENV`      | a referenced Variant is not in this Environment's available set; promote it         |
| `APPROVAL_REVIEW_REQUIRED`    | `REVIEW_APPROVAL_REQUEST` | perform an authorized Review on the returned durable request                        |
| `APPROVAL_REQUEST_STALE`      | `REFRESH_AND_REPROPOSE`   | read current state and create a new request; stale is terminal                      |
| `APPROVAL_APPLICATION_FAILED` | `RETRY_REVIEW`            | retry the pending request with a new Review idempotency key                         |

`recommendedAction` is **advisory recovery, not authorization**: following it does not bypass any
gate. A `CREATE_NEW_RUN` action still goes through the normal create-Run path with its own
validation and Environment Policy Review (ADR-0029). The field exists so an agent's
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

## Approval Request and Review errors

There is no stateless `confirm: true` retry handshake. Promotion, direct Flag Configuration edits,
Variant value edits, and Experiment Run Start use one durable Approval Request and Review contract.
The positive Review action is always `approve_and_apply`; `approve` is never a deferred state or a
second action.

Canonical wire projection:

```
ApprovalRequest = {
  id: `apr_${ULID}`
  appId: string
  policyContexts: Array<{
    environmentId: string
    changeTypes: PolicyChangeType[]
    level: 'allow' | 'confirm' | 'approve'
  }>
  operation:
    | 'flag_config_update'
    | 'flag_targeting_rules_replace'
    | 'flags_promote'
    | 'flag_variants_update'
    | 'experiments_start'
  target: {
    type: 'flag_configuration' | 'flag_variant' | 'experiment_draft'
    id: string
    version: `sha256:${lowercaseHex}`
  }
  diff: {
    current: Record<string, unknown>
    proposed: Record<string, unknown>
    entries: Array<{
      path: string
      operation: 'add' | 'remove' | 'replace'
      current?: unknown
      proposed?: unknown
    }>
  }
  status: 'pending' | 'applied' | 'declined' | 'stale'
  proposer: { userId: string, authDoor: string }
  proposedAt: string
  resolvedAt: string | null
  applicationResult: {
    targetVersion: `sha256:${lowercaseHex}`
    resourceType: 'flag_configuration' | 'flag_variant' | 'experiment_run'
    resourceId: string
    appliedAt: string
  } | null
  latestReview: Review | null
}

Review = {
  id: `rev_${ULID}`
  approvalRequestId: `apr_${ULID}`
  action: 'approve_and_apply' | 'decline'
  outcome: 'applied' | 'declined' | 'stale' | 'failed'
  actor: { userId: string, authDoor: string }
  reviewedAt: string
  reason: string | null
  idempotencyKey: string
  resultingTargetVersion: `sha256:${lowercaseHex}` | null
  error: { code: ErrorCode, details: Record<string, unknown> } | null
}
```

`PolicyChangeType` is
`'variant_availability' | 'targeting_rollout_value' | 'enabled_state' | 'start_experiment_run'`.

Approval Request IDs are `apr_` plus a 26-character ULID; Review IDs are `rev_` plus a
26-character ULID, matching the service's monotonic `ulid()` convention.

`diff.current` and `diff.proposed` are immutable canonical snapshots of the mutation's complete
target projection, excluding server-generated result fields such as IDs and timestamps. Entries are
strictly lexicographic by RFC 6901 JSON Pointer `path`: `add` requires only `proposed`, `remove` only
`current`, and `replace` both. The server computes entries from the snapshots; callers cannot submit
their own diff. `applicationResult` is non-null only for `status = applied`.

`target.version`, `applicationResult.targetVersion`, and `resultingTargetVersion` are lowercase
SHA-256 tokens over UTF-8 RFC 8785 JSON Canonicalization Scheme bytes. The same canonicalization
rule binds Approval Request and Review idempotency payloads. Application error codes use the
machine-stable `ErrorCode` set, never an open string.

Policy changes only the required Review authority:

- `allow`: no Review is required. The write enters the same validated application seam directly.
- `confirm`: the proposer may Review with `approve_and_apply`. The inline mutation field
  `review: { action: 'approve_and_apply' }` invokes that same action in one request.
- future `approve`: self-review returns `403 APPROVAL_REVIEW_FORBIDDEN`; an authorized distinct
  principal must invoke `approve_and_apply`.

Authentication and Review authorization failures happen before target validation or mutation. They
create no Review row and use the ordinary security audit path; the Approval Request remains
`pending`.

If a gated mutation omits the required inline Review, the server persists the immutable proposal and
returns `409 APPROVAL_REVIEW_REQUIRED` with its `approvalRequestId`. The caller submits:

```
POST /apps/{app_id}/approval-requests/{approval_request_id}/reviews
{
  action: 'approve_and_apply' | 'decline'
  reason?: string
  idempotency_key: string
}
```

`decline` is a terminal negative Review. V1 has no approve-only action, no approved-but-unapplied
state, and no deferred application job.

Multiple pending requests for one target are allowed and independent. A write that advances the
target version makes every sibling proposal for the old version effectively stale.

Single and list reads compute effective staleness against the live target without mutating D1. A
stored pending request can therefore render `status: stale` with `resolvedAt: null` and no stale
Review. V1 has no TTL. A later Review rechecks the target and materializes the stale Review and
terminal timestamp before returning `APPROVAL_REQUEST_STALE`.

Review authorization and target-version validation happen before mutation. A version mismatch
atomically records the stale attempt, moves `pending -> stale`, and returns
`APPROVAL_REQUEST_STALE`. Stale requests cannot be revived. A Review on any terminal request returns
`APPROVAL_REQUEST_RESOLVED` unless it is an exact idempotent replay of the Review that resolved it;
that replay returns the original result.

The opaque target version includes the relevant current Environment Policy projection as well as
the target resource versions. A Policy change after proposal therefore produces `stale`; it cannot
silently lower the authority required by the immutable proposal.

`approve_and_apply` commits the canonical D1 mutation, successful Review, resulting target version,
Approval Request `pending -> applied` transition, and bounded audit metadata in one transaction at
the target's owning persistence boundary. KV and Tinybird writes are post-commit projections and do
not redefine the canonical result.

If canonical application fails, the transaction rolls back with no target mutation. A separate
transaction records the failed Review with `applicationError.code` only if the Approval Request is
still `pending`; it never overwrites a concurrent terminal Review. The Approval Request remains
`pending`, and the caller receives `APPROVAL_APPLICATION_FAILED`. Replaying the same Review
idempotency key returns the same failed attempt. A new authorized attempt uses a new key and can
apply at most once.

Approval Request creation and Review each bind the idempotency key to a canonical request hash.
Exact retries return the stored result. Reusing a key for a different payload returns
`IDEMPOTENCY_KEY_CONFLICT`; it never creates or applies a second mutation.

The kill switch turning a Flag off is never gated. It uses the ordinary `allow` application path
regardless of Environment Policy.

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

**POST /api/sdk/peek** (data-plane diagnostic, API Key only — ADR-0034)

- `FLAG_NOT_FOUND` / `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `INSUFFICIENT_SCOPES` / `APP_MISMATCH` / `VALIDATION_ERROR` / `RATE_LIMITED` / `SERVICE_UNAVAILABLE`
  — Note: never fires an Exposure and never writes the Assignment Store. A valid Client Key is rejected with `INSUFFICIENT_SCOPES`; missing or invalid credentials are `UNAUTHORIZED`. A Default Variant fallback (`disabled`, no live Run, null Experiment, or no Targeting Rule match) is `VALIDATION_ERROR`, never `200 { variant: <default> }`.

**POST /api/sdk/verify** (data-plane setup confirmation, Client Key or API Key — ADR-0037)

- `APP_NOT_FOUND` / `FLAG_NOT_FOUND` / `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `APP_MISMATCH` / `ORIGIN_NOT_ALLOWED` / `RATE_LIMITED`
  — Note: never fires an Exposure. Returns `ResolutionDetails`; under a Client Key the `reason` is the non-revealing set (never names the rule), under an API Key it returns the full reason. Fail-loud like evaluate.

**POST /api/sdk/events** (data-plane Metric Event intake, Client Key or API Key)

- `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `ORIGIN_NOT_ALLOWED` / `RATE_LIMITED`
- `VALIDATION_ERROR` — malformed request or unknown strict top-level field, including Entity
  Profile/version selectors
- `EVENT_DEFINITION_NOT_FOUND` — unknown `eventName` within the credential's App
- `EVENT_DEFINITION_UNPUBLISHED` — definition exists but has no published version
- `EVENT_SCHEMA_MISMATCH` — unknown/missing/type-invalid field, Dimension, or nested JSON key
- `ENTITY_TYPE_MISMATCH` — request `idType` does not equal the accepting version's `entityType`
- `EVENT_ID_CONFLICT` — same App/Environment/`eventId` was already claimed by a different payload

Every failure is no-write. The route returns an error before claiming idempotency or appending
`metric_events`; an exact idempotent retry returns `202` with `duplicate: true`.

---

## HTTP status mapping

| code group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | HTTP status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `VALIDATION_ERROR`, `ALLOCATION_INVALID`, `ACTIVATION_TIMESTAMP_INVALID`, `INVALID_*`, `EVENT_SCHEMA_MISMATCH`, `ENTITY_TYPE_MISMATCH`                                                                                                                                                                                                                                                                                                                                                                                      | 400         |
| `UNAUTHORIZED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 401         |
| `CREDENTIAL_REVOKED`, `FORBIDDEN`, `INSUFFICIENT_SCOPES`, `ORIGIN_NOT_ALLOWED`, `APP_MISMATCH`, `APPROVAL_REVIEW_FORBIDDEN`                                                                                                                                                                                                                                                                                                                                                                                                 | 403         |
| `*_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 404         |
| `RUN_FROZEN`, `DECISION_LOCKED`, `TARGETING_KEY_MISMATCH`, `RUN_NOT_RUNNING`, `EXPERIMENT_RUNNING`, `EXPERIMENT_NO_DRAFT`, `VARIANT_NOT_AVAILABLE`, `RESOURCE_NOT_EMPTY`, `MULTIPLE_VARIANT_CONFLICT`, `LAST_OWNER_REQUIRED`, `LAST_ENVIRONMENT_REQUIRED`, `PRIVACY_CONFIRMATION_REQUIRED`, `APPROVAL_REVIEW_REQUIRED`, `APPROVAL_REQUEST_STALE`, `APPROVAL_REQUEST_RESOLVED`, `APPROVAL_APPLICATION_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`, `EVENT_DEFINITION_UNPUBLISHED`, `EVENT_DEFINITION_IMMUTABLE`, `EVENT_ID_CONFLICT` | 409         |
| `RATE_LIMITED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 429         |
| `PRIVACY_JOB_FAILED`, `INTERNAL_SERVER_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 500         |
| `SERVICE_UNAVAILABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 503         |

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
