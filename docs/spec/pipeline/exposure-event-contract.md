# Exposure event contract — raw row shape on the append-only log

Every Exposure and Activation event appended to the unified raw log must conform to this contract. The raw log is the system of record (ADR-0010); shape changes here cascade to every downstream consumer.

## Unified Exposure/Activation event log

One Tinybird datasource (`raw_events`) holds Exposure and Activation row types. The `type`
discriminator distinguishes those two types. Metric Events use the separate `metric_events`
datasource and contract; Web Events use another separate family. A peek or test-evaluation
(dry-run) MUST NOT write any row because those paths never touch ingest.

## Exposure row (`type = 'exposure'`)

| Field                | Type            | Required | Meaning                                                                                                                                                                           |
| -------------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `'exposure'`    | yes      | Row discriminator                                                                                                                                                                 |
| `app_id`             | `string`        | yes      | Data-isolation key; injected by the Evaluation Worker, never from the client                                                                                                      |
| `environment_id`     | `string`        | yes      | Co-scoped with `app_id`; Exposures are per-Environment (ADR-0027). Injected by the Evaluation Worker, never from the client                                                       |
| `experiment_id`      | `string`        | yes      | Stable identifier of the Experiment                                                                                                                                               |
| `run_id`             | `string`        | yes      | Stamped at SDK fire-time from the live Run config in KV; the live `liveRunId` the Evaluation Worker read when it evaluated                                                        |
| `id_type`            | `string`        | yes      | Request `idType` after validation against the Run's declared Entity type (e.g. `'user'`, `'workspace'`); guards holdover DO key                                                   |
| `targeting_key_hash` | `string`        | yes      | HMAC-derived Entity identifier; computed from the Targeting Key, never client-supplied                                                                                            |
| `variant`            | `string`        | yes      | The Variant name (string, never the value/metadata) assigned to this Entity                                                                                                       |
| `event_id`           | `string`        | yes      | Retry-stable physical event id generated once when the Worker creates this raw row                                                                                                |
| `exposure_at`        | `DateTime64(3)` | yes      | Canonical encounter time. Remote Evaluation uses `server_received_at`; a verified trusted adapter may supply a bounded durable commit timestamp (ADR-0049)                        |
| `server_received_at` | `DateTime64(3)` | yes      | Timestamp when Splitch durably accepts the Exposure request; delivery diagnostics and retention, not encounter ordering                                                           |
| `ingest_ts`          | `DateTime64(3)` | yes      | Tinybird-assigned physical insertion timestamp; used only for snapshot/tail watermarks, never for analysis ordering                                                               |
| `client_timestamp`   | `DateTime64(3)` | no       | Client-fired timestamp; carried for diagnostics only, never used for ordering                                                                                                     |
| `dedup_key`          | `string`        | yes      | Idempotent at-least-once key; see Dedup Key section below                                                                                                                         |
| `source_id`          | `string`        | yes      | Edge POP identifier (e.g. `'sea01'`); included in `dedup_key`                                                                                                                     |
| `sdk_version`        | `string`        | no       | SDK version string; diagnostics                                                                                                                                                   |
| `is_holdover`        | `boolean`       | yes      | `true` when the edge replayed the stored Variant (not a fresh `assign()`); `false` for first-touch and new Entities. Enables pipeline to verify SDK honored the holdover contract |

### Dedup key definition

```
dedup_key = sha256(type + ':' + app_id + ':' + experiment_id + ':' + run_id + ':' + id_type + ':' + targeting_key_hash + ':' + source_id + ':' + event_id)
```

- `type` is part of the key so an Exposure and Activation for the same Entity in the same millisecond cannot collide in the unified log.
- `event_id` is generated once when the raw row is created and reused on retry, so at-least-once delivery is idempotent even if a retry happens later.
- `source_id` (POP hostname) makes same-Entity, same-ms events from different POPs distinct.
- `exposure_at` and `server_received_at` are not part of the key; timestamps do not define wire-level idempotency.
- New fields do NOT change this key — schema-stable by construction.
- The datasource carries a Splitch `DEDUP_KEY` contract marker for repository validation. Tinybird
  does not interpret that comment or enforce uniqueness; the serving dedup layer remains authoritative.

