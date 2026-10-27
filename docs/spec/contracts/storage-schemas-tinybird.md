# Storage schemas: Tinybird datasources

Tinybird datasource schemas (append-only; raw rows never mutated).

Storage shapes carry internals (dedup keys, audit) that wire shapes must not expose. Exposure,
Metric Event, Web Event, and audit datasources are append-only workloads. (ADR-0025 "reuse at the
leaf, not the envelope".)

---

## Tinybird datasources (append-only; raw rows never mutated)

### `raw_events` (raw log)

Primary engine partition key: `toYYYYMM(server_received_at)`. Sorting key:
`(app_id, environment_id, experiment_id, run_id, server_received_at,
targeting_key_hash)`. This preserves the deployed receipt-time layout during the additive
`exposure_at` rollout. `ingest_ts` remains the insertion watermark for snapshot/tail boundaries,
and current analysis consumers use `exposure_at` for first-touch and Activation ordering.

| Column               | Type                    | Notes                                                                                                                                                                                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedup_key`          | String                  | Wire-level sha256 idempotency key for at-least-once ingest; hashes `type`, identity fields, `source_id`, and `event_id`; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `app_id`             | String                  | Isolation; always first in WHERE                                                                                                                                                                                          |
| `environment_id`     | String                  | Co-scoped with `app_id`; Exposures are per-Environment (ADR-0027)                                                                                                                                                         |
| `experiment_id`      | String                  | —                                                                                                                                                                                                                         |
| `run_id`             | String                  | Stamped at SDK fire-time from the resolved live Run                                                                                                                                                                       |
| `id_type`            | String                  | Entity type; part of Assignment Store key                                                                                                                                                                                 |
| `targeting_key_hash` | String                  | HMAC-derived Entity identifier; raw Targeting Key is not persisted                                                                                                                                                        |
| `entity_family_hash` | String                  | Stable Entity-family identity; legacy/local forms normalize in the datasource default                                                                                                                                     |
| `variant`            | Nullable(String)        | Variant name (not id); current Activation producers retain the Exposure-backed name                                                                                                                                       |
| `type`               | LowCardinality(String)  | `'exposure'` or `'activation'`                                                                                                                                                                                            |
| `event_id`           | String                  | Retry-stable physical raw-row id                                                                                                                                                                                          |
| `counterfactual`     | UInt8                   | 0/1; reserved for future counterfactual triggering                                                                                                                                                                        |
| `source_id`          | String                  | Edge POP identifier; component of the wire `dedup_key`                                                                                                                                                                    |
| `client_timestamp`   | Nullable(DateTime64(3)) | Optional SDK fire time; diagnostic only                                                                                                                                                                                   |
| `exposure_at`        | DateTime64(3)           | Canonical encounter timestamp; defaults to `server_received_at`; used for first-touch and Conversion Windows                                                                                                              |
| `server_received_at` | DateTime64(3)           | Splitch durable-acceptance timestamp; delivery diagnostics and retention                                                                                                                                                  |
| `ingest_ts`          | DateTime64(3)           | Tinybird insertion watermark; `DEFAULT now64(3)` and omitted from NDJSON                                                                                                                                                  |
| `activation_ts`      | Nullable(DateTime64(3)) | Activation timestamp; equals `server_received_at` for server-received activations                                                                                                                                         |
| `is_holdover`        | UInt8                   | Exposure rows only; 0 on Activation rows                                                                                                                                                                                  |
| `sdk_version`        | Nullable(String)        | SDK version; diagnostics only                                                                                                                                                                                             |

First-touch identity (query-time): the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`
resolved by `MIN(exposure_at)` — the earliest encounter determines the first-touch winner. This is
distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key). Wire
`dedup_key` construction lives in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

The `type` column discriminates Exposures from Activations on the same log. Activations additionally
carry `counterfactual = 0` by default; future counterfactual triggering sets `counterfactual = 1` with
no schema change. (ADR-0013.)

### `deduped_activations_state` (planned derived Activation state)

