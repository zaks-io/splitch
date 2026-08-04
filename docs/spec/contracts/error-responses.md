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
  | 'INVALID_PAGINATION'          // bad cursor or limit
  | 'INVALID_SORT'                // unrecognized sort field
  | 'EVENT_SCHEMA_MISMATCH'       // Metric Event fields/Dimensions do not match accepting version
  | 'ENTITY_TYPE_MISMATCH'        // Metric Event or Metric/Run join uses incompatible Entity type

  // Run / Experiment invariants
  | 'RUN_FROZEN'                  // attempted edit of a field a running Run freezes (assignment, Flag Configuration, or Variant)
  | 'DECISION_LOCKED'             // attempted decision-family / alpha edit on a running Run
  | 'TARGETING_KEY_MISMATCH'      // targetingKey changed; a new Run is required
  | 'RUN_NOT_RUNNING'            // End (or other running-only op) called on a non-running Run
  | 'EXPERIMENT_RUNNING'         // operation (e.g. delete) blocked while the Experiment has a running Run
  | 'EXPERIMENT_NO_DRAFT'        // Start attempted when the draft has no changes from the current Run
  | 'VARIANT_NOT_AVAILABLE'      // a referenced Variant is not in the Flag's available set for this Environment (ADR-0028)
  | 'RESOURCE_NOT_EMPTY'         // destructive delete blocked because non-cascaded child resources remain
  | 'EXPERIMENT_KEY_CONFLICT'    // Experiment key still held by an archived Experiment in this Environment
  | 'EVENT_DEFINITION_UNPUBLISHED'// Event Definition has no version available for ingest
  | 'EVENT_DEFINITION_IMMUTABLE' // attempted patch/delete of a published Event Definition Version
  | 'EVENT_ID_CONFLICT'          // caller reused a Metric or Web Event eventId with different content

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
  | 'WEB_SESSION_NOT_FOUND'
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
  | 'ATTENTION_FANOUT_LIMIT_EXCEEDED' // Attention rollup spans too many Environments or running Experiments to read whole
  | 'WEB_ANALYTICS_WINDOW_UNAVAILABLE' // requested Web Analytics time has expired from retention

  // System
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'         // Provider config could not be resolved; retryable (503 + Retry-After).
                                 //   SDK maps this to OpenFeature errorCode PROVIDER_NOT_READY (ADR-0036)
  | 'PRIVACY_JOB_FAILED'
  | 'INTERNAL_SERVER_ERROR'       // includes corrupted KV blob (fail-loud per ADR-0025)
