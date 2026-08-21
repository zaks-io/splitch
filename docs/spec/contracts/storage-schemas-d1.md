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

| Column                   | Type        | Constraints                              |
| ------------------------ | ----------- | ---------------------------------------- |
| `id`                     | text        | PK                                       |
| `organization_id`        | text        | FK → organizations, not null             |
| `name`                   | text        | not null                                 |
| `key`                    | text        | not null, unique per org (index)         |
| `description`            | text        | nullable                                 |
| `create_idempotency_key` | text        | nullable                                 |
| `create_request_hash`    | text        | nullable; canonical create payload hash  |
| `create_response`        | text        | nullable; exact successful response JSON |
| `created_at`             | timestamptz | not null                                 |
| `updated_at`             | timestamptz | not null                                 |
| `created_by`             | text        | WorkOS user ID or deleted-user tombstone |

UNIQUE constraint: `(organization_id, created_by, create_idempotency_key)`. A successful exact-key
retry returns `create_response`; different intent returns `IDEMPOTENCY_KEY_CONFLICT`.

### `environments`

A first-class axis under App (ADR-0027). Experiments, Experiment Runs, Exposures, SDK credentials,
and Flag CONFIGURATION are scoped to one Environment.

| Column       | Type        | Constraints                                                               |
| ------------ | ----------- | ------------------------------------------------------------------------- |
| `id`         | text        | PK                                                                        |
| `app_id`     | text        | FK → apps, not null                                                       |
| `key`        | text        | not null, unique per `(app_id)` (e.g. `'production'`, `'staging'`)        |
| `name`       | text        | not null                                                                  |
| `policy`     | text        | not null JSON Environment Policy (`allow \| confirm`; `approve` reserved) |
| `created_at` | timestamptz | not null                                                                  |
| `updated_at` | timestamptz | not null                                                                  |
| `created_by` | text        | WorkOS user ID or deleted-user tombstone                                  |

### `approval_requests`

The durable proposal for every Policy-gated Promotion, direct Flag Configuration edit, Variant
value edit, and Experiment Run Start. `allow` does not create an Approval Request; it enters the
same validated application seam directly. `confirm` and future `approve` both create this row and
differ only in who may Review it.

| Column                     | Type        | Constraints                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------------- |
| `id`                       | text        | PK; `apr_` + 26-character ULID                                             |
| `app_id`                   | text        | FK → apps, not null                                                        |
| `operation`                | text        | not null; canonical route `operationId`                                    |
| `target_type`              | text        | not null; `flag \| flag_configuration \| flag_variant \| experiment_draft` |
| `target_id`                | text        | not null                                                                   |
| `target_version`           | text        | not null; RFC 8785 JCS SHA-256 token for the complete target projection    |
| `policy_contexts`          | text        | not null; immutable JSON `ApprovalPolicyContext[]`                         |
| `diff`                     | text        | not null; immutable canonical JSON `ApprovalDiff`                          |
| `status`                   | text        | not null; `pending \| applied \| declined \| stale`                        |
| `proposed_by`              | text        | not null; resolved WorkOS user ID or deleted-user tombstone                |
| `proposed_via`             | text        | not null; resolved auth door                                               |
| `proposed_at`              | timestamptz | not null                                                                   |
| `resolved_at`              | timestamptz | nullable; set once on `applied`, `declined`, or `stale`                    |
| `resulting_target_version` | text        | nullable; set only on `applied`                                            |
| `resulting_resource_type`  | text        | nullable; canonical applied resource type, set only on `applied`           |
| `resulting_resource_id`    | text        | nullable; canonical applied resource ID, set only on `applied`             |
| `idempotency_key`          | text        | not null                                                                   |
| `request_hash`             | text        | not null; SHA-256 of UTF-8 RFC 8785 JCS proposal input                     |

UNIQUE constraint: `(app_id, proposed_by, idempotency_key)`. Reusing the key with the same
`request_hash` returns the existing Approval Request. Reusing it with a different hash fails with
`IDEMPOTENCY_KEY_CONFLICT`.

Both `request_hash` and `target_version` are encoded as `sha256:` plus 64 lowercase hexadecimal
digits. Their preimage is UTF-8 RFC 8785 JSON Canonicalization Scheme output, not
implementation-dependent object serialization. `diff.entries` is strictly lexicographic by its
RFC 6901 JSON Pointer `path`, so equal projections produce byte-identical request hashes.

Multiple `pending` rows may name the same target. They are independent proposals and there is no
unique target/status constraint. Applying one advances the target version, making every sibling
proposal for the old version effectively stale. V1 has no staleness TTL.

`target_version` covers everything whose change could invalidate the proposal. Every token includes
the sorted current Policy projection for its `policy_contexts`: `(environment_id, change_type,
level)`. A Policy change therefore makes the proposal stale instead of silently weakening its
authority.

- Flag Configuration edits and Promotion hash the target `flag_configs.version` plus the target
  Environment's relevant Policy projection.
- Experiment Run Start hashes the Experiment draft assignment/decision projection, `live_run_id`,
  and the target Environment's relevant Policy projection.
