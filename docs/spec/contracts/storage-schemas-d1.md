# Storage schemas: D1 identity and flag tables

D1 column shapes for the identity and flag-side tables (Drizzle-migrated; structurally trusted, not
Zod-re-parsed). Experiment-side tables are in [storage-schemas-d1-experiment.md](./storage-schemas-d1-experiment.md).

Storage shapes carry internals (timestamps, audit, immutability markers) that wire shapes must not
expose. D1 columns are trusted without re-parsing. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## D1 tables (Drizzle-migrated; structurally trusted, not Zod-re-parsed)

All tables include `created_at` and `updated_at` (timestamp with time zone).
All tables use `app_id` as a mandatory, first-filtered column in every data-access query.
No table has RLS — app_id scoping is enforced by the Worker data-access layer (ADR-0018).

### `organizations`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `name` | text | not null |
| `plan` | text | not null, default `'free'` |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |

### `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK (WorkOS user ID) |
| `email` | text | not null, unique |
| `organization_id` | text | FK → organizations |
| `role` | text | not null |
| `created_at` | timestamptz | not null |

### `apps`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `organization_id` | text | FK → organizations, not null |
| `name` | text | not null |
| `key` | text | not null, unique per org (index) |
| `description` | text | nullable |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |
| `created_by` | text | FK → users |

### `flags`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `key` | text | not null, unique per `(app_id)` |
| `name` | text | not null |
| `description` | text | nullable |
| `enabled` | boolean | not null, default false |
| `default_variant_id` | text | FK → variants |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |
| `created_by` | text | FK → users |
| `updated_by` | text | FK → users |
| `version` | integer | not null, default 1; optimistic-lock counter |

### `variants`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `flag_id` | text | FK → flags, not null |
| `name` | text | not null |
| `value` | text | not null (JSON-serialized) |
| `description` | text | nullable |
| `created_at` | timestamptz | not null |

### `targeting_rules`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `flag_id` | text | FK → flags, not null |
| `priority` | integer | not null |
| `conditions` | text | not null (JSON array of Condition) |
| `variant_id` | text | FK → variants |
| `percentage_rollout` | text | nullable (JSON PercentageRollout) |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |

### `segments`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `name` | text | not null |
| `conditions` | text | not null (JSON array) |
| `description` | text | nullable |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