### Idempotency invariant

The dedup key is for wire-level ingest deduplication only. The first-touch dedup (query-time `GROUP BY` over the first-touch identity tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)` + `MIN(exposure_at)`) is the **authoritative** first-touch definition and supersedes it. `environment_id`, `experiment_id`, and `id_type` are functionally determined by `run_id` (a Run belongs to exactly one Experiment in exactly one Environment with one declared Entity type); they are carried through the grouping, not independent keys. `environment_id` is intentionally **not** part of the wire `dedup_key` for the same reason — it adds nothing to per-row idempotency. Two rows with different `dedup_key` values for the same `(targeting_key_hash, run_id)` are expected — the query picks `MIN(exposure_at)` among them.

## Activation row (`type = 'activation'`)

| Field                | Type            | Required | Meaning                                                                                                |
| -------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `type`               | `'activation'`  | yes      | Row discriminator                                                                                      |
| `app_id`             | `string`        | yes      | Data-isolation key                                                                                     |
| `environment_id`     | `string`        | yes      | Co-scoped with `app_id`; per-Environment (ADR-0027)                                                    |
| `experiment_id`      | `string`        | yes      | Experiment this activation belongs to                                                                  |
| `run_id`             | `string`        | yes      | Run under which the activation occurred                                                                |
| `id_type`            | `string`        | yes      | Must match the Run's declared `id_type`                                                                |
| `targeting_key_hash` | `string`        | yes      | HMAC-derived Entity identifier                                                                         |
| `event_id`           | `string`        | yes      | Retry-stable physical event id generated once when the Worker creates this raw row                     |
| `exposure_at`        | `DateTime64(3)` | yes      | Canonical encounter time; equals `server_received_at` for server-received Activations                  |
| `server_received_at` | `DateTime64(3)` | yes      | Server-received-at timestamp; equals `activation_ts` for server-received activations                   |
| `ingest_ts`          | `DateTime64(3)` | yes      | Tinybird-assigned physical insertion timestamp; used only for snapshot/tail watermarks                 |
| `activation_ts`      | `DateTime64(3)` | yes      | When the activation event occurred (server-received-at)                                                |
| `dedup_key`          | `string`        | yes      | Same construction as Exposure dedup key                                                                |
| `source_id`          | `string`        | yes      | Edge POP identifier; included in `dedup_key`                                                           |
| `counterfactual`     | `boolean`       | yes      | `false` by default; `true` when emitted by the SDK counterfactual evaluation path (additive, ADR-0013) |

`ingest_ts` is required on every stored physical row but absent from the canonical producer, outbox,
and Queue payload. The `raw_events` datasource assigns it with `DEFAULT now64(3)` when Tinybird
inserts the row. Delayed Queue delivery and manual replay therefore receive their actual insertion
watermark instead of a stale pre-publication timestamp.

## Non-exposing paths

| Path                                            | Fires Exposure row?                  |
| ----------------------------------------------- | ------------------------------------ |
| `sdk.getVariant(...)` (standard evaluate)       | YES                                  |
| `sdk.peekVariant(...)` (distinct peek accessor) | NO — never touches ingest            |
| Convex component `evaluate` in a mutation       | YES — transactionally queued         |
| Convex component `peekVariant` in a query       | NO — component query cannot write    |
| Control-plane test-evaluation endpoint          | NO — never touches ingest (ADR-0026) |

The peek and test-evaluation paths are structurally separate from the ingest endpoint. There is no flag or parameter that suppresses logging on a shared path — the non-exposing paths simply do not call the ingest endpoint.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md) — fire-on-read, peek as distinct accessor
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — append-only log, at-least-once, idempotent dedup key
- [ADR-0013](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md) — activation as first-class row type, `counterfactual` marker
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — Tinybird physical ingest
- [ADR-0026](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md) — test-evaluation non-exposing
- [ADR-0049](../../adr/0049-convex-local-evaluation-uses-nudge-pull-sync-and-transactional-exposure-delivery.md) — trusted local encounter time
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [metric-event-contract.md](./metric-event-contract.md)
