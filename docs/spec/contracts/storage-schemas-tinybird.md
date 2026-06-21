# Storage schemas: Tinybird datasources

Tinybird datasource schemas (append-only; raw rows never mutated).

Storage shapes carry internals (dedup keys, audit) that wire shapes must not expose. The exposures and
audit_log datasources are unbounded append-only workloads. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## Tinybird datasources (append-only; raw rows never mutated)

### `exposures` (raw log)

Primary engine sorting key: `(app_id, run_id, id_type, server_received_at)` — `app_id` first for
multi-tenant isolation; `run_id` for first-touch grouping within a Run.

| Column | Type | Notes |
|---|---|---|
| `dedup_key` | String | Wire-level sha256 idempotency key for at-least-once ingest; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `app_id` | String | Isolation; always first in WHERE |
| `experiment_id` | String | — |
| `run_id` | String | Stamped at SDK fire-time from the resolved live Run |
| `id_type` | String | Entity type; part of Assignment Store key |
| `targeting_key` | String | Entity identifier |
| `variant_name` | String | Variant name (not id) |
| `type` | LowCardinality(String) | `'exposure'` or `'activation'` |
| `counterfactual` | UInt8 | 0/1; reserved for future counterfactual triggering |
| `source_id` | String | Edge POP identifier; component of the wire `dedup_key` |
| `client_timestamp` | DateTime | SDK fire time; diagnostic only |
| `server_received_at` | DateTime | Canonical ingest time; used for `MIN` first-touch |

First-touch identity (query-time): the tuple `(app_id, experiment_id, run_id, id_type, targeting_key)`
resolved by `MIN(server_received_at)` — the earliest determines the first-touch winner. This is
distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key). Wire
`dedup_key` construction lives in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

The `type` column discriminates Exposures from Activations on the same log. Activations additionally
carry `counterfactual = 0` by default; future counterfactual triggering sets `counterfactual = 1` with
no schema change. (ADR-0013.)

### `audit_log` (Tinybird, unbounded append)

| Column | Type | Notes |
|---|---|---|
| `audit_id` | String | UUID |
| `app_id` | String | Isolation; always first in WHERE |
| `user_id` | String | Actor |
| `auth_method` | LowCardinality(String) | `'id_jag' \| 'device_flow' \| 'anonymous'` — "which door" (ADR-0022) |
| `action` | String | e.g. `'create_flag'`, `'patch_run'`, `'revoke_credential'` |
| `resource_type` | LowCardinality(String) | `'flag' \| 'run' \| 'experiment' \| 'metric' \| 'credential' \| ...` |
| `resource_id` | String | — |
| `changes` | String | JSON; before/after snapshot or description |
| `timestamp` | DateTime | Event time |

Not in D1 — unbounded, append-only workload fits Tinybird (ADR-0018).

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
