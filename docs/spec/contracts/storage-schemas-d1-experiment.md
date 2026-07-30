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

| Column                  | Type        | Constraints                                                                                                                                           |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | text        | PK                                                                                                                                                    |
| `app_id`                | text        | FK → apps, not null                                                                                                                                   |
| `environment_id`        | text        | FK → environments, not null (co-scoped with `app_id`, ADR-0027)                                                                                       |
| `key`                   | text        | not null, unique per `(app_id, environment_id)`                                                                                                       |
| `flag_id`               | text        | FK → flags, not null                                                                                                                                  |
| `name`                  | text        | not null                                                                                                                                              |
| `description`           | text        | nullable                                                                                                                                              |
| `hypothesis`            | text        | nullable                                                                                                                                              |
| `status`                | text        | not null, default `'draft'`                                                                                                                           |
| `targeting_key_field`   | text        | not null; Evaluation Context **field name** read as the Targeting Key (e.g. `"userId"`)                                                               |
| `targeting_key_type`    | text        | not null; **Entity type label** the key identifies (e.g. `"user"`); stamped as `id_type` on every Exposure row and validated against inbound requests |
| `confidence_level`      | real        | not null, default 0.95                                                                                                                                |
| `default_variant_id`    | text        | FK → variants                                                                                                                                         |
| `metrics`               | text        | not null (JSON array of MetricRef)                                                                                                                    |
| `guardrail_metrics`     | text        | not null (JSON array of MetricRef)                                                                                                                    |
| `activation_metric_id`  | text        | nullable, FK → metrics                                                                                                                                |
| `conversion_window_ms`  | integer     | not null, default 0                                                                                                                                   |
| `dimensions`            | text        | not null (JSON string array)                                                                                                                          |
| `draft_allocation`      | text        | nullable (JSON `{ [variantName]: number }`); staged allocation for the next Run                                                                       |
| `draft_salt`            | text        | nullable; optional salt override staged for the next Run                                                                                              |
| `draft_targeting_rules` | text        | nullable (JSON `TargetingRule[]`); staged targeting for the next Run                                                                                  |
| `draft_segment_ids`     | text        | nullable (JSON string array); staged Segments to resolve into rules at Start                                                                          |
| `live_run_id`           | text        | nullable, FK → runs                                                                                                                                   |
| `created_at`            | timestamptz | not null                                                                                                                                              |
| `updated_at`            | timestamptz | not null                                                                                                                                              |
| `created_by`            | text        | WorkOS user ID or deleted-user tombstone                                                                                                              |
| `updated_by`            | text        | WorkOS user ID or deleted-user tombstone                                                                                                              |

