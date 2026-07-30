# Storage schemas: D1 identity and App-level definition tables

D1 column shapes for identity references, Flag definitions, and Event Definitions
(Drizzle-migrated; structurally trusted, not Zod-re-parsed). Experiment-side tables are in
[storage-schemas-d1-experiment.md](./storage-schemas-d1-experiment.md).

Storage shapes carry internals (timestamps, audit, immutability markers) that wire shapes must not
expose. D1 columns are trusted without re-parsing. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## D1 tables (Drizzle-migrated; structurally trusted, not Zod-re-parsed)

All mutable tables include `created_at` and `updated_at` where applicable (timestamp with time zone).
Tenant-scoped tables use `app_id` as a mandatory, first-filtered column in every data-access query.
Org-scoped tables use `org_id`. No table has RLS; scoping is enforced by the Worker data-access layer
(ADR-0018).

### `organizations`

| Column       | Type        | Constraints                |
| ------------ | ----------- | -------------------------- |
| `id`         | text        | PK                         |
| `name`       | text        | not null                   |
| `plan`       | text        | not null, default `'free'` |
| `created_at` | timestamptz | not null                   |
| `updated_at` | timestamptz | not null                   |

### No `users` profile table

WorkOS owns User profile data, including email and display name. D1 stores WorkOS user IDs in
membership, privacy, and audit references only. Do not add a D1 table that duplicates email/profile
PII unless a new ADR replaces this lifecycle contract.

### `org_memberships`

| Column       | Type        | Constraints                  |
| ------------ | ----------- | ---------------------------- |
| `org_id`     | text        | FK → organizations, not null |
| `user_id`    | text        | WorkOS user ID, not null     |
| `role`       | text        | not null                     |
| `created_at` | timestamptz | not null                     |

Composite PK: `(org_id, user_id)`.

### `app_memberships`

| Column       | Type        | Constraints              |
| ------------ | ----------- | ------------------------ |
| `app_id`     | text        | FK → apps, not null      |
| `user_id`    | text        | WorkOS user ID, not null |
| `role`       | text        | not null                 |
| `created_at` | timestamptz | not null                 |

Composite PK: `(app_id, user_id)`.

Privacy request tables live in [storage-schemas-d1-privacy.md](./storage-schemas-d1-privacy.md).

### `apps`

| Column            | Type        | Constraints                              |
| ----------------- | ----------- | ---------------------------------------- |
| `id`              | text        | PK                                       |
| `organization_id` | text        | FK → organizations, not null             |
| `name`            | text        | not null                                 |
| `key`             | text        | not null, unique per org (index)         |
| `description`     | text        | nullable                                 |
| `created_at`      | timestamptz | not null                                 |
| `updated_at`      | timestamptz | not null                                 |
| `created_by`      | text        | WorkOS user ID or deleted-user tombstone |

### `environments`

A first-class axis under App (ADR-0027). Experiments, Experiment Runs, Exposures, SDK credentials,
and Flag CONFIGURATION are scoped to one Environment.

| Column       | Type        | Constraints                                                           |
| ------------ | ----------- | --------------------------------------------------------------------- |
| `id`         | text        | PK                                                                    |
| `app_id`     | text        | FK → apps, not null                                                   |
| `key`        | text        | not null, unique per `(app_id)` (e.g. `'production'`, `'staging'`)    |
| `name`       | text        | not null                                                              |
| `policy`     | text        | not null JSON Environment Policy (`allow \| confirm` per change type) |
| `created_at` | timestamptz | not null                                                              |
| `updated_at` | timestamptz | not null                                                              |
| `created_by` | text        | WorkOS user ID or deleted-user tombstone                              |

### `flags` (DEFINITION — App-level)

Flag DEFINITION is App-level: `key`, value schema, and the Variant catalog. Per-Environment
CONFIGURATION (enabled state, available Variant subset, targeting, rollout) lives in `flag_configs`
(ADR-0027).

| Column               | Type        | Constraints                                                          |
| -------------------- | ----------- | -------------------------------------------------------------------- |
| `id`                 | text        | PK                                                                   |
| `app_id`             | text        | FK → apps, not null                                                  |
| `key`                | text        | not null, unique per `(app_id)`                                      |
| `name`               | text        | not null                                                             |
| `description`        | text        | nullable                                                             |
| `schema`             | text        | nullable (JSON Schema); value contract Variant `value`s must satisfy |
| `default_variant_id` | text        | FK → variants                                                        |
| `created_at`         | timestamptz | not null                                                             |
| `updated_at`         | timestamptz | not null                                                             |
| `created_by`         | text        | WorkOS user ID or deleted-user tombstone                             |
| `updated_by`         | text        | WorkOS user ID or deleted-user tombstone                             |
| `version`            | integer     | not null, default 1; optimistic-lock counter                         |

### `event_definitions` (App-level)

Event Definitions are shared by every Environment in one App. The stable `name` is the
developer-facing `eventName`. The client names it but cannot choose a version.

| Column                         | Type        | Constraints                                                                           |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `id`                           | text        | PK                                                                                    |
| `app_id`                       | text        | FK → apps, not null                                                                   |
| `name`                         | text        | not null, unique per `(app_id)`                                                       |
| `display_name`                 | text        | not null                                                                              |
| `description`                  | text        | nullable                                                                              |
| `current_published_version_id` | text        | nullable, FK → event_definition_versions; must belong to this definition and `app_id` |
| `created_at`                   | timestamptz | not null                                                                              |
| `updated_at`                   | timestamptz | not null                                                                              |
| `created_by`                   | text        | WorkOS user ID or deleted-user tombstone                                              |
| `updated_by`                   | text        | WorkOS user ID or deleted-user tombstone                                              |

