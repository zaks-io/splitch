# Leaf schemas: Flag, Variant, TargetingRule, Condition, Segment

Canonical field lists for the flag-side glossary nouns. Every noun is ONE Zod schema in
`@splitch/contracts`; request, response, and storage shapes compose these leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## Variant

The possible value a Flag can return. `value` is frozen per Run because changing it is an assignment edit.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Unique per Flag |
| `name` | `string` | yes | Semantic label; used as the identifier in analysis and Exposure logs |
| `value` | `boolean \| string \| number \| object` | yes | JSON value served at evaluation; type tag is `z.union([z.boolean(), z.string(), z.number(), z.record(z.unknown())])` |
| `description` | `string` | no | Human label |

`assign()` returns the Variant **name** (string). The value/metadata lives on the Flag definition.
Exposure logs the Variant name.

---

## Flag

Flag DEFINITION (`key`, value schema, Variant catalog) is App-level. Flag CONFIGURATION (`enabled`,
`availableVariantNames` subset of the catalog, `targetingRules`, rollout, `defaultVariantId`) is
per-Environment (ADR-0027); the configuration fields below resolve against a given `environmentId`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `appId` | `string` | yes | Owning App |
| `key` | `string` | yes | Unique per App; the stable string clients use (DEFINITION) |
| `name` | `string` | yes | Display label (DEFINITION) |
| `description` | `string` | no | — |
| `variants` | `Variant[]` | yes | Min 1; the App-level Variant catalog (DEFINITION) |
| `environmentId` | `string` | yes | Environment this CONFIGURATION resolves for (ADR-0027) |
| `enabled` | `boolean` | yes | Per-Environment; when `false`, always serves Default Variant (CONFIGURATION) |
| `availableVariantNames` | `string[]` | yes | Per-Environment subset of the Variant catalog this config may serve (CONFIGURATION) |
| `defaultVariantId` | `string` | yes | Per-Environment Variant served when disabled or no rule matches (CONFIGURATION) |
| `targetingRules` | `TargetingRule[]` | yes | Per-Environment; priority-ordered; empty = never match (CONFIGURATION) |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `updatedAt` | `string` (ISO 8601) | yes | — |

---

## TargetingRule

First-match over priority-ascending order.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `flagId` | `string` | yes | Owning Flag |
| `priority` | `number` | yes | Integer ≥ 0; lower = evaluated first |
| `conditions` | `Condition[]` | yes | Min 1; combined with AND within the rule |
| `variantId` | `string` | yes | Served when all conditions match |
| `percentageRollout` | `PercentageRollout \| null` | no | If set, only the declared percentage gets this Variant |

---

## PercentageRollout

| Field | Type | Required | Meaning |
|---|---|---|---|
| `percentage` | `number` | yes | 0–100 (inclusive); fractional allowed |
| `salt` | `string` | yes | Per-rule deterministic bucketing salt; distinct from Run salt |

---

## Condition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `attribute` | `string` | yes | Key from EvaluationContext attributes |
| `operator` | `ConditionOperator` | yes | See enum below |
| `value` | `boolean \| string \| number \| unknown[]` | yes | Comparison target |

`ConditionOperator` enum: `'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'not_in' | 'matches' | 'not_matches'`

`matches` / `not_matches` interpret `value` as a regex string.
`in` / `not_in` require `value` to be an array.

---

## Segment

A named, reusable set of Conditions an Entity must satisfy.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `appId` | `string` | yes | — |
| `name` | `string` | yes | — |
| `conditions` | `Condition[]` | yes | AND-combined; Entity "in Segment" iff all match |
| `description` | `string` | no | — |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `updatedAt` | `string` (ISO 8601) | yes | — |

(Segments are Conditions.)

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
