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
`{ flag_id, environment_id, enabled, available_variant_names: string[], targeting_rules: TargetingRule[] }`.

### `PATCH /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/config`

Body: `{ enabled?: boolean, available_variant_names?: string[] }`.
`available_variant_names` must be a subset of the Flag's catalog (ADR-0028). Subject to this
Environment's Policy (ADR-0029): the "Variant availability" and "enabled state" change types may
require a Confirmation. **Turning `enabled` off is never gated** (kill-switch exemption).
Returns: updated Flag Configuration.

### `PUT /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/targeting-rules`

Full replace of this Environment's Targeting Rule list (ordered; first match wins). Body:
`TargetingRule[]`. Rules may only reference Variants in this Environment's available set. Subject to
the Environment's "targeting/rollout/value" Policy.
Returns: updated Flag Configuration.

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
  confirm?: boolean                     // required when the target Policy gates any selected act at confirm
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

Returns: the updated target Flag Configuration + a diff summary `{ before, after }`.

**Validation (Worker-enforced, fail-loud — ADR-0036):**

- Subject to the target Environment's Policy (ADR-0029): a gated Promotion requires `confirm: true`.
- **Dangling-reference check:** if the resulting target config would have a promoted targeting rule routing
  to a Variant not in the target's available set (after applying `availability`), the request is **rejected**
  with a structured error naming the missing Variant. The panel offers to also tick that Variant's
  availability (`select.availability`), but never auto-applies it silently and the Worker blocks the submit
  regardless of skin (ADR-0023/0028). See
  [../frontend/screen-inventory.md](../frontend/screen-inventory.md) for the diff UX.
- **Ambiguous-baseline check:** a non-null baseline rolls traffic away from the Default Variant into the
  one other available Variant, so it requires the available set to hold exactly one non-Default Variant.
  Otherwise the destination is unknowable and the request is **rejected** with `VALIDATION_ERROR` on
  `rollout`, listing the available Variants. The check runs against the **resulting** Configuration, so
  it fires in both directions: promoting a baseline into a wide target, and promoting `availability`
  that would strand the target's existing baseline (even when `select.rollout` is absent). The same
  rule gates a direct `PATCH .../config` from either side. Clearing the baseline is always permitted,
  including in the same write that widens availability.

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