This datasource, materialization and serving pipe are not present in `infra/tinybird` yet. Current
`analysis_activation_rows.pipe` reads `raw_events`, rejects pre-Exposure candidates and computes
first valid Activation membership. The paragraph below specifies the intended replacement.

`mv_deduped_activations_state` filters `raw_events` to Activation rows and writes
`minState(activation_ts)` into an `AggregatingMergeTree` target partitioned by activation event month.
Its sorting key begins `(app_id, environment_id, run_id, event_date, counterfactual, ...)`.

`serve_deduped_activations` requires injected App, Environment, exact Run, half-open event-date and
`activation_ts` bounds, and counterfactual policy before `minMerge`. It returns one logical candidate
per Entity, Run, counterfactual kind, and distinct Activation timestamp. Gated analysis and activation
rollups reject pre-Exposure candidates before selecting the earliest valid timestamp and never read
physical Activation rows from `raw_events`; late delivery remains visible in the original
activation-time partition.

### `metric_events` (Metric Event log)

Metric Events live in their own datasource. They do not add a discriminator to `raw_events` and
cannot enter first-touch Exposure dedup.

Primary sorting key:
`(app_id, environment_id, event_definition_id, server_received_at, id_type, targeting_key_hash)`.

| Column                        | Type                   | Notes                                                                 |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `dedup_key`                   | String                 | SHA-256 over App, Environment, and caller-stable `event_id`           |
| `event_id`                    | String                 | Validated caller-stable UUID logical fact/retry ID                    |
| `app_id`                      | String                 | Isolation; injected from credential; always first in WHERE            |
| `environment_id`              | String                 | Co-scoped with `app_id`; injected from credential                     |
| `event_definition_id`         | String                 | Resolved App-level Event Definition                                   |
| `event_definition_version_id` | String                 | Immutable version that validated and accepted the row                 |
| `event_name`                  | String                 | Denormalized stable Event Definition name                             |
| `id_type`                     | LowCardinality(String) | Validated against the accepting Event Definition Version              |
| `targeting_key_hash`          | String                 | Stable App Entity HMAC; raw Targeting Key is not persisted            |
| `entity_family_hash`          | String                 | Stable Entity-family identity; default normalizes legacy/local hashes |
| `fields`                      | String                 | Canonical JSON object validated against declared named typed fields   |
| `dimensions`                  | String                 | Canonical JSON object validated against declared scalar Dimensions    |
| `server_received_at`          | DateTime64(3)          | Canonical Metric Event time                                           |
| `ingest_ts`                   | DateTime64(6)          | Tinybird insertion time; `DEFAULT now64(6)` and omitted from NDJSON   |

Tinybird does not enforce uniqueness for `dedup_key`. The sharded ingest idempotency seam rejects a
reused `event_id` with different canonical content, while `serve_deduped_metric_events` applies
`argMinMerge` to `deduped_metric_events_state` and supplies one logical row per `dedup_key`. Accepted
raw rows and aggregate states are retained for the configured replay window, default 90 days, and
must never expire before the longest promised Conversion Window or analysis replay window.

### `web_events` (planned Web Event log)

The Web Event datasource, retry-state datasource and serving pipe below are unbuilt.

Web Events live in their own datasource. They do not add a discriminator to `raw_events` or
`metric_events` and never enter Experiment measurement.

Primary sorting key:
`(app_id, environment_id, capture_source, server_received_at, event_definition_id, session_id_hash)`.