```

A mutation whose Environment Policy level is `allow` applies directly and creates
no Approval Request. A mutation gated at `confirm` creates a durable Approval
Request and returns `APPROVAL_REVIEW_REQUIRED` only when the caller sent no
inline `review`; a caller that sent `review: { action: 'approve_and_apply' }`
applies in the same call. The former `CONFIRMATION_REQUIRED` code is not part of
the contract.

---

## Per-code detail shapes

| code                               | details shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                 | `{ issues: Array<{ path: string[], message: string }> }` — Zod `.format()` output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ALLOCATION_INVALID`               | `{ expected: 100, got: number, variantAllocations: Record<string, number> }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `INVALID_PAGINATION`               | `{ field: 'cursor' \| 'limit', reason: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `INVALID_SORT`                     | `{ field: string, allowedFields: string[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EVENT_SCHEMA_MISMATCH`            | `{ eventName: string, eventDefinitionVersionId: string, issues: Array<{ path: string[], message: string }> }` — paths identify unknown, missing, type-invalid, allowlist-invalid, or range-invalid fields, Dimensions, or nested JSON keys                                                                                                                                                                                                                                                                                                                                            |
| `ENTITY_TYPE_MISMATCH`             | `{ expectedIdType: string \| null, receivedIdType: string, eventDefinitionId: string, metricId?: string, runId?: string }` — null means the accepting `web` definition prohibits Entity identity                                                                                                                                                                                                                                                                                                                                                                                      |
| `RUN_FROZEN`                       | `{ frozenFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DECISION_LOCKED`                  | `{ lockedFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TARGETING_KEY_MISMATCH`           | `{ currentTargetingKey: string, attemptedTargetingKey: string, experimentId: string, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RUN_NOT_RUNNING`                  | `{ runId: string, currentState: 'draft' \| 'ended', attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EXPERIMENT_RUNNING`               | `{ experimentId: string, runningRunId: string, attemptedOp: string, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EXPERIMENT_NO_DRAFT`              | `{ experimentId: string, currentRunId: string \| null, recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `VARIANT_NOT_AVAILABLE`            | `{ flagId: string, environmentId: string, missingVariants: string[], recommendedAction: RecommendedAction }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RESOURCE_NOT_EMPTY`               | `{ resourceType: 'app' \| 'environment', resourceId: string, childType: string, childCount: number, attemptedOp: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EXPERIMENT_KEY_CONFLICT`          | `{ key: string, archivedExperimentId: string, recommendedAction: 'CHOOSE_DIFFERENT_KEY' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EVENT_DEFINITION_UNPUBLISHED`     | `{ eventDefinitionId: string, eventName: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `EVENT_DEFINITION_IMMUTABLE`       | `{ eventDefinitionId: string, eventDefinitionVersionId: string, attemptedOp: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EVENT_ID_CONFLICT`                | `{ eventId: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `INSUFFICIENT_SCOPES`              | `{ requiredScopes: string[], heldScopes: string[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LAST_OWNER_REQUIRED`              | `{ orgId: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LAST_ENVIRONMENT_REQUIRED`        | `{ appId: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PRIVACY_CONFIRMATION_REQUIRED`    | `{ confirmationRequired: true, confirmationExpiresAt: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `APPROVAL_REVIEW_REQUIRED`         | `{ approvalRequestId: string, status: 'pending', policyContexts: ApprovalPolicyContext[], recommendedAction: 'REVIEW_APPROVAL_REQUEST' }`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `APPROVAL_REVIEW_FORBIDDEN`        | `{ approvalRequestId: string, action: ReviewAction, reason: 'SELF_REVIEW_NOT_ALLOWED' \| 'ROLE_NOT_ALLOWED' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `APPROVAL_REQUEST_STALE`           | `{ approvalRequestId: string, targetVersion: string, currentTargetVersion: string, recommendedAction: 'REFRESH_AND_REPROPOSE' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `APPROVAL_REQUEST_RESOLVED`        | `{ approvalRequestId: string, status: 'applied' \| 'declined' \| 'stale', reviewId: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `APPROVAL_APPLICATION_FAILED`      | `{ approvalRequestId: string, reviewId: string, applicationError: { code: ErrorCode, details: object }, recommendedAction: 'RETRY_REVIEW' }`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `IDEMPOTENCY_KEY_CONFLICT`         | `{ scope: 'approval_request' \| 'review', idempotencyKey: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PRIVACY_JOB_FAILED`               | `{ requestId: string, failedStores: string[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MULTIPLE_VARIANT_CONFLICT`        | `{ experimentId: string, runId: string, idType: string, targetingKeyHash: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ATTENTION_FANOUT_LIMIT_EXCEEDED`  | `{ appId: string, limit: number, environments: number, runningExperiments: number \| null, recommendedAction: "READ_PER_ENVIRONMENT" }` — the Environment attention rollup issues one Analysis read per running Experiment per Environment; past `limit` the read is refused whole rather than truncated, because a partial rollup renders as `clear` for the Environments it dropped. `runningExperiments` is `null` when the Environment count alone was over budget, so no plan ran. Not retryable: remediation is to read attention per Environment, as `recommendedAction` names |
| `WEB_ANALYTICS_WINDOW_UNAVAILABLE` | `{ from: string, to: string, retentionFloorAt: string, retentionDays: number }` — the requested `from` predates the current retention floor; the Analysis Worker never silently clamps the window                                                                                                                                                                                                                                                                                                                                                                                     |
| `RATE_LIMITED`                     | `{ retryAfterMs: number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SERVICE_UNAVAILABLE`              | `{ retryAfterMs: number }` — Provider unresolvable; mirrors the `Retry-After` response header                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ORIGIN_NOT_ALLOWED`               | `{ origin: string, hint: string }` — names the offending origin + how to fix (add to allow-list / open key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `APP_MISMATCH`                     | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| All `*_NOT_FOUND` codes            | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `UNAUTHORIZED`                     | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CREDENTIAL_REVOKED`               | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FORBIDDEN`                        | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `INTERNAL_SERVER_ERROR`            | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
  | 'READ_PER_ENVIRONMENT'   // App-wide attention rollup exceeded its fan-out budget; read attention per Environment instead
```

Per-code mapping (the action is deterministic per code, but lives in `details` so the agent reads
one field rather than maintaining a code→action table of its own):

| code                              | `recommendedAction`       | what the agent does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_FROZEN`                      | field-dependent           | an **assignment** edit (`salt`, `allocation`, `variantSet`, `targetingRules`, `targetingSegmentId`, `experiment.targetingKey`, `activationMetricId`) returns `CREATE_NEW_RUN`: a draft Run carries those fields, so applying them there works (ADR-0003). An **App-level or Flag-Configuration** edit (`flagConfig.*`, `variant.value`) returns `END_RUNNING_RUN_FIRST`: a draft Run has no destination field for a Variant name or value, so `CREATE_NEW_RUN` would open a second Run and leave the write refused exactly as before — the impossible remedy ADR-0036 forbids. The rule generalises: `CREATE_NEW_RUN` only where a **draft Run actually holds the field**, `END_RUNNING_RUN_FIRST` everywhere else (including an Experiment field with no draft column) |
| `DECISION_LOCKED`                 | `CREATE_NEW_RUN`          | the decision-family / alpha edit is locked on the running Run; new Run required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TARGETING_KEY_MISMATCH`          | `CREATE_NEW_RUN`          | the targetingKey changed; a new Run is required to rebucket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RUN_NOT_RUNNING`                 | `START_A_RUN`             | End (or other running-only op) hit a non-running Run; Start a Run first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXPERIMENT_RUNNING`              | `END_RUNNING_RUN_FIRST`   | the op (e.g. delete) is blocked while a Run is live; End it, then retry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXPERIMENT_NO_DRAFT`             | `EDIT_DRAFT_THEN_START`   | Start found no draft changes vs the current Run; edit the draft, then Start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VARIANT_NOT_AVAILABLE`           | `ADD_VARIANT_TO_ENV`      | a referenced Variant is not in this Environment's available set; promote it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `APPROVAL_REVIEW_REQUIRED`        | `REVIEW_APPROVAL_REQUEST` | perform an authorized Review on the returned durable request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `APPROVAL_REQUEST_STALE`          | `REFRESH_AND_REPROPOSE`   | read current state and create a new request; stale is terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `APPROVAL_APPLICATION_FAILED`     | `RETRY_REVIEW`            | retry the pending request with a new Review idempotency key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ATTENTION_FANOUT_LIMIT_EXCEEDED` | `READ_PER_ENVIRONMENT`    | the App-wide attention rollup exceeds a fan-out budget; list Experiments per Environment (`experiments_list`) to find the running ones, then read each one's results (`experiment_results_get`) for SRM/Guardrail — listing alone carries no health signal. Retrying the rollup never clears it                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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
  // The Flag Configuration fields a live Run owns in its Environment. Prefixed so
  // an agent can tell a Run-shaped field from a Flag-shaped one without guessing.
  'flagConfig.availableVariantNames',
  'flagConfig.rollout',
  'flagConfig.targetingRules',
  // The Variant catalog is App-level (ADR-0028); a live Run serving the Variant
  // freezes BOTH halves of its served identity. A rename is reported as
  // `flagConfig.availableVariantNames` because that is the set it removes the old
  // name from; a payload swap is reported as `variant.value`.
  'variant.value',
]
```

`currentRunId` names the Run that owns the field, and `recommendedAction` is
`END_RUNNING_RUN_FIRST` for the `flagConfig.*` and `variant.value` entries — not `CREATE_NEW_RUN`,
which is the remedy for an Experiment assignment edit and would send the operator somewhere that does
not change this Flag Configuration or Variant at all. No additional detail field is required: the
existing shape already carries both.

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

The data-plane wire response is intentionally minimal — `DataPlaneEvaluateResponse = { variant, variantName }`
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
- `VALIDATION_ERROR`

**PATCH /api/metrics/:metricId** (measurement edit, no new Run)

- `METRIC_NOT_FOUND`
- `VALIDATION_ERROR`
  — Note: Metric patches never return `RUN_FROZEN`; they recompute over the existing Run (ADR-0003).

**PATCH /api/flags/:flagId/variants/:variantId**

- `RUN_FROZEN` — if any running Run's `variantSet` includes this Variant, by id or by name. Both the
  `name` and the `value` are frozen: renaming removes the old name from every Environment's available
  set, and swapping the payload leaves the Run serving the same arm name with different content, which
  mixes two treatments into one analysis population. `frozenFields` carries
  `flagConfig.availableVariantNames` for the rename and `variant.value` for the payload; both
  recommend `END_RUNNING_RUN_FIRST`. Refused **ahead** of the write and re-checked when an Approval
  Request is applied, so a proposal filed before Start cannot be approved into effect after it.
- `FLAG_NOT_FOUND` / `VARIANT_NOT_FOUND`
- `VALIDATION_ERROR`

**PATCH /apps/:appId/envs/:environmentId/flags/:flagId/config**

- `RUN_FROZEN` — if the patch includes `availableVariantNames` or `rollout` and a running Experiment
  owns this Flag in this Environment. `enabled` is exempt: the kill switch is never frozen, because an
  operator must always be able to turn a Flag off during an incident.
  Checked **before** the Environment Policy gate (ADR-0029), so a change the Run forbids never becomes a
  pending Approval Request that a reviewer could approve into a refusal.
- `VARIANT_NOT_AVAILABLE` / `FLAG_NOT_FOUND` / `VALIDATION_ERROR`

**PUT /apps/:appId/envs/:environmentId/flags/:flagId/targeting-rules**

- `RUN_FROZEN` — if a running Experiment owns this Flag in this Environment. Same ordering: ahead of the
  Environment Policy gate.
- `VARIANT_NOT_AVAILABLE` / `FLAG_NOT_FOUND` / `VALIDATION_ERROR`

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
- `VALIDATION_ERROR` — malformed request, non-UUID `eventId`, a UTF-8 request body over 32 KiB, or
  an unknown strict top-level field, including Entity Profile/version selectors
- `EVENT_DEFINITION_NOT_FOUND` — unknown `eventName` within the credential's App
- `EVENT_DEFINITION_UNPUBLISHED` — definition exists but has no published version
- `EVENT_SCHEMA_MISMATCH` — unknown, missing, type-invalid, allowlist-invalid, or range-invalid
  field, Dimension, or nested JSON key
- `ENTITY_TYPE_MISMATCH` — request `idType` does not equal the accepting version's `entityType`
- `EVENT_ID_CONFLICT` — same App/Environment/`eventId` was already claimed by a different payload

Every failure is no-write. The route returns an error before claiming idempotency or appending
`metric_events`; an exact idempotent retry returns `202` with `duplicate: true`.

**POST /api/sdk/web-events** (data-plane Web Event batch intake, Client Key or API Key)

- `UNAUTHORIZED` / `CREDENTIAL_REVOKED` / `ORIGIN_NOT_ALLOWED` / `RATE_LIMITED`
- `VALIDATION_ERROR` — malformed batch envelope, bare event body, unknown strict field, non-UUID Web
  Session, unpaired `targetingKey` / `idType`, more than 25 events, or a UTF-8 request body over
  32 KiB
- `EVENT_DEFINITION_NOT_FOUND` — unknown `eventName` within the credential's App
- `EVENT_DEFINITION_UNPUBLISHED` — definition exists but has no published version
- `EVENT_SCHEMA_MISMATCH` — unknown, missing, type-invalid, allowlist-invalid, or range-invalid
  field, Dimension, or nested JSON key
- `ENTITY_TYPE_MISMATCH` — supplied identity is prohibited by an anonymous-only definition or its
  `idType` does not equal the accepting version's non-null `entityType`
- `EVENT_ID_CONFLICT` — same Web Event App/Environment/`eventId` was already claimed by different
  event content

An authentication, per-credential rate-limit, aggregate Admission Gate, or strict outer-envelope
failure appends no items. The outer envelope requires a valid UUID `eventId` on every item so
responses are stable by ID. Side-effect-free item validation and existing-claim lookup occur before
the aggregate gate; gate failure rejects the complete request before new claims or outbox writes.
After admission passes, item errors appear in the `202` batch response as
`{ eventId, status: "rejected", error: ErrorResponse }`; valid siblings remain independently
accepted. The route never claims or appends an item that fails validation. An exact item retry
returns `status: "duplicate"` with the originally accepted Event Definition Version.

**GET `/apps/:appId/envs/:environmentId/web-analytics/*`** (control-plane Web Analytics reads)

- `VALIDATION_ERROR` — malformed `from` or `to`, `from >= to`, or a span over 30 days
- `WEB_ANALYTICS_WINDOW_UNAVAILABLE` — `from` predates the current Web Event retention floor
- `WEB_SESSION_NOT_FOUND` — session-event detail only; the session is unknown, outside the
  authorized App/Environment, or has no retained event inside the requested window
- `APP_NOT_FOUND` / `FORBIDDEN` / `UNAUTHORIZED` / `RATE_LIMITED`

An unavailable window returns no partial aggregate or journey. Empty but fully retained windows
return a successful zero or empty response for aggregate and collection routes. The session-event
detail route instead returns the same `WEB_SESSION_NOT_FOUND` for every unavailable session case and
never reveals whether that identifier exists in another scope or time window.

---

## HTTP status mapping

| code group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | HTTP status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `VALIDATION_ERROR`, `ALLOCATION_INVALID`, `INVALID_*`, `EVENT_SCHEMA_MISMATCH`, `ENTITY_TYPE_MISMATCH`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 400         |
| `UNAUTHORIZED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 401         |
| `CREDENTIAL_REVOKED`, `FORBIDDEN`, `INSUFFICIENT_SCOPES`, `ORIGIN_NOT_ALLOWED`, `APP_MISMATCH`, `APPROVAL_REVIEW_FORBIDDEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 403         |
| `*_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 404         |
| `RUN_FROZEN`, `DECISION_LOCKED`, `TARGETING_KEY_MISMATCH`, `RUN_NOT_RUNNING`, `EXPERIMENT_RUNNING`, `EXPERIMENT_NO_DRAFT`, `VARIANT_NOT_AVAILABLE`, `RESOURCE_NOT_EMPTY`, `EXPERIMENT_KEY_CONFLICT`, `MULTIPLE_VARIANT_CONFLICT`, `ATTENTION_FANOUT_LIMIT_EXCEEDED`, `LAST_OWNER_REQUIRED`, `LAST_ENVIRONMENT_REQUIRED`, `PRIVACY_CONFIRMATION_REQUIRED`, `APPROVAL_REVIEW_REQUIRED`, `APPROVAL_REQUEST_STALE`, `APPROVAL_REQUEST_RESOLVED`, `APPROVAL_APPLICATION_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`, `EVENT_DEFINITION_UNPUBLISHED`, `EVENT_DEFINITION_IMMUTABLE`, `EVENT_ID_CONFLICT` | 409         |
| `WEB_ANALYTICS_WINDOW_UNAVAILABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 410         |
| `RATE_LIMITED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 429         |
| `PRIVACY_JOB_FAILED`, `INTERNAL_SERVER_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 500         |
| `SERVICE_UNAVAILABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 503         |

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
