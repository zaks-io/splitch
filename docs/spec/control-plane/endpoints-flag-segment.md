# Control-plane endpoints: Flag definition, Flag Configuration, Promotion, Segment

Request/response shapes for the Flag (definition + per-Environment Configuration), Promotion, and
Segment resource groups.

**App-level vs Environment-level (ADR-0027/0028).** A Flag's _definition_ — key, schema, the full
**Variant catalog**, Default Variant — is **App-level** (defined once): `/apps/{app_id}/flags/…`. Its
**Flag Configuration** — which catalog Variants are available, targeting rules, rollout, enabled state
— is **per-Environment**: `/apps/{app_id}/envs/{environment_id}/flags/{flag_id}/config`. **Promotion**
copies a Flag Configuration (or one Variant's availability) between Environments.

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Flag definition endpoints (App-level — the catalog, defined once)

### `GET /apps/{app_id}/flags`

The optional query `?environmentId={environment_id}` requests one Environment's Configuration
summary inline. When present, `environmentId` must be a non-empty Environment ID in the App; an
empty value is `VALIDATION_ERROR`. When omitted, the endpoint remains an App-level catalog read and
does not return per-Environment data.

Returns exactly:

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

`flagConfiguration` is absent from every item when `environmentId` is omitted and present on every
item when it is supplied. `rollout` is the baseline percentage only, or `null`; full availability
and Targeting Rules remain on `flag_config_get`. `readTruncated` reports whether the bounded read
omitted additional Flags, and `readLimit` reports that bound.

### `POST /apps/{app_id}/flags`

Body:

```
{
  appId: string,             // duplicates the path for derived MCP tools
  key: string,                // unique within App
  name: string,
  description?: string,
  schema?: JSONSchema,       // supported subset the Variant values must satisfy
  variants: [                // the App-level Variant catalog
    { name: string, value: boolean|string|number|object, isDefault: boolean }
  ],
  idempotency_key: string    // also sent as the `Idempotency-Key` header
}
```

Requires an `Idempotency-Key` header. A Flag create re-establishes a key that a
gated delete may have just refused to free, so a retried create must never mint a
second definition for the same key.

Returns: `{ id, appId, key, name, schema, variants, defaultVariantId, createdAt, updatedAt }`
Invariant: exactly one Variant is the Default Variant; every Variant `value` satisfies `schema`.
**No `enabled` here** — enabled state is per-Environment (it lives on the Flag Configuration).

### `GET /apps/{app_id}/flags/{flag_id}`

Returns: full Flag definition (catalog Variants + schema). No per-Environment config.

`{flag_id}` is the Flag's **canonical id**. Key lookup is an explicit query on the
same route: `GET /apps/{app_id}/flags/{selector}?by=key`. `by` accepts `id`
(default) and `key`. The catalog list is bounded; `?by=key` is the exact path
that keeps a Flag reachable in the Panel when it is past that ceiling. A key
that only exists in another App is `FLAG_NOT_FOUND` under this App (the App
scope is the isolation boundary). Write routes stay id-only.

### `PATCH /apps/{app_id}/flags/{flag_id}`

Body: `{ name?, description?, schema? }`. Does NOT accept `variants` or `enabled`.
Returns: updated Flag definition.

### `POST /apps/{app_id}/flags/{flag_id}/variants`

Adds a Variant to the **catalog** (App-level). Body:
`{ appId, flagId, name, value, isDefault? }`; `appId` and `flagId` duplicate the path for derived MCP
tools and must match it. `value` must satisfy the Flag's `schema`. A new catalog Variant is **not**
available in any Environment until **promoted** (ADR-0028).
Returns: updated Flag definition.

### `PATCH /apps/{app_id}/flags/{flag_id}/variants/{variant_name}`

Updates App-level Variant metadata/value. Body:
`{ name?, value?, description?, review?: { action: "approve_and_apply" }, idempotency_key: string }`.
A value change must satisfy the Flag schema and is blocked while any running Experiment Run includes
the Variant.

Because the value is App-level, its Approval target includes every Environment where the Variant is
effectively servable. The strictest `targetingRolloutValue` Review authority across those
Environments wins. Its version token covers the parent `flags.version` plus the sorted impacted
Flag Configuration and Policy vector. Any vector change before Review makes the request terminal
`stale`. See
[../contracts/request-response-envelopes-flag-variant.md](../contracts/request-response-envelopes-flag-variant.md#app-level-variant-value-approval-target).
Returns: `{ flag: FlagObject, approval_request: ApprovalRequest | null }`. The request is null under
`allow` and applied under `confirm`.

### `DELETE /apps/{app_id}/flags/{flag_id}/variants/{variant_name}`

Removes a Variant from the catalog. Blocked if the Variant is available in any Environment or
referenced in a running Experiment.

### `DELETE /apps/{app_id}/flags/{flag_id}`

Auto-provisioned per-Environment Flag Configurations are **cascade-deleted** with the Flag
(SPL-164). Blocked if the Flag is referenced by any **non-archived** Experiment in any Environment.
A **running** Experiment returns `EXPERIMENT_RUNNING`; draft or ended Experiments return
`RESOURCE_NOT_EMPTY` with `childType: "experiment"`. Archived Experiments (and their retained Runs)
are hard-deleted as part of the Flag cascade once no non-archived reference remains.

Requires an `Idempotency-Key` header. Because the delete destroys every Environment's available
Variant set and frees the Flag key for immediate re-creation, it is a `variant_availability` change:
if any Environment serving the Flag is not `allow`, the delete opens an Approval Request
(`target.type = "flag"`) instead of applying. The target version covers `flags.version` plus the
sorted vector of configured Environments, their Flag Configuration versions, and their Policy
levels, so any of those moving before Review renders the request terminal `stale`.

## Flag Configuration endpoints (per-Environment)

### `GET /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/config`

Returns: the Flag's Configuration in this Environment:
`{ flag_id, environment_id, enabled, available_variant_names: string[], targeting_rules: TargetingRule[],
rollout: { percentage: number, salt: string } | null }`.

`rollout` is the config-level **baseline** and is `null` when no baseline is set. The `salt` is
returned for transparency and diffing; it is server-owned and cannot be written (see PATCH).

### `PATCH /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/config`

Body:
`{ enabled?: boolean, available_variant_names?: string[], rollout?: { percentage: number } | null, review?: { action: "approve_and_apply" }, idempotency_key: string }`.
`available_variant_names` must be a subset of the Flag's catalog (ADR-0028). Subject to this
Environment's Policy (ADR-0029): the "Variant availability" and "enabled state" change types may
require Review. Turning a Flag Config off applies without approval regardless of this level.

`rollout` takes a **percentage only** — a caller-supplied `salt` is rejected. The salt IS the bucket
assignment, so the server mints it once when the baseline is first established and carries it through
every later percentage change; letting a caller set it would silently reshuffle who is in the rollout.
`rollout: null` clears the baseline (and drops that cohort); omitting the field leaves it untouched.
A baseline change is a rollout **value** change, so it falls under the `targeting_rollout_value`
Policy gate. Rejected with `VALIDATION_ERROR` on `rollout` when the resulting state has anything other
than exactly one non-Default candidate to roll into (see the ambiguity rule below).
Blocked while a running Experiment owns this Flag in this Environment: `available_variant_names` and
`rollout` are frozen by the live Run and return `RUN_FROZEN` with `recommended_action:
"END_RUNNING_RUN_FIRST"`, naming the Run in `current_run_id`. `enabled` is exempt — the kill switch is
never frozen. The freeze is checked **before** the Policy gate, so a change the Run forbids never
becomes a pending Approval Request.
Returns:
`{ config: FlagConfiguration, approval_request: ApprovalRequest | null }`. The request is null under
`allow` and applied under `confirm`.

### `PUT /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/targeting-rules`

Full replace of this Environment's Targeting Rule list (ordered; first match wins). Body:
`{ targetingRules: TargetingRule[], review?: { action: "approve_and_apply" }, idempotency_key: string }`.
Rules may only reference Variants in this Environment's available set. Subject to the Environment's
"targeting/rollout/value" Policy. Blocked while a running Experiment owns this Flag in this
Environment, with the same `RUN_FROZEN` refusal and the same ordering ahead of the Policy gate.
An optional `segmentId` must name a Segment in the same App. Publication AND-merges that Segment's
Conditions with the rule's direct Conditions and writes only resolved Conditions to KV.
Returns:
`{ config: FlagConfiguration, approval_request: ApprovalRequest | null }`. The request is null under
`allow` and applied under `confirm`.

## Promotion endpoints

### `POST /apps/{app_id}/envs/{target_environment_id}/flags/{flag_id}/promote`

Promotes a **selected subset** of Flag Configuration from a source Environment into this (target)
Environment (ADR-0028). The body carries the explicit set of ticked field-groups — a field is present
only if it is being promoted, so absence means "leave the target's value untouched":

```
{
  from_environment_id: string,
  select: {
    availability?: string[],           // Variant names whose source availability to copy (per-Variant act)
    targeting?: true,                   // promote the whole ordered targeting-rule list (atomic; never per-rule)
    rollout?: true,                     // promote the config-level baseline rollout (percentage only)
    enabled?: true                      // promote the enabled state
  },
  review?: { action: "approve_and_apply" }, // inline canonical Review under confirm
  idempotency_key: string
}
```

The two named UX presets are just shapes of `select`: **"whole config"** ticks every field-group
(`availability` = the source's full available set, `targeting`, `rollout`, `enabled`); **"one Variant's
availability"** sends `{ availability: ["variant_name"] }`. There is no separate `scope` enum.

**`rollout` and `targeting` are disjoint.** `select.rollout` moves the config-level baseline and
nothing else. A Targeting Rule's own `percentage_rollout` is part of that rule and moves only under
`select.targeting`, which moves each rule whole (conditions and percentage together). The two never
overlap: a rule's percentage is the split of that one rule's matched traffic and is meaningless apart
from its conditions, and rules have no cross-Environment identity to match on anyway (`priority` is a
sort key, and source and target rule lists routinely differ — that is what Promotion is for).

The baseline moves as a **percentage only**: the target keeps its own salt, or mints a fresh one if it
had no baseline. Adopting the source's salt would reshuffle every already-bucketed Entity in the target.

Promotion preserves each authoring `segmentId` in D1 and republishes a resolved KV projection.

Returns: the updated target Flag Configuration + the immutable Approval diff +
`approval_request: ApprovalRequest | null`. The request is null under `allow` and applied under
`confirm`.

**Validation (Worker-enforced, fail-loud — ADR-0036):**

- Subject to the target Environment's Policy (ADR-0029): under `confirm`, the proposer may perform
  the inline `approve_and_apply` Review. Without it, the durable request remains `pending` and the
  endpoint returns `APPROVAL_REVIEW_REQUIRED`.
- **Run freeze (target Environment):** a Promotion writes into the target, so it is the **target's**
  live Run that decides. While a running Experiment owns this Flag there, `select.availability`,
  `select.rollout`, and `select.targeting` are refused with `RUN_FROZEN`, `recommended_action:
"END_RUNNING_RUN_FIRST"`, and the target's Run in `current_run_id`; `frozen_fields` names only the
  field-groups the caller actually ticked. `select.enabled` is exempt, so promoting a kill switch
  alone still succeeds. The refusal covers the whole request — no field-group is partially promoted —
  and it is checked before the Policy gate, so a frozen Promotion never becomes a pending Approval
  Request. The source Environment's Runs are irrelevant: nothing is written there.
- **Dangling-reference check:** if the resulting target config would have a promoted targeting rule routing
  to a Variant not in the target's available set (after applying `availability`), the request is **rejected**
  with a structured error naming the missing Variant. The panel offers to also tick that Variant's
  availability (`select.availability`), but never auto-applies it silently and the Worker blocks the submit
  regardless of skin (ADR-0023/0028). See
  [../frontend/screen-inventory.md](../frontend/screen-inventory.md) for the diff UX.
- **Ambiguous-baseline check:** a non-null baseline rolls traffic away from the Default Variant into the
  one other candidate, so it requires exactly one non-Default candidate. Candidates are the available
  set, or the Flag's Variant catalog when the available set is **empty** (empty means never-narrowed,
  not zero-servable, so a freshly created Flag accepts a baseline in one call). Otherwise the
  destination is unknowable and the request is **rejected** with `VALIDATION_ERROR` on
  `rollout`, listing the available Variants. The check runs against the **resulting** Configuration, so
  it fires in both directions: promoting a baseline into a wide target, and promoting `availability`
  that would strand the target's existing baseline (even when `select.rollout` is absent). The same
  rule gates a direct `PATCH .../config` from either side. Clearing the baseline is always permitted,
  including in the same write that widens availability.

## One Approval Request and Review mechanism

Flag Configuration patch, Targeting Rule replacement, Promotion, and App-level Variant value patch
all use the Approval contract in
[../contracts/storage-schemas-d1.md](../contracts/storage-schemas-d1.md#approval_requests). There is
no endpoint-specific Confirmation pipeline:

- `allow` requires no Review and enters the same validated application seam directly;
- `confirm` authorizes the proposer to invoke `approve_and_apply`;
- future `approve` forbids self-review and authorizes a distinct principal to invoke that identical
  action.

Review authorization and target-version validation happen before mutation. The canonical target
mutation, successful Review, resulting target version, Approval Request transition, and audit
metadata commit atomically at the owning D1 boundary. Application failure rolls that transaction
back, records a failed Review attempt, and leaves the request `pending`. Exact retries replay by
idempotency key; a later application retry uses a new Review key. Error details are canonical in
[../contracts/error-responses.md](../contracts/error-responses.md#approval-request-and-review-errors).

A Run that starts after a Request is minted does not change the target's version, so version
validation cannot see it. `approve_and_apply` therefore re-checks the freeze at the application seam
and, when a Run now owns a proposed field, returns `RUN_FROZEN` and resolves the Request `stale`.
Resolving it is deliberate: leaving it `pending` would make it approvable the moment the Run ended,
which is the silent delayed write the freeze exists to prevent. The remedy is to re-propose against
the state the operator can currently see, not to retry the Review.

Multiple pending Approval Requests for the same target are allowed. Each is an independent immutable
proposal against its captured target version. Applying one changes the live target version, so every
other pending request for the prior version subsequently renders `stale`.

## Approval Request endpoints

### `GET /apps/{app_id}/approval-requests?status=&target_kind=&environmentId=&limit=&cursor=`

Lists full Approval Request wire projections in the App. `status` optionally filters
`pending | applied | declined | stale`; `target_kind` optionally filters
`flag | flag_configuration | flag_variant | experiment_draft`; `environmentId` optionally
keeps only Requests whose Policy context targets that Environment (narrows within the App).
The response uses the standard cursor page:
`{ items: ApprovalRequest[], cursor: string | null, limit: number, total: number | null }`.
Production always merges D1 with Tinybird archives, so `total` is always `null`. An exact total
would require a second Tinybird round-trip on every list request; `null` is the honest result rather
than a partial D1 count.

### `GET /apps/{app_id}/approval-requests/{id}`

Returns one full Approval Request wire projection, including immutable Policy contexts, target,
diff, proposer, application result, and latest Review.

Both reads compute effective staleness against the live target version. A stored `pending` request
whose target moved is rendered with `status: stale` without mutating D1, setting `resolved_at`, or
creating a Review. V1 has no staleness TTL. A subsequent Review of that request rechecks the target
inside the transaction, materializes the stale Review and terminal state, and returns
`APPROVAL_REQUEST_STALE`.

List and single reads span D1 and verified Tinybird archives. Both stores use the same
`(proposed_at DESC, Approval Request ID DESC)` order and the existing opaque cursor value, so a page
may cross the 90-day boundary without duplicating or skipping a Request. App scope is enforced
before either archive lookup. The archived projection is schema-checked against the same
`ApprovalRequest` wire contract as the D1 projection, including deleted-user tombstones. Only
`status=pending` skips the archive lookup, because the archive never holds a pending row; every
other list, including the default unfiltered view and `status=stale`, queries Tinybird alongside D1,
so a Tinybird outage fails that request even though the pending Requests it would have returned live
only in D1 (ADR-0036: fail loud rather than silently drop the archive).

### `POST /apps/{app_id}/approval-requests/{id}/reviews`

Body:
`{ action: "approve_and_apply" | "decline", reason?: string, idempotency_key: string }`.
Returns the full Approval Request projection after the Review attempt. The Review idempotency key is
required. The coarse route gate requires App membership; current membership and Policy determine
the exact Review authority before target validation or mutation.

These three registered routes mechanically derive the MCP tools `approval_requests_list`,
`approval_requests_get`, and `approval_request_reviews_create`. No hand-written MCP schema is
required.

## Segment endpoints

### `GET /apps/{app_id}/segments`

Returns the App's Segments plus the Environment ids whose live Flag Configurations reference each
Segment, so authoring surfaces can show the full republish impact.

### `POST /apps/{app_id}/segments`

Body: `{ name: string, description?: string, conditions: Condition[] }`
Returns: `{ segment_id, app_id, name, conditions, created_at }`

### `GET /apps/{app_id}/segments/{segment_id}`

### `PATCH /apps/{app_id}/segments/{segment_id}`

Body: `{ name?, description?, conditions? }`

After the D1 update, every dependent live Flag Configuration in every Environment is synchronously
republished. The request does not succeed until those KV projections contain the new resolved
Conditions, within the five-second propagation contract.

### `DELETE /apps/{app_id}/segments/{segment_id}`

Blocked by every dependent live Flag Configuration and Experiment draft. The refusal names each
mutable dependent. A Run stores only frozen resolved Conditions, so running and ended Run snapshots
do not block Segment deletion and do not drift after deletion.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
