# Storage schemas: Tinybird datasources

Tinybird datasource schemas (append-only; raw rows never mutated).

Storage shapes carry internals (dedup keys, audit) that wire shapes must not expose. The exposures and
audit_log datasources are unbounded append-only workloads. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## Tinybird datasources (append-only; raw rows never mutated)

### `raw_events` (raw log)

Primary engine sorting key: `(app_id, environment_id, experiment_id, run_id, server_received_at, targeting_key_hash)` —
`app_id` first for multi-tenant isolation; `environment_id` co-scoped (ADR-0027); `run_id` for first-touch grouping within a Run.

| Column               | Type                   | Notes                                                                                                                                                                                                                     |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedup_key`          | String                 | Wire-level sha256 idempotency key for at-least-once ingest; hashes `type`, identity fields, `source_id`, and `event_id`; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `app_id`             | String                 | Isolation; always first in WHERE                                                                                                                                                                                          |
| `environment_id`     | String                 | Co-scoped with `app_id`; Exposures are per-Environment (ADR-0027)                                                                                                                                                         |
| `experiment_id`      | String                 | —                                                                                                                                                                                                                         |
| `run_id`             | String                 | Stamped at SDK fire-time from the resolved live Run                                                                                                                                                                       |
| `id_type`            | String                 | Entity type; part of Assignment Store key                                                                                                                                                                                 |
| `targeting_key_hash` | String                 | HMAC-derived Entity identifier; raw Targeting Key is not persisted                                                                                                                                                        |
| `variant`            | Nullable(String)       | Variant name (not id) on Exposure rows; NULL on Activation rows                                                                                                                                                           |
| `type`               | LowCardinality(String) | `'exposure'` or `'activation'`                                                                                                                                                                                            |
| `event_id`           | String                 | Retry-stable physical raw-row id                                                                                                                                                                                          |
| `counterfactual`     | UInt8                  | 0/1; reserved for future counterfactual triggering                                                                                                                                                                        |
| `source_id`          | String                 | Edge POP identifier; component of the wire `dedup_key`                                                                                                                                                                    |
| `client_timestamp`   | DateTime               | SDK fire time; diagnostic only                                                                                                                                                                                            |
| `server_received_at` | DateTime               | Server-received event timestamp; used for `MIN` first-touch                                                                                                                                                               |
| `ingest_ts`          | DateTime               | Raw-log append watermark; used by snapshot/tail only                                                                                                                                                                      |
| `activation_ts`      | Nullable(DateTime)     | Activation timestamp; equals `server_received_at` for server-received activations                                                                                                                                         |
| `is_holdover`        | UInt8                  | Exposure rows only; 0 on Activation rows                                                                                                                                                                                  |

First-touch identity (query-time): the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`
resolved by `MIN(server_received_at)` — the earliest determines the first-touch winner. This is
distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key). Wire
`dedup_key` construction lives in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

The `type` column discriminates Exposures from Activations on the same log. Activations additionally
carry `counterfactual = 0` by default; future counterfactual triggering sets `counterfactual = 1` with
no schema change. (ADR-0013.)

### `audit_log` (Tinybird, unbounded append)

| Column          | Type                   | Notes                                                                |
| --------------- | ---------------------- | -------------------------------------------------------------------- |
| `audit_id`      | String                 | UUID                                                                 |
| `app_id`        | String                 | Isolation; always first in WHERE                                     |
| `user_id`       | String                 | Actor                                                                |
| `auth_method`   | LowCardinality(String) | `'id_jag' \| 'device_flow' \| 'anonymous'` — "which door" (ADR-0022) |
| `action`        | String                 | e.g. `'create_flag'`, `'patch_run'`, `'revoke_credential'`           |
| `resource_type` | LowCardinality(String) | `'flag' \| 'run' \| 'experiment' \| 'metric' \| 'credential' \| ...` |
| `resource_id`   | String                 | —                                                                    |
| `changes`       | String                 | JSON; before/after snapshot or description                           |
| `timestamp`     | DateTime               | Event time                                                           |

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
