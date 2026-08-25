# Storage map: which data lives where and why

Canonical mapping of all persistent data to Cloudflare/Tinybird primitives. An implementing agent
must not move data between stores without a new ADR.

## Store assignments (by concern)

| Concern                                                                                                           | Store                                   | Why                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Users, Organizations, Apps, membership, roles                                                                     | D1                                      | Relational, bounded, low-write OLTP                                                                                      |
| SDK credentials (API Key hash/scopes/revoked; Client Key record)                                                  | D1                                      | Relational, per-`(app_id, environment_id)` record (ADR-0027)                                                             |
| Billing (plan, Stripe subscription linkage)                                                                       | D1                                      | Relational, bounded                                                                                                      |
| Privacy request ledger and Entity deletion tombstones                                                             | D1                                      | Bounded control-plane workflow state; immediate analysis exclusion                                                       |
| Convex installations, encrypted webhook secrets, and pending config nudges                                        | D1                                      | Same-transaction config commit outbox, bounded retries, and integration lifecycle                                        |
| Flag definition (App-level) + Flag Configuration + live Experiment config per Environment (including `liveRunId`) | D1 (authoritative) + KV (read cache)    | D1 = truth, KV = edge-local ~10ms reads                                                                                  |
| Session validity cache                                                                                            | KV                                      | Hot-path per-request, write-through from D1 on revoke                                                                    |
| API Key validation cache (hash → `{app_id, environment_id}`/scopes/validity)                                      | KV                                      | Hot-path per-SDK-call; `environment_id` resolves which Env's config to serve (ADR-0027); write-through from D1 on revoke |
| Assignment Store (holdover sticky experience)                                                                     | KV (read) + DO (first-touch write)      | See [assignment-store-substrate.md](./assignment-store-substrate.md)                                                     |
| Per-App live-update fan-out                                                                                       | DO (one per App, `idFromName(appId)`)   | Serialized write + WebSocket broadcast                                                                                   |
| Telemetry claims, accepted outboxes, write-ahead attempts, and poison/reconciliation state                        | Sharded Durable Objects                 | Durable acceptance and unknown-outcome recovery before Queue/Tinybird acknowledgement                                    |
| Four telemetry delivery streams and matching DLQs                                                                 | Cloudflare Queues                       | Family isolation, bounded microbatching, backpressure, and manual repair                                                 |
| Raw Exposure log (system of record for analysis)                                                                  | Tinybird datasource (append-only)       | Columnar, unbounded, ELT substrate                                                                                       |
| Raw Metric Event and Web Event logs                                                                               | Separate Tinybird datasources           | Strict family schemas, independent retention, append-only replay truth                                                   |
| First-touch dedup snapshot                                                                                        | Tinybird datasource (Copy Pipe target)  | Lambda architecture (ADR-0024)                                                                                           |
| Activation, Metric, and Web serving states                                                                        | Tinybird AggregatingMergeTree targets   | `minMerge`/`argMinMerge` after tenant/time pruning; no physical-log request-time scans                                   |
| Exposure SRM/activation rollups                                                                                   | Tinybird replace-mode Copy Pipe targets | Ordered after successful snapshot; never append from raw retries or snapshot replacement                                 |
| Audit log (who/what/when)                                                                                         | Tinybird datasource                     | Append-only, unbounded; wrong shape for D1                                                                               |
| Ops telemetry (request rates, error counts)                                                                       | Analytics Engine                        | Sampled/lossy by design — fine for non-critical ops metrics                                                              |

## Critical exclusions

- **Analytics Engine is never used for Exposure or experiment data.** It is sampled (lossy by design),
  short-retention, and its query surface cannot run first-touch dedup math on complete data.
- **Exposure rollups are never materialized views over raw or replace-mode snapshot sources.** A
  materialized view fires per inserted block and does not retract prior target state when its source
  is replaced. Ordered replace-mode Copy Pipes rebuild rollups from each successful deduped snapshot.
- **Tinybird is never queried directly by clients or agents.** All analytics reads proxy through a
  control-plane endpoint that injects `app_id` from auth context. See [multi-tenant-isolation.md](./multi-tenant-isolation.md).
- **Raw Targeting Keys never live in durable Entity stores.** KV keys, DO names, Tinybird rows, and
  logs use `targeting_key_hash` as defined in [privacy-data-lifecycle.md](./privacy-data-lifecycle.md).

## No internal config-copy seam

Editing and serving use one ordered D1-to-KV path. A config write goes:
`Worker validates → per-App DO commits authoritative D1 state → DO projects the committed version to KV → DO broadcasts delta-nudge to subscribers`.
D1 remains committed if the KV projection fails, and reads rebuild that projection from D1. There is
no separate Convex configuration copy inside Splitch. Rejecting Convex as Splitch's reactive serving
layer specifically deleted that second configuration source (ADR-0017).

The customer-installed Convex Component is an external data-plane adapter, not Splitch's serving
store. It pulls a validated snapshot after a signed nudge. D1 and KV remain authoritative, and the
component never writes configuration back to Splitch.

## D1 size ceiling

D1's ceiling is a non-issue by construction: the only unbounded table (audit log) routes to Tinybird.
D1 holds bounded mutable records only.

## Usage counters

Authoritative high-frequency usage counters for billing metering live in an exact Durable Object
counter and are written to D1 only as periodic rollups. Analytics Engine may mirror usage for
reporting and forecasting, but it is sampled/lossy and must not be authoritative for quota, debt,
credit burn, or enforcement. The billing contract is pinned in ADR-0033.

## Sources

- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [privacy-data-lifecycle.md](./privacy-data-lifecycle.md)
