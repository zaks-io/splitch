# Storage map: which data lives where and why

Canonical mapping of all persistent data to Cloudflare/Tinybird primitives. An implementing agent
must not move data between stores without a new ADR.

## Store assignments (by concern)

| Concern | Store | Why |
|---|---|---|
| Users, Organizations, Apps, membership, roles | D1 | Relational, bounded, low-write OLTP |
| SDK credentials (API Key hash/scopes/revoked; Client Key record) | D1 | Relational, per-`(app_id, environment_id)` record (ADR-0027) |
| Billing (plan, Stripe subscription linkage) | D1 | Relational, bounded |
| Flag definition (App-level) + Flag Configuration + live Experiment config per Environment (including `liveRunId`) | D1 (authoritative) + KV (read cache) | D1 = truth, KV = edge-local ~10ms reads |
| Session validity cache | KV | Hot-path per-request, write-through from D1 on revoke |
| API Key validation cache (hash → `{app_id, environment_id}`/scopes/validity) | KV | Hot-path per-SDK-call; `environment_id` resolves which Env's config to serve (ADR-0027); write-through from D1 on revoke |
| Assignment Store (holdover sticky experience) | KV (read) + DO (first-touch write) | See [assignment-store-substrate.md](./assignment-store-substrate.md) |
| Per-App live-update fan-out | DO (one per App, `idFromName(appId)`) | Serialized write + WebSocket broadcast |
| Raw Exposure log (system of record for analysis) | Tinybird datasource (append-only) | Columnar, unbounded, ELT substrate |
| First-touch dedup snapshot | Tinybird datasource (Copy Pipe target) | Lambda architecture (ADR-0024) |
| Metric rollup materialized views | Tinybird AggregatingMergeTree MVs (on snapshot, never raw log) | Correctness constraint: raw log has edge duplicates |
| Audit log (who/what/when) | Tinybird datasource | Append-only, unbounded; wrong shape for D1 |
| Ops telemetry (request rates, error counts) | Analytics Engine | Sampled/lossy by design — fine for non-critical ops metrics |

## Critical exclusions

- **Analytics Engine is never used for Exposure or experiment data.** It is sampled (lossy by design),
  short-retention, and its query surface cannot run first-touch dedup math on complete data.
- **Metric rollup MVs never build off the raw Exposure log** — a materialized view fires per inserted
  block and cannot see merged cross-block state, so edge duplicates (ADR-0004) leak into rollups
  and silently inflate SRM denominators and metric counts. Rollups build on the deduped snapshot only.
- **Tinybird is never queried directly by clients or agents.** All analytics reads proxy through a
  control-plane endpoint that injects `app_id` from auth context. See [multi-tenant-isolation.md](./multi-tenant-isolation.md).

## No separate config-copy seam

Editing and serving share KV/D1 directly. A config write goes:
`Worker validates → per-App DO commits KV/D1 → DO broadcasts delta-nudge to subscribers`.
There is no cross-system copy step. Rejecting Convex as a reactive layer specifically deleted this
class of seam (ADR-0017).

## D1 size ceiling

D1's ceiling is a non-issue by construction: the only unbounded table (audit log) routes to Tinybird.
D1 holds bounded mutable records only.

## Usage counters

High-frequency usage counters (for billing metering) live in a Durable Object counter or Analytics
Engine. Written to D1 only as periodic rollups. This is a billing-build detail, not re-litigable here.

## Sources

- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