- An App-level Variant value edit hashes the parent `flags.version` and the sorted vector of
  `(environment_id, flag_configs.version, targeting_rollout_value Policy level)` for every
  Environment where the Variant is effectively servable. One Environment cannot approve an
  App-level value change behind a stricter Environment's Policy.

The Worker recomputes the same token immediately before application. Any mismatch atomically moves
the request from `pending` to `stale`; no field on a stale request can be edited to revive it.
Single and list reads also recompute the token, but only render effective `stale`; they do not
mutate this row, set `resolved_at`, or append a Review. A later Review materializes that terminal
state transactionally.

`policy_contexts` records the immutable policy evidence used at proposal time:
`{ environmentId, changeTypes[], level }[]`. Review authorization is re-evaluated against current
membership and current Policy before target-version validation. A Policy or Flag Configuration
change included in the concurrency projection therefore cannot silently weaken the original gate.

### `approval_reviews` (append-only attempts)

Each authorized Review attempt that reaches target validation or application is durable. An
authentication or authorization rejection creates no `approval_reviews` row and is recorded by the
ordinary security audit path. There is one positive action, `approve_and_apply`; there is no
approve-only or deferred-application state. `decline` is the terminal negative disposition.

| Column                     | Type        | Constraints                                                       |
| -------------------------- | ----------- | ----------------------------------------------------------------- |
| `id`                       | text        | PK; `rev_` + 26-character ULID                                    |
| `app_id`                   | text        | FK → apps, not null                                               |
| `approval_request_id`      | text        | FK → approval_requests, not null                                  |
| `action`                   | text        | not null; `approve_and_apply \| decline`                          |
| `outcome`                  | text        | not null; `applied \| declined \| stale \| failed`                |
| `reviewed_by`              | text        | not null; resolved WorkOS user ID or deleted-user tombstone       |
| `reviewed_via`             | text        | not null; resolved auth door                                      |
| `reviewed_at`              | timestamptz | not null                                                          |
| `reason`                   | text        | nullable; bounded human or agent Review rationale                 |
| `idempotency_key`          | text        | not null                                                          |
| `request_hash`             | text        | not null; SHA-256 of UTF-8 RFC 8785 JCS Review input              |
| `resulting_target_version` | text        | nullable; populated only for `outcome = applied`                  |
| `resulting_resource_type`  | text        | nullable; canonical applied resource type on success              |
| `resulting_resource_id`    | text        | nullable; canonical applied resource ID on success                |
| `error_code`               | text        | nullable; machine-stable application error for `outcome = failed` |
| `error_details`            | text        | nullable; bounded JSON matching the error code's detail contract  |

UNIQUE constraint: `(approval_request_id, reviewed_by, idempotency_key)`. An identical retry
returns the recorded Review. A different payload under the same key fails with
`IDEMPOTENCY_KEY_CONFLICT`. After a failed attempt, the Approval Request remains `pending`; a caller
may make a new authorized attempt with a new idempotency key.

An applied request's wire `applicationResult` is reconstructed from its resulting target version,
resource type, resource ID, and `resolved_at`. The successful Review mirrors the same result identity
and uses the same timestamp for `reviewed_at`, `resolved_at`, and `applicationResult.appliedAt`.
This preserves the created Run ID for `experiments_start`, where the applied `experiment_run`
differs from the original `experiment_draft` target.

Successful `approve_and_apply` uses one transaction at the target's owning D1 persistence boundary:

1. Resolve the `pending` Approval Request and current principal.
2. Authorize the Review from current membership and Policy.
3. Recompute and compare `target_version`.
4. Apply the canonical target mutation and advance its version.
5. Insert the `applied` Review with actor, auth-door, and resulting-version audit metadata.
6. Move the Approval Request to `applied` and store the same resulting version and timestamp.
7. Commit.

Steps 2 and 3 happen before any target mutation. A mismatch records a `stale` Review and moves the
request to `stale` without applying. A decline inserts the `declined` Review and moves the request
to `declined` without applying.

If step 4, 5, or 6 fails, the transaction rolls back, including the target mutation. A separate
failure-record transaction conditionally appends a `failed` Review only while the Approval Request
is still `pending`, with a machine-stable error. It does not change the request status. If another
Review resolved the request first, the failed attempt cannot overwrite that terminal result and
the caller receives the resolved-request result instead. Failure to record the attempt fails loud,
but cannot commit the target mutation. The Review row and Approval Request audit fields are the
durable atomic audit metadata; the unbounded Tinybird audit row is emitted after commit and is
never the mutation authority.

Pending Approval Requests and their Reviews have no TTL, including Requests that render effectively
stale before a Review materializes that state. A stored terminal `applied`, `declined`, or `stale`
Request and every Review remain in D1 through 90 days after `resolved_at`. The daily archival worker
then writes one versioned, canonical, untruncated Request-plus-ordered-Reviews payload to Tinybird,
verifies its archive version, archived D1 row count, and SHA-256 content checksum, and only then atomically
removes the Review rows followed by the Request. A failed append or verification changes no D1
Request or Review row.

### `flags` (DEFINITION — App-level)