The `draft_*` columns are the **staging area for the next Run** (run-state-machine: "Assignment edits
accumulate on the draft; Start is the single reset point"). Assignment-affecting PATCHes write here;
`activation_metric_id` is also part of the draft set (a change to it is an assignment edit). At Start the
Worker resolves `draft_segment_ids` to concrete rules, merges them with `draft_targeting_rules`, and
copies the frozen assignment config (`allocation`, `salt`, `targeting_rules`, `variant_set`) and the
current `default_variant_id` as `control_variant_id` into a new `runs` row. The draft columns are
nullable because a freshly created Experiment has no staged Run yet.

### `runs`

Immutable assignment config columns are marked; Drizzle migrations must not add UPDATE paths for them.

For pre-existing Runs, the `control_variant_id` migration uses the Experiment's current
`default_variant_id` as the best-available backfill. It cannot reconstruct a historical Control that
was not previously stored. New Runs copy and validate the Control against their frozen Variant set
at Start.

| Column                | Type        | Constraints                                                                                              |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `id`                  | text        | PK                                                                                                       |
| `app_id`              | text        | FK → apps, not null                                                                                      |
| `environment_id`      | text        | FK → environments, not null (co-scoped with `app_id`, ADR-0027)                                          |
| `experiment_id`       | text        | FK → experiments, not null                                                                               |
| `run_number`          | integer     | not null; 1-based ordinal within the Experiment; **immutable** (the "Run N" label)                       |
| `status`              | text        | not null, default `'running'`                                                                            |
| `targeting_key_field` | text        | not null; EC field name frozen from the Experiment at Start; **immutable**                               |
| `targeting_key_type`  | text        | not null; Entity type label frozen from the Experiment at Start (the Run's `id_type`); **immutable**     |
| `salt`                | text        | not null; **immutable**                                                                                  |
| `allocation`          | text        | not null (JSON `{ [variantName]: number }`, keyed by Variant name); **immutable**                        |
| `variant_set`         | text        | not null (JSON); **immutable**                                                                           |
| `control_variant_id`  | text        | not null; Control identity copied from the Experiment at Start; **immutable**                            |
| `targeting_rules`     | text        | not null (JSON `TargetingRule[]`; `[]` = all eligible); resolved snapshot frozen at Start; **immutable** |
| `confidence_level`    | real        | not null; locked at Run Start                                                                            |
| `horizon`             | text        | not null, default `'sequential'`; locked at Run Start                                                    |
| `target_n`            | integer     | nullable; sequential tuning                                                                              |
| `sample_size_locked`  | integer     | nullable; required for fixed horizon                                                                     |
| `decision_family`     | text        | not null (JSON); locked goal Metric × Variant × Primary Dimension members                                |
| `guardrail_decisions` | text        | not null (JSON); locked thresholds/directions                                                            |
| `config_hash`         | text        | not null; computed SHA-256; **immutable**                                                                |
| `started_at`          | timestamptz | not null                                                                                                 |
| `ended_at`            | timestamptz | nullable                                                                                                 |
| `start_reason`        | text        | nullable; optional human intent note given at Start; **immutable**                                       |
| `end_reason`          | text        | nullable; optional human note given at `/end`                                                            |
| `created_at`          | timestamptz | not null                                                                                                 |
| `created_by`          | text        | WorkOS user ID or deleted-user tombstone                                                                 |

UNIQUE constraint: `(experiment_id, salt)` — salt unique per Experiment.
UNIQUE constraint: `(experiment_id, run_number)` — run numbers are dense and unique per Experiment.

### `metrics`

| Column                  | Type        | Constraints                                                                                              |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `id`                    | text        | PK                                                                                                       |
| `app_id`                | text        | FK → apps, not null                                                                                      |
| `key`                   | text        | not null, unique per `(app_id)`                                                                          |
| `name`                  | text        | not null                                                                                                 |
| `description`           | text        | nullable                                                                                                 |
| `kind`                  | text        | not null                                                                                                 |
| `event_definition_id`   | text        | nullable, FK → event_definitions (same app); required except for ratio                                   |
| `event_field_name`      | text        | nullable; declared numeric field, required for count/revenue                                             |
| `numerator_metric_id`   | text        | nullable, FK → metrics (same app); ratio only; must ≠ `denominator_metric_id`; operand must be non-Ratio |
| `denominator_metric_id` | text        | nullable, FK → metrics (same app); ratio only; must ≠ `numerator_metric_id`; operand must be non-Ratio   |
| `conversion_window_ms`  | integer     | nullable; inherits Experiment default when null                                                          |
| `winsorize`             | boolean     | not null                                                                                                 |
| `winsorize_pct`         | real        | not null                                                                                                 |
| `created_at`            | timestamptz | not null                                                                                                 |
| `updated_at`            | timestamptz | not null                                                                                                 |
| `created_by`            | text        | WorkOS user ID or deleted-user tombstone                                                                 |
| `updated_by`            | text        | WorkOS user ID or deleted-user tombstone                                                                 |

The Worker resolves `event_field_name` against the Event Definition's current published version and
records only a named top-level field, never a JSON path or expression. Binomial Metrics reference the
Event Definition and leave `event_field_name` null. Ratio Metrics reference two same-App non-Ratio
Metrics, require distinct `numerator_metric_id` and `denominator_metric_id`, reject any operand that
is itself a Ratio Metric, reject dependency cycles through Ratio operands, and leave the direct
Event Definition fields null. Create and patch enforce these same-App, non-Ratio, distinct, and
acyclic operand invariants before writing.

### `client_keys`

Client Keys are public publishable values. The control plane can retrieve and display
`key_material`; the edge validates requests by hashing the presented material and checking KV.

| Column             | Type        | Constraints                                                                                                                                                                                                                                |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key_id`           | text        | PK                                                                                                                                                                                                                                         |
| `app_id`           | text        | FK → apps, not null                                                                                                                                                                                                                        |
| `environment_id`   | text        | FK → environments, not null (co-scoped with `app_id`, ADR-0027)                                                                                                                                                                            |
| `key_material`     | text        | not null; public value shipped to client code                                                                                                                                                                                              |
| `origin_allowlist` | text        | nullable JSON array; `null` = open to all origins (auto-provision default, loudly flagged via `is_origin_open`); `[]` = closed, serves nothing; non-empty = closed except listed origins. Lock down via `PATCH …/client-key` (ADR-0034 §1) |
| `rate_limit_rps`   | integer     | nullable; per-key override                                                                                                                                                                                                                 |
| `revoked_at`       | timestamptz | nullable                                                                                                                                                                                                                                   |
| `created_at`       | timestamptz | not null                                                                                                                                                                                                                                   |
| `created_by`       | text        | WorkOS user ID or deleted-user tombstone                                                                                                                                                                                                   |

### `api_keys`

API Keys are secret. The raw value is surfaced once at creation and is never stored.

| Column            | Type        | Constraints                                                     |
| ----------------- | ----------- | --------------------------------------------------------------- |
| `key_id`          | text        | PK                                                              |
| `app_id`          | text        | FK → apps, not null                                             |
| `environment_id`  | text        | FK → environments, not null (co-scoped with `app_id`, ADR-0027) |
| `key_hash`        | text        | not null, indexed; hash of the secret value                     |
| `scopes`          | text        | not null JSON array                                             |
| `revoked_at`      | timestamptz | nullable                                                        |
| `last_rotated_at` | timestamptz | nullable                                                        |
| `created_at`      | timestamptz | not null                                                        |
| `created_by`      | text        | WorkOS user ID or deleted-user tombstone                        |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