| Column                        | Type                             | Notes                                                                          |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `dedup_key`                   | String                           | SHA-256 over family, App, Environment, and SDK-generated `event_id`            |
| `event_id`                    | String                           | SDK-generated logical fact/retry ID                                            |
| `app_id`                      | String                           | Isolation; injected from credential; always first in WHERE                     |
| `environment_id`              | String                           | Co-scoped with `app_id`; injected from credential                              |
| `event_definition_id`         | String                           | Resolved App-level Event Definition                                            |
| `event_definition_version_id` | String                           | Immutable version that validated and accepted the row                          |
| `event_name`                  | String                           | Denormalized stable Event Definition name                                      |
| `session_id_hash`             | String                           | App/Environment-scoped HMAC of the wire Web Session identifier                 |
| `capture_source`              | LowCardinality(String)           | Validated advisory source: `manual`, `page_view`, `web_vital`, `browser_error` |
| `sdk_version`                 | String                           | Validated bounded SemVer reported by the client                                |
| `trace_id`                    | Nullable(String)                 | Validated W3C trace ID; paired with `span_id`                                  |
| `span_id`                     | Nullable(String)                 | Validated W3C span ID; paired with `trace_id`                                  |
| `id_type`                     | Nullable(LowCardinality(String)) | Explicit Entity type; null for anonymous events                                |
| `targeting_key_hash`          | Nullable(String)                 | Stable App Entity HMAC; null for anonymous events                              |
| `fields`                      | String                           | Canonical JSON validated against declared named typed fields                   |
| `dimensions`                  | String                           | Canonical JSON validated against declared scalar Dimensions                    |
| `server_received_at`          | DateTime64(3)                    | Canonical Web Event time                                                       |
| `ingest_ts`                   | DateTime64(6)                    | Tinybird insertion time; `DEFAULT now64(6)` and omitted from NDJSON            |

Tinybird does not enforce uniqueness for `dedup_key`. Reusing an `event_id` with different canonical
content fails before append, while `serve_deduped_web_events` applies `argMinMerge` to
`deduped_web_events_state` and supplies one logical row per `dedup_key`. Trace context is correlation metadata only;
OpenTelemetry span status, duration, resource attributes, instrumentation scope, and arbitrary
attributes remain absent unless explicitly mapped into schema-governed `fields` or `dimensions`.
Accepted rows have an independent configurable retention, default 30 days. No Experiment Conversion
Window or replay requirement constrains this exploratory datasource. An immutable Event Definition
Version remains available while any retained row references it.

The sorting key keeps mandatory tenant scope first, then the low-cardinality capture source and
canonical query time used by every Web Analytics read. High-cardinality Event Definition and Web
Session identifiers follow those filters rather than blocking time-range data skipping.

### `audit_log` (Tinybird, unbounded append)

| Column          | Type                   | Notes                                                                         |
| --------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `audit_id`      | String                 | UUID                                                                          |
| `app_id`        | String                 | Isolation; always first in WHERE                                              |
| `user_id`       | String                 | Actor                                                                         |
| `auth_method`   | LowCardinality(String) | `'id_jag' \| 'device_flow' \| 'anonymous'` — "which door" (ADR-0022)          |
| `action`        | String                 | e.g. route `operationId`: `'flags_create'`, `'runs_end'`, `'api_keys_revoke'` |
| `resource_type` | LowCardinality(String) | `'flag' \| 'run' \| 'experiment' \| 'metric' \| 'credential' \| ...`          |
| `resource_id`   | String                 | —                                                                             |
| `changes`       | String                 | Canonical allowlisted event metadata (archive payloads are separate)          |
| `timestamp`     | DateTime64(3)          | Event time                                                                    |

The physical datasource also carries archive-only indexing and verification columns:
`dedup_key`, `archive_version`, `archived_d1_row_count`, `archive_checksum`, `request_status`,
`target_type`, `proposed_at`, `resolved_at`, and `policy_contexts`. Ordinary audit rows leave the
archive-only columns null. `archived_d1_row_count` counts the Request row plus every Review row in
the archive payload, not Tinybird rows. The sorting key begins with `app_id`; no read can select an
Approval Request archive before applying its App scope.

App-scoped ordinary audit rows use `audit_id = event_id` and `dedup_key = event_id` from the
D1 `control_plane_audit_events` outbox. `changes` contains canonical JSON:

```typescript
{
  environmentId: string | null,
  organizationId: string,
  targetVersion: string | null,
  outcome: 'committed' | 'pending' | 'applied' | 'declined' | 'stale' | 'failed',
  requestId: string | null,
  approvalRequestId: string | null,
  runId: string | null,
  metadata: {
    changedFields?: string[],
    reviewId?: string,
    reviewAction?: 'approve_and_apply' | 'decline',
    resultingTargetVersion?: string | null,
    errorCode?: string | null,
    role?: string,
    previousRole?: string,
    revokedKeyId?: string
  }
}
```

