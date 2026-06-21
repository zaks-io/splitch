# Canonical entity field list: Organization, App, Environment, Flag, Variant, Experiment, Entity

## Organization

Account / ownership / billing / membership unit. Every account is an Organization — no null case.

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `org_id` | `string` (ULID) | ✓ | Globally unique; WorkOS Organization ID mirrors this |
| `name` | `string` | ✓ | Display name |
| `slug` | `string` | ✓ | URL-safe identifier, unique across all orgs |
| `plan` | `"free" \| "growth" \| "enterprise"` | ✓ | Billing tier; default `"free"` in v1 (v1 scope) |
| `personal` | `boolean` | ✓ | `true` for self-serve single-user orgs; `false` for shared/enterprise |
| `workos_org_id` | `string \| null` | ✓ | WorkOS Organization reference; null until first SSO/SCIM wiring (ADR-0021) |
| `created_at` | `timestamp` | ✓ | ISO 8601 UTC |

**Invariant:** every App belongs to exactly one Organization. There is no App without an Org (`org_id` is never null on App).

## App

Product / service surface. Groups Flags and hosts Experiments. The `app_id` is splitch's data-isolation boundary (ADR-0018).

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `app_id` | `string` (ULID) | ✓ | Data-isolation key; injected into every D1 and Tinybird query |
| `org_id` | `string` (ULID) | ✓ | Owning Organization |
| `name` | `string` | ✓ | Display name |
| `slug` | `string` | ✓ | URL-safe; unique within an Org |
| `created_at` | `timestamp` | ✓ | ISO 8601 UTC |

SDK credentials (the public `client_key`) are per-Environment, not App-level; see the Environment entity (ADR-0027).

The five runtimes of one product share a single App. An App is not an ownership unit (that is the Organization).

## Environment

First-class axis under App (ADR-0027). Experiments, Experiment Runs, Exposures, and SDK credentials are per-Environment. Flag DEFINITION (key, schema, Variant catalog) is App-level; Flag CONFIGURATION (available variants, targeting, rollout, enabled state) is per-Environment.

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `environment_id` | `string` (ULID) | ✓ | Co-scoping key alongside `app_id` for experiments, runs, exposures, and SDK credentials |
| `app_id` | `string` (ULID) | ✓ | Owning App |
| `name` | `string` | ✓ | Display name (e.g. `"production"`, `"staging"`) |
| `slug` | `string` | ✓ | URL-safe; unique within an App |
| `client_key` | `string` | ✓ | Public, non-secret SDK key; per-Environment |
| `created_at` | `timestamp` | ✓ | ISO 8601 UTC |

## Flag

Named feature toggle with a key, Variants, Targeting Rules, and enabled/disabled state.

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `flag_id` | `string` (ULID) | ✓ | Internal identifier |
| `app_id` | `string` (ULID) | ✓ | Owning App |
| `key` | `string` | ✓ | Flag Key — unique within App; stable across renames |
| `name` | `string` | ✓ | Display name |
| `description` | `string` | ✗ | Human note; non-material |
| `enabled` | `boolean` | ✓ | When `false`, all evaluations return Default Variant |
| `default_variant` | `string` | ✓ | Name of the Variant returned when disabled or no rule matches |
| `variants` | `Variant[]` | ✓ | Ordered list; at least one (the Default Variant) |
| `targeting_rules` | `TargetingRule[]` | ✓ | Priority-ordered; first-match-wins; may be empty |
| `created_at` | `timestamp` | ✓ | ISO 8601 UTC |
| `updated_at` | `timestamp` | ✓ | Last non-material or structural edit |

**Definition vs configuration (ADR-0027).** Flag DEFINITION — `key`, value schema, and the Variant catalog — is App-level and shared across Environments. Flag CONFIGURATION — `enabled` state, `default_variant`, the subset of available variants, `targeting_rules`, and rollout — is per-Environment. The configuration fields above are resolved against a specific `environment_id`.

## Variant

A possible value a Flag can return, referenced by a semantic name.

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `name` | `string` | ✓ | Semantic identifier; the value `assign()` and Exposures log |
| `value` | `boolean \| string \| number \| object` | ✓ | JSON-typed payload |
| `description` | `string` | ✗ | Human note; non-material |

`assign()` returns the Variant **name** (string). The value/metadata lives on the Flag definition and is never included in the Exposure event or Assignment Store. "Variation" (Flagship term) is quarantined to the adapter layer and never used here.

## Experiment

Test comparing Variants of a Flag to measure their effect on Metrics for a population of Entities. First-class sibling to Flags under an App; controls Flags while running, does not own them.

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `experiment_id` | `string` (ULID) | ✓ | Internal identifier |
| `app_id` | `string` (ULID) | ✓ | Owning App |
| `environment_id` | `string` (ULID) | ✓ | Owning Environment; Experiments are per-Environment (ADR-0027) |
| `flag_id` | `string` (ULID) | ✓ | The single controlled Flag in v1 (v1 Flag/Experiment scope) |
| `name` | `string` | ✓ | Display name |
| `description` | `string` | ✗ | Non-material |
| `hypothesis` | `string` | ✗ | Formal expected-effect statement |
| `targeting_key_type` | `string` | ✓ | Entity type name the Targeting Key identifies (e.g. `"user"`, `"workspace"`) |
| `status` | `ExperimentStatus` | ✓ | See Run lifecycle spec |
| `live_run_id` | `string \| null` | ✓ | The Experiment Run currently serving Entities; null when no Start has occurred |
| `confidence_level` | `number` | ✓ | Default `0.95`; per-Experiment |
| `metrics` | `ExperimentMetric[]` | ✓ | Goal, guardrail, and secondary Metrics |
| `activation_metric` | `ActivationMetricConfig \| null` | ✗ | Gate config; when set, freezes per Run |
| `dimensions` | `string[]` | ✗ | Attribute names used to slice results |
| `owner` | `string` | ✗ | Non-material |
| `tags` | `string[]` | ✗ | Non-material |
| `created_at` | `timestamp` | ✓ | ISO 8601 UTC |

**v1 constraint:** exactly one Flag per Experiment. The schema uses a single `flag_id` field. A future multi-Flag extension adds a `flag_ids: string[]` but v1 implementations must not assume it. (v1 Flag/Experiment scope)

## Entity

The randomization unit — what the Targeting Key identifies. Not a persisted entity; it is what the Targeting Key represents at runtime (user, session, workspace, etc.).

The term "Entity" names the **concept**: an App may experiment on multiple Entity types (identified by `targeting_key_type` on Experiment). There is no separate `Entity` table — Entities appear as `targeting_key_hash` values in Exposure and Assignment Store records.

## Targeting Key

A `string` that logically identifies the subject of evaluation. First-class required field in the Evaluation Context:

```
EvaluationContext = {
  targetingKey: string   // required; the single identifier splitch buckets on AND measures against
  [attribute: string]: unknown  // arbitrary attributes available for Targeting Rule Conditions
}
```

`idType` is the Experiment's `targeting_key_type`. It is always explicit on evaluate requests and Exposure rows; never derived or defaulted. This guards against Targeting Key value collision across Entity types and mirrors Statsig `userID:idType` keying.

## Sources

- [ADR-0021](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0001](../../adr/0001-assignment-is-pure-not-an-event.md)
- [ADR-0002](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [CONTEXT.md](../../../CONTEXT.md)
