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

Returns: list of Flag definitions.

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
  ]
}
```

Returns: `{ id, appId, key, name, schema, variants, defaultVariantId, createdAt, updatedAt }`
Invariant: exactly one Variant is the Default Variant; every Variant `value` satisfies `schema`.
**No `enabled` here** — enabled state is per-Environment (it lives on the Flag Configuration).

### `GET /apps/{app_id}/flags/{flag_id}`

Returns: full Flag definition (catalog Variants + schema). No per-Environment config.

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
(SPL-164). Blocked if the Flag is referenced by any Experiment in any Environment. A **running**
Experiment returns `EXPERIMENT_RUNNING`; draft or ended Experiments return `RESOURCE_NOT_EMPTY`
with `childType: "experiment"`.

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
require Review. **Turning `enabled` off is never gated** (kill-switch exemption).

`rollout` takes a **percentage only** — a caller-supplied `salt` is rejected. The salt IS the bucket
assignment, so the server mints it once when the baseline is first established and carries it through
every later percentage change; letting a caller set it would silently reshuffle who is in the rollout.
`rollout: null` clears the baseline (and drops that cohort); omitting the field leaves it untouched.
A baseline change is a rollout **value** change, so it falls under the `targeting_rollout_value`
Policy gate. Rejected with `VALIDATION_ERROR` on `rollout` when the resulting state has anything other
than exactly one non-Default candidate to roll into (see the ambiguity rule below).
Returns:
`{ config: FlagConfiguration, approval_request: ApprovalRequest | null }`. The request is null under
`allow` and applied under `confirm`.

### `PUT /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/targeting-rules`

Full replace of this Environment's Targeting Rule list (ordered; first match wins). Body:
`{ targetingRules: TargetingRule[], review?: { action: "approve_and_apply" }, idempotency_key: string }`.
Rules may only reference Variants in this Environment's available set. Subject to the Environment's
"targeting/rollout/value" Policy.
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

Returns: the updated target Flag Configuration + the immutable Approval diff +
`approval_request: ApprovalRequest | null`. The request is null under `allow` and applied under
`confirm`.

**Validation (Worker-enforced, fail-loud — ADR-0036):**

- Subject to the target Environment's Policy (ADR-0029): under `confirm`, the proposer may perform
  the inline `approve_and_apply` Review. Without it, the durable request remains `pending` and the
  endpoint returns `APPROVAL_REVIEW_REQUIRED`.
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

## Segment endpoints

### `GET /apps/{app_id}/segments`

### `POST /apps/{app_id}/segments`

Body: `{ name: string, description?: string, conditions: Condition[] }`
Returns: `{ segment_id, app_id, name, conditions, created_at }`

### `GET /apps/{app_id}/segments/{segment_id}`

### `PATCH /apps/{app_id}/segments/{segment_id}`

Body: `{ name?, description?, conditions? }`

### `DELETE /apps/{app_id}/segments/{segment_id}`

Blocked if referenced by a running Experiment.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
