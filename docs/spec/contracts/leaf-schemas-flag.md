# Leaf schemas: Flag, Variant, TargetingRule, Condition, Segment

Canonical field lists for the flag-side glossary nouns. Every noun is ONE Zod schema in
`@splitch/contracts`; request, response, and storage shapes compose these leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## Variant

The possible value a Flag can return. `value` is frozen per Run because changing it is an assignment edit.

| Field         | Type                                    | Required | Meaning                                                                                                                                                                                                             |
| ------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string`                                | yes      | Unique per Flag                                                                                                                                                                                                     |
| `name`        | `string`                                | yes      | Semantic label; used as the identifier in analysis and Exposure logs. Write-bound: 200 characters.                                                                                                                  |
| `value`       | `boolean \| string \| number \| object` | yes      | JSON value served at evaluation; type tag is `z.union([z.boolean(), z.string(), z.number(), z.record(z.unknown())])`. String values are write-bound to 4096 characters; object values to 64 keys of 128 characters. |
| `description` | `string`                                | no       | Human label. Write-bound: 2000 characters.                                                                                                                                                                          |

`assign()` returns the Variant **name** (string). The value/metadata lives on the Flag definition.
Exposure logs the Variant name.

---

## Flag

Flag DEFINITION (`key`, value schema, Variant catalog, Default Variant) is App-level. Flag
CONFIGURATION (`enabled`, `availableVariantNames` subset of the catalog, `targetingRules`, rollout) is
per-Environment (ADR-0027) and lives in separate Flag Configuration schemas.

| Field              | Type                 | Required | Meaning                                                                                              |
| ------------------ | -------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`               | `string`             | yes      | Stable UUID                                                                                          |
| `appId`            | `string`             | yes      | Owning App                                                                                           |
| `key`              | `string`             | yes      | Unique per App; the stable string clients use (DEFINITION)                                           |
| `name`             | `string`             | yes      | Display label (DEFINITION)                                                                           |
| `description`      | `string`             | no       | —                                                                                                    |
| `schema`           | `JSONSchema \| null` | no       | Supported JSON Schema subset every Variant `value` must satisfy; `null` = unconstrained (DEFINITION) |
| `variants`         | `Variant[]`          | yes      | Min 1; the App-level Variant catalog; each `value` validates against `schema` (DEFINITION)           |
| `defaultVariantId` | `string`             | yes      | App-level Default Variant id                                                                         |
| `createdAt`        | `string` (ISO 8601)  | yes      | —                                                                                                    |
| `updatedAt`        | `string` (ISO 8601)  | yes      | —                                                                                                    |

---

## TargetingRule

First-match over priority-ascending order.

| Field               | Type                        | Required | Meaning                                                                       |
| ------------------- | --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `id`                | `string`                    | yes      | Stable UUID                                                                   |
| `flagId`            | `string`                    | yes      | Owning Flag                                                                   |
| `priority`          | `number`                    | yes      | Integer ≥ 0; lower = evaluated first                                          |
| `conditions`        | `Condition[]`               | yes      | Direct Conditions; combined with AND within the rule. Write-bound: 100 items. |
| `segmentId`         | `string`                    | no       | App-level Segment whose Conditions are AND-merged at publication              |
| `variantId`         | `string`                    | yes      | Served when all conditions match                                              |
| `percentageRollout` | `PercentageRollout \| null` | no       | If set, only the declared percentage gets this Variant                        |

A rule must carry at least one direct Condition or `segmentId`. The Segment must belong to the
same App. `TargetingRule` is the authoring shape retained in D1. Publication resolves the referenced
Segment and emits `ResolvedTargetingRule`, which has the same fields except `segmentId` and contains
the concrete AND-merged Conditions. KV and Run snapshots accept only the resolved shape.

---

## PercentageRollout

| Field        | Type     | Required | Meaning                                                                                                 |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `percentage` | `number` | yes      | 0–100 (inclusive); fractional allowed                                                                   |
| `salt`       | `string` | yes      | Deterministic bucketing salt for this rollout; distinct from the Run salt. Write-bound: 128 characters. |

Used in two places: on a `TargetingRule` as `percentageRollout` (rolls the traffic that matched that
rule), and on a Flag Configuration as the baseline `rollout` (rolls the traffic that matched **no**
rule). Both bucket identically via `fractionalEval(salt, targetingKey, weights)`.

**The salt is server-owned and never reminted.** The salt _is_ the bucket assignment, so replacing it
reshuffles which Entities sit inside the rollout. The control plane mints it on the first write that
sets a non-null rollout and carries it verbatim through every later percentage change, so raising
10% → 25% only widens the band and never moves anyone out of it. Callers may therefore send a
percentage but never a salt — a caller-supplied `salt` is rejected. Clearing a rollout to `null` is
the one way to drop a salt; it is explicit and visible, and re-establishing afterwards mints a fresh
one. Under **promotion**, the source's percentage moves but the target Environment keeps its own salt
(a target with no prior baseline mints one), because each Environment's cohort is its own. Silently
reshuffling a live cohort is exactly the invisible-change failure ADR-0036 forbids.

---

## Condition

| Field       | Type                                       | Required | Meaning                                                                                                   |
| ----------- | ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `attribute` | `string`                                   | yes      | Key from EvaluationContext attributes. Write-bound: 128 characters.                                       |
| `operator`  | `ConditionOperator`                        | yes      | See enum below                                                                                            |
| `value`     | `boolean \| string \| number \| unknown[]` | yes      | Comparison target. String values are write-bound to 1024 characters; `in` / `not_in` arrays to 100 items. |

`ConditionOperator` enum: `'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'not_in' | 'matches' | 'not_matches'`

`matches` / `not_matches` interpret `value` as a regex string.
`in` / `not_in` require `value` to be an array.

When the Evaluation Context attribute is an array, `eq`, `neq`, `in`, and `not_in` compare
element-wise with `Object.is` (no string coercion, no loose equality):

- `eq` matches when any actual element equals the scalar Condition `value`.
- `neq` matches when no actual element equals the scalar Condition `value`.
- `in` matches when any actual element equals any expected list member (set intersection).
- `not_in` matches when that intersection is empty.

An empty actual array therefore never matches `eq` or `in`, and always matches `neq` and
`not_in`. An empty expected list never matches `in` and always matches `not_in`, for both
scalar and array actuals. Scalar actuals keep the existing whole-value `Object.is`
comparison. Numeric, regex, and other non-membership operators do not iterate array
elements. See
[evaluate-path-orchestration.md § Array-valued Evaluation Context attributes](../evaluation/evaluate-path-orchestration.md#array-valued-evaluation-context-attributes).

---

## Segment

A named, reusable set of Conditions an Entity must satisfy.

| Field         | Type                | Required | Meaning                                         |
| ------------- | ------------------- | -------- | ----------------------------------------------- |
| `id`          | `string`            | yes      | Stable UUID                                     |
| `appId`       | `string`            | yes      | —                                               |
| `name`        | `string`            | yes      | —                                               |
| `conditions`  | `Condition[]`       | yes      | AND-combined; Entity "in Segment" iff all match |
| `description` | `string`            | no       | —                                               |
| `createdAt`   | `string` (ISO 8601) | yes      | —                                               |
| `updatedAt`   | `string` (ISO 8601) | yes      | —                                               |

(Segments are Conditions.)

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
