# Storage schemas: D1 experiment, run, metric, and credential tables

D1 column shapes for the experimentation and credential tables (Drizzle-migrated; structurally trusted,
not Zod-re-parsed). Identity and flag-side tables are in [storage-schemas-d1.md](./storage-schemas-d1.md).

Storage shapes carry internals (timestamps, audit, immutability markers) that wire shapes must not
expose. D1 columns are trusted without re-parsing. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## D1 tables (Drizzle-migrated; structurally trusted, not Zod-re-parsed)

All tables include `created_at` (and `updated_at` where applicable, timestamp with time zone).
All tables in this file use `app_id` as a mandatory, first-filtered column in every data-access query.
No table has RLS — app_id scoping is enforced by the Worker data-access layer (ADR-0018).

### `experiments`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `environment_id` | text | FK → environments, not null (co-scoped with `app_id`, ADR-0027) |
| `key` | text | not null, unique per `(app_id, environment_id)` |
| `flag_id` | text | FK → flags, not null |
| `name` | text | not null |
| `description` | text | nullable |
| `hypothesis` | text | nullable |
| `status` | text | not null, default `'draft'` |
| `targeting_key_field` | text | not null; Evaluation Context field used as the Targeting Key |
| `confidence_level` | real | not null, default 0.95 |
| `default_variant_id` | text | FK → variants |
| `metrics` | text | not null (JSON array of MetricRef) |
| `guardrail_metrics` | text | not null (JSON array of MetricRef) |
| `activation_metric_id` | text | nullable, FK → metrics |
| `conversion_window_ms` | integer | not null, default 0 |
| `dimensions` | text | not null (JSON string array) |
| `live_run_id` | text | nullable, FK → runs |
| `created_at` | timestamptz | not null |
| `updated_at` | timestamptz | not null |
| `created_by` | text | WorkOS user ID or deleted-user tombstone |
| `updated_by` | text | WorkOS user ID or deleted-user tombstone |

### `runs`

Immutable assignment config columns are marked; Drizzle migrations must not add UPDATE paths for them.

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `environment_id` | text | FK → environments, not null (co-scoped with `app_id`, ADR-0027) |
| `experiment_id` | text | FK → experiments, not null |
| `status` | text | not null, default `'running'` |
| `salt` | text | not null; **immutable** |
| `allocation` | text | not null (JSON); **immutable** |
| `variant_set` | text | not null (JSON); **immutable** |
| `targeting_segment_id` | text | nullable; **immutable** |
| `confidence_level` | real | not null; locked at Run Start |
| `horizon` | text | not null, default `'sequential'`; locked at Run Start |
| `target_n` | integer | nullable; sequential tuning |
| `sample_size_locked` | integer | nullable; required for fixed horizon |
| `decision_family` | text | not null (JSON); locked goal Metric × Variant × Primary Dimension members |
| `guardrail_decisions` | text | not null (JSON); locked thresholds/directions |
| `config_hash` | text | not null; computed SHA-256; **immutable** |
| `started_at` | timestamptz | not null |
| `ended_at` | timestamptz | nullable |
| `created_at` | timestamptz | not null |
| `created_by` | text | WorkOS user ID or deleted-user tombstone |

UNIQUE constraint: `(experiment_id, salt)` — salt unique per Experiment.

### `metrics`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `key` | text | not null, unique per `(app_id)` |
| `name` | text | not null |
| `description` | text | nullable |
| `kind` | text | not null |
| `event_name` | text | not null |
| `event_value_field` | text | nullable |
| `denominator_metric_id` | text | nullable, FK → metrics (same app) |
| `created_at` | timestamptz | not null |
| `created_by` | text | WorkOS user ID or deleted-user tombstone |

### `sdk_credentials`

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK |
| `app_id` | text | FK → apps, not null |
| `environment_id` | text | FK → environments, not null (co-scoped with `app_id`, ADR-0027) |
| `kind` | text | not null (`'api_key'` or `'client_key'`) |
| `name` | text | not null |
| `description` | text | nullable |
| `hash` | text | not null, indexed |
| `scopes` | text | not null (JSON array) |
| `revoked` | boolean | not null, default false |
| `origin_allowlist` | text | nullable (JSON array; Client Key only) |
| `created_at` | timestamptz | not null |
| `created_by` | text | WorkOS user ID or deleted-user tombstone |
| `revoked_at` | timestamptz | nullable |
| `revoked_by` | text | nullable; WorkOS user ID or deleted-user tombstone |

**No raw secret value is ever stored.** Only the hash.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