The [producer and delivery contract](../control-plane/d1-and-tinybird-data-access.md#tinybird-audit-log)
defines action coverage and existing retry semantics. The ordinary read deduplicates by `audit_id`
and rejects conflicting canonical content before filters and pagination. It excludes archive rows.
Unknown actor/auth attribution projects explicitly as `unattributed`, and deleted-user tombstone
references are preserved. Only allowlisted metadata enters the bridge, never raw diffs or secrets.

Terminal archival uses `action = 'approval_request.archive'`. Its `changes` value is the complete,
RFC 8785-canonical payload `{ archiveVersion, request, reviews }`; `reviews` is ordered by
`reviewed_at`, then Review ID. No field, diff, reason, error detail, or Review is truncated. The
stable deduplication identity is Approval Request ID plus archive version. The worker reads the
stored archive back and verifies version, `1 + reviews.length`, and the SHA-256 checksum of the
canonical payload before removing D1 rows. The append uses `wait=true` and succeeds only on a `200`
acknowledgment for exactly one successful row and zero quarantined rows. Replays with the same
identity and checksum are idempotent; a conflicting payload fails loud.

`audit_log` has no TTL. Ordinary events and Approval Request archives remain readable for at least 24 months or the
contracted audit period, whichever is longer. Archived read pipes preserve the Request wire
projection, require `app_id`, and apply the same deleted-user tombstone values carried by the
canonical audit rows.

The unbounded archive lives in Tinybird; ordinary mutation facts first commit in the bounded D1
`control_plane_audit_events` outbox (ADR-0018). Audit reads must apply the
deleted-user tombstone rules in [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md).

## Other implemented datasources and readers

| Datasource                              | Physical contract and consumers                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deduped_exposures`                     | MergeTree sorted by `(app_id, environment_id, experiment_id, run_id, variant, entity_family_hash)`; carries `id_type`, `targeting_key_hash`, `first_exposure_ts`, sticky `first_ingest_ts` and `activation_ingest_ts`, `snapshot_ts`, `watermark_ts`; COPY `cp_deduped_exposures` refreshes it; `serve_deduped_exposures` merges snapshot and raw tail |
| `deduped_metric_events_state`           | AggregatingMergeTree with `canonical_state AggregateFunction(argMin, Tuple(...), DateTime64(6))`; partition by event month, 90-day TTL; `materialize_deduped_metric_events` feeds `serve_deduped_metric_events`                                                                                                                                        |
| `run_snapshots`                         | MergeTree sorted by `(app_id, environment_id, experiment_id, started_at)`; freezes Run analysis config, Metric query/variance configs, Control identity, analysis version, target source, planned duration and pre-registration; `analysis_run_inputs` / `analysis_run_bootstrap` read it                                                              |
| `raw_evaluations`                       | MergeTree usage facts; `analysis_evaluation_usage` groups counts by Flag, SDK runtime, batch mode, source and Exposure state                                                                                                                                                                                                                           |
| `entity_deletions`                      | App/Entity deletion boundaries used by analysis exclusion and privacy reads                                                                                                                                                                                                                                                                            |
| `app_identity_generation_tombstones`    | App identity generation deletion boundaries used by privacy and analysis readers                                                                                                                                                                                                                                                                       |
| `environment_exposure_status_state`     | Aggregated Exposure health state from `materialize_environment_exposure_status`; read by `environment_exposure_status`                                                                                                                                                                                                                                 |
| `environment_exposure_status_deletions` | App/Environment deletion boundaries applied by the Exposure health read                                                                                                                                                                                                                                                                                |

Exact column and aggregate-state types live in `infra/tinybird/datasources/*.datasource`; serving,
analysis and privacy SQL live in `infra/tinybird/pipes/*.pipe`. No `web_*` files are deployed by the
current project.

## Sources

- [../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