### `event_definition_versions` (immutable after creation)

Creating a version and advancing `current_published_version_id` is one D1 transaction. There is no
UPDATE or independent DELETE path for a published version. App deletion removes definitions and
versions only after the normal App data purge has removed dependent Metric Event rows.

| Column                | Type        | Constraints                                                      |
| --------------------- | ----------- | ---------------------------------------------------------------- |
| `id`                  | text        | PK                                                               |
| `app_id`              | text        | FK → apps, not null                                              |
| `event_definition_id` | text        | FK → event_definitions, not null; must match this row's `app_id` |
| `version`             | integer     | not null, positive, unique per `(event_definition_id)`           |
| `entity_type`         | text        | not null; required `id_type` for accepted Metric Events          |
| `fields`              | text        | not null; JSON `EventFieldDefinition[]`                          |
| `dimensions`          | text        | not null; JSON `DimensionDefinition[]`                           |
| `schema_hash`         | text        | not null; SHA-256 of canonical Entity/field/Dimension contract   |
| `published_at`        | timestamptz | not null; also the immutable creation timestamp                  |
| `published_by`        | text        | WorkOS user ID or deleted-user tombstone                         |

UNIQUE constraints: `(event_definition_id, version)` and `(event_definition_id, schema_hash)`.
Every repository query carries `app_id` first even when it also has `event_definition_id`.

D1 does not enforce composite/co-scoped foreign keys across `event_definitions` and
`event_definition_versions`. The Worker data-access seam must reject any write where:

- a version's `event_definition_id` names a definition whose `app_id` differs from the version's
  `app_id`;
- `current_published_version_id` names a version that does not belong to the same Event Definition
  and App.

Cross-App and mismatched-parent references fail before commit; repository tests cover both cases.

### `flag_configs` (CONFIGURATION — per-Environment)

Per-Environment Flag CONFIGURATION (ADR-0027): the `available_variant_names` subset of the App-level
Variant catalog, targeting, rollout, and enabled state. One row per `(flag_id, environment_id)`.

| Column                    | Type        | Constraints                                                          |
| ------------------------- | ----------- | -------------------------------------------------------------------- |
| `id`                      | text        | PK                                                                   |
| `app_id`                  | text        | FK → apps, not null                                                  |
| `environment_id`          | text        | FK → environments, not null (co-scoped with `app_id`)                |
| `flag_id`                 | text        | FK → flags, not null                                                 |
| `enabled`                 | boolean     | not null, default false                                              |
| `available_variant_names` | text        | not null (JSON string array; subset of the Flag's Variant catalog)   |
| `default_variant_id`      | text        | FK → variants                                                        |
| `rollout`                 | text        | nullable (JSON `PercentageRollout`); baseline rollout, `null` = none |
| `created_at`              | timestamptz | not null                                                             |
| `updated_at`              | timestamptz | not null                                                             |
| `version`                 | integer     | not null, default 1; optimistic-lock counter                         |

UNIQUE constraint: `(flag_id, environment_id)`. Per-rule rollouts live on the per-Environment
`targeting_rules` rows (`environment_id` co-scoped); the `rollout` column here is the config-level
**baseline** that applies only to traffic matching no rule. Its `salt` is minted server-side once and
never regenerated on a percentage change (see `PercentageRollout` in `leaf-schemas-flag.md`). A
malformed value is corrupt config, not "no rollout", so reads fail loud rather than degrading to
`null` (ADR-0036).

### `variants`

| Column        | Type        | Constraints                |
| ------------- | ----------- | -------------------------- |
| `id`          | text        | PK                         |
| `flag_id`     | text        | FK → flags, not null       |
| `name`        | text        | not null                   |
| `value`       | text        | not null (JSON-serialized) |
| `description` | text        | nullable                   |
| `created_at`  | timestamptz | not null                   |

### `targeting_rules` (per-Environment Flag CONFIGURATION)

| Column               | Type        | Constraints                                                     |
| -------------------- | ----------- | --------------------------------------------------------------- |
| `id`                 | text        | PK                                                              |
| `app_id`             | text        | FK → apps, not null                                             |
| `environment_id`     | text        | FK → environments, not null (co-scoped with `app_id`, ADR-0027) |
| `flag_id`            | text        | FK → flags, not null                                            |
| `priority`           | integer     | not null                                                        |
| `conditions`         | text        | not null (JSON array of Condition)                              |
| `variant_id`         | text        | FK → variants                                                   |
| `percentage_rollout` | text        | nullable (JSON PercentageRollout)                               |
| `created_at`         | timestamptz | not null                                                        |
| `updated_at`         | timestamptz | not null                                                        |

### `segments`

| Column        | Type        | Constraints           |
| ------------- | ----------- | --------------------- |
| `id`          | text        | PK                    |
| `app_id`      | text        | FK → apps, not null   |
| `name`        | text        | not null              |
| `conditions`  | text        | not null (JSON array) |
| `description` | text        | nullable              |
| `created_at`  | timestamptz | not null              |
| `updated_at`  | timestamptz | not null              |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
