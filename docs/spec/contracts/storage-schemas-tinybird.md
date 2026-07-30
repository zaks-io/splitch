# Storage schemas: Tinybird datasources

Tinybird datasource schemas (append-only; raw rows never mutated).

Storage shapes carry internals (dedup keys, audit) that wire shapes must not expose. Exposure,
Metric Event, Web Event, and audit datasources are append-only workloads. (ADR-0025 "reuse at the
leaf, not the envelope".)

---

## Tinybird datasources (append-only; raw rows never mutated)

### `raw_events` (raw log)

Primary engine sorting key: `(app_id, environment_id, experiment_id, run_id, server_received_at, targeting_key_hash)` —
`app_id` first for multi-tenant isolation; `environment_id` co-scoped (ADR-0027); `run_id` for first-touch grouping within a Run.

| Column               | Type                    | Notes                                                                                                                                                                                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedup_key`          | String                  | Wire-level sha256 idempotency key for at-least-once ingest; hashes `type`, identity fields, `source_id`, and `event_id`; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `app_id`             | String                  | Isolation; always first in WHERE                                                                                                                                                                                          |
| `environment_id`     | String                  | Co-scoped with `app_id`; Exposures are per-Environment (ADR-0027)                                                                                                                                                         |
| `experiment_id`      | String                  | —                                                                                                                                                                                                                         |
| `run_id`             | String                  | Stamped at SDK fire-time from the resolved live Run                                                                                                                                                                       |
| `id_type`            | String                  | Entity type; part of Assignment Store key                                                                                                                                                                                 |
| `targeting_key_hash` | String                  | HMAC-derived Entity identifier; raw Targeting Key is not persisted                                                                                                                                                        |
| `variant`            | Nullable(String)        | Variant name (not id) on Exposure rows; NULL on Activation rows                                                                                                                                                           |
| `type`               | LowCardinality(String)  | `'exposure'` or `'activation'`                                                                                                                                                                                            |
| `event_id`           | String                  | Retry-stable physical raw-row id                                                                                                                                                                                          |
| `counterfactual`     | UInt8                   | 0/1; reserved for future counterfactual triggering                                                                                                                                                                        |
| `source_id`          | String                  | Edge POP identifier; component of the wire `dedup_key`                                                                                                                                                                    |
| `client_timestamp`   | DateTime64(3)           | SDK fire time; diagnostic only                                                                                                                                                                                            |
| `server_received_at` | DateTime64(3)           | Server-received event timestamp; used for `MIN` first-touch                                                                                                                                                               |
| `ingest_ts`          | DateTime64(3)           | Raw-log append watermark; used by snapshot/tail only                                                                                                                                                                      |
| `activation_ts`      | Nullable(DateTime64(3)) | Activation timestamp; equals `server_received_at` for server-received activations                                                                                                                                         |
| `is_holdover`        | UInt8                   | Exposure rows only; 0 on Activation rows                                                                                                                                                                                  |
| `sdk_version`        | Nullable(String)        | SDK version; diagnostics only                                                                                                                                                                                             |

First-touch identity (query-time): the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`
resolved by `MIN(server_received_at)` — the earliest determines the first-touch winner. This is
distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key). Wire
`dedup_key` construction lives in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

The `type` column discriminates Exposures from Activations on the same log. Activations additionally
carry `counterfactual = 0` by default; future counterfactual triggering sets `counterfactual = 1` with
no schema change. (ADR-0013.)

### `metric_events` (Metric Event log)

Metric Events live in their own datasource. They do not add a discriminator to `raw_events` and
cannot enter first-touch Exposure dedup.

Primary sorting key:
`(app_id, environment_id, event_definition_id, server_received_at, id_type, targeting_key_hash)`.

| Column                        | Type                   | Notes                                                               |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `dedup_key`                   | String                 | SHA-256 over App, Environment, and caller-stable `event_id`         |
| `event_id`                    | String                 | Validated caller-stable UUID logical fact/retry ID                  |
| `app_id`                      | String                 | Isolation; injected from credential; always first in WHERE          |
| `environment_id`              | String                 | Co-scoped with `app_id`; injected from credential                   |
| `event_definition_id`         | String                 | Resolved App-level Event Definition                                 |
| `event_definition_version_id` | String                 | Immutable version that validated and accepted the row               |
| `event_name`                  | String                 | Denormalized stable Event Definition name                           |
| `id_type`                     | LowCardinality(String) | Validated against the accepting Event Definition Version            |
| `targeting_key_hash`          | String                 | App-salt HMAC; raw Targeting Key is not persisted                   |
| `fields`                      | String                 | Canonical JSON object validated against declared named typed fields |
| `dimensions`                  | String                 | Canonical JSON object validated against declared scalar Dimensions  |
| `server_received_at`          | DateTime64(3)          | Canonical Metric Event time                                         |
| `ingest_ts`                   | DateTime64(3)          | Raw append watermark                                                |

The datasource configures `dedup_key` as its Tinybird deduplication key. The sharded ingest
idempotency seam rejects a reused `event_id` with a different canonical payload before append.
Accepted rows are retained for the configured replay window, default 90 days, and must never expire
before the longest promised Conversion Window or analysis replay window.

### `web_events` (Web Event log)

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
| `targeting_key_hash`          | Nullable(String)                 | App-salt HMAC; null for anonymous events                                       |
| `fields`                      | String                           | Canonical JSON validated against declared named typed fields                   |
| `dimensions`                  | String                           | Canonical JSON validated against declared scalar Dimensions                    |
| `server_received_at`          | DateTime64(3)                    | Canonical Web Event time                                                       |
| `ingest_ts`                   | DateTime64(3)                    | Raw append watermark                                                           |

The datasource configures `dedup_key` as its Tinybird deduplication key. Reusing an `event_id` with
different canonical content fails before append. Trace context is correlation metadata only;
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
| `changes`       | String                 | JSON; before/after snapshot or description                                    |
| `timestamp`     | DateTime               | Event time                                                                    |

Approval audit rows use this existing `audit_log` datasource, not a new datasource. The minimum
projection is the ordinary `app_id`, `user_id`, `auth_method`, `action`, `resource_type`,
`resource_id`, and `timestamp`, with `changes` carrying:

```
{
  approval_request_id: string,
  review_id: string | null,
  review_action: 'approve_and_apply' | 'decline' | null,
  outcome: 'pending' | 'applied' | 'declined' | 'stale' | 'failed',
  target_version: string,
  resulting_target_version: string | null,
  error_code: ErrorCode | null
}
```

`resource_type` is `approval_request`; `resource_id` is the Approval Request ID. D1 remains
canonical. Emitting these post-commit Approval audit rows through the D1-to-Tinybird bridge is
forward-referenced here and implemented by the separately tracked bridge work.

Not in D1 — unbounded, append-only workload fits Tinybird (ADR-0018). Audit reads must apply the
deleted-user tombstone rules in [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md).

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