Flag DEFINITION is App-level: `key`, value schema, and the Variant catalog. Per-Environment
CONFIGURATION (enabled state, available Variant subset, targeting, rollout) lives in `flag_configs`
(ADR-0027).

| Column                   | Type        | Constraints                                                          |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| `id`                     | text        | PK                                                                   |
| `app_id`                 | text        | FK → apps, not null                                                  |
| `key`                    | text        | not null, unique per `(app_id)`                                      |
| `name`                   | text        | not null                                                             |
| `description`            | text        | nullable                                                             |
| `schema`                 | text        | nullable (JSON Schema); value contract Variant `value`s must satisfy |
| `default_variant_id`     | text        | FK → variants                                                        |
| `create_idempotency_key` | text        | nullable                                                             |
| `create_request_hash`    | text        | nullable; canonical create payload hash                              |
| `create_response`        | text        | nullable; exact successful response JSON                             |
| `created_at`             | timestamptz | not null                                                             |
| `updated_at`             | timestamptz | not null                                                             |
| `created_by`             | text        | WorkOS user ID or deleted-user tombstone                             |
| `updated_by`             | text        | WorkOS user ID or deleted-user tombstone                             |
| `version`                | integer     | not null, default 1; optimistic-lock counter                         |

UNIQUE constraint: `(app_id, created_by, create_idempotency_key)`. An exact-key retry returns the
stored response; different intent returns `IDEMPOTENCY_KEY_CONFLICT`.

### `event_definitions` (App-level)

Event Definitions are shared by every Environment in one App. The stable `name` is the
developer-facing event name. The client names it but cannot choose a version. `family` is selected
once and cannot be updated.

| Column                         | Type        | Constraints                                                                           |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `id`                           | text        | PK                                                                                    |
| `app_id`                       | text        | FK → apps, not null                                                                   |
| `name`                         | text        | not null, unique per `(app_id)`                                                       |
| `family`                       | text        | not null; immutable `metric \| web`                                                   |
| `display_name`                 | text        | not null                                                                              |
| `description`                  | text        | nullable                                                                              |
| `state`                        | text        | not null; `draft \| incomplete \| published`                                          |
| `current_published_version_id` | text        | nullable, FK → event_definition_versions; must belong to this definition and `app_id` |
| `created_at`                   | timestamptz | not null                                                                              |
| `updated_at`                   | timestamptz | not null                                                                              |
| `created_by`                   | text        | WorkOS user ID or deleted-user tombstone                                              |
| `updated_by`                   | text        | WorkOS user ID or deleted-user tombstone                                              |

`published` requires a non-null `current_published_version_id`; `draft` and `incomplete` require
null. Migration 0019 uses `incomplete` for a legacy Metric Event binding because the source row has
neither an Entity type nor a numeric domain. It creates no Event Definition Version. The operator's
first complete publish creates Version 1.

### `event_definition_versions` (immutable after creation)

Creating a version and advancing `current_published_version_id` is one D1 transaction. There is no
UPDATE or independent DELETE path for a published version. App deletion removes definitions and
versions only after the normal App data purge has removed dependent Metric Event and Web Event rows.

| Column                | Type        | Constraints                                                      |
| --------------------- | ----------- | ---------------------------------------------------------------- |
| `id`                  | text        | PK                                                               |
| `app_id`              | text        | FK → apps, not null                                              |
| `event_definition_id` | text        | FK → event_definitions, not null; must match this row's `app_id` |
| `version`             | integer     | not null, positive, unique per `(event_definition_id)`           |
| `entity_type`         | text        | nullable only for anonymous-only `web` Event Definition Versions |
| `fields`              | text        | not null; JSON `EventFieldDefinition[]`                          |
| `dimensions`          | text        | not null; JSON `DimensionDefinition[]`                           |
| `schema_hash`         | text        | not null; SHA-256 of canonical Entity/field/Dimension contract   |
| `published_at`        | timestamptz | not null; also the immutable creation timestamp                  |
| `published_by`        | text        | WorkOS user ID or deleted-user tombstone                         |

UNIQUE constraints: `(event_definition_id, version)` and `(event_definition_id, schema_hash)`.
Every repository query carries `app_id` first even when it also has `event_definition_id`.

The Worker rejects null `entity_type` for a `metric` parent. For a `web` parent, null prohibits Entity
identity; a non-null value permits anonymous events or a matching optional identity pair. The
explicit nullable value participates in `schema_hash`.

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
| `segment_id`         | text        | nullable; same-App FK → segments, restrictive delete            |
| `variant_id`         | text        | FK → variants                                                   |
| `percentage_rollout` | text        | nullable (JSON PercentageRollout)                               |
| `created_at`         | timestamptz | not null                                                        |
| `updated_at`         | timestamptz | not null                                                        |

`conditions` may be empty only when `segment_id` is present. Publication resolves the Segment and
AND-merges its Conditions with this direct array; the authoring reference remains in D1 across
Promotion. The composite `(app_id, segment_id)` foreign key prevents cross-App references and blocks
deletion while a live Flag Configuration depends on the Segment.

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

UNIQUE constraint: `(app_id, id)`, the parent key for same-App Targeting Rule references.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
