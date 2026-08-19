# Per-Environment live-update DO: fan-out, write-through, delta-nudge

One Durable Object per `(App, Environment)` serializes config writes and fans out delta-nudge
signals to subscribed control-panel clients and Evaluation Worker isolates.

## DO identity and isolation

- DO name: `getByName(appId + ":" + environmentId)`
- A connection authenticated to `(App X, Environment Y)` can attach only to `DO(X:Y)`. This
  extends the App and Environment isolation boundary (ADR-0018/0027) to the live-update channel.

## Transport: Hibernating WebSocket (ADR-0019)

WebSocket with DO Hibernation API. While the WebSocket is idle, the DO evicts from memory and
billable Duration (GB-s) stops accruing. The edge holds the socket and re-wakes the DO on the
next message. SSE was rejected because SSE has no DO hibernation — it keeps the DO resident and
billing for the full connection duration.

## Write-through-the-DO

All config writes route through the per-Environment DO:

```
Config-write Worker
  → DO(appId, environmentId).write(configDelta)
    → validate invariants (Run immutability, schema shape)
    → commit to D1
    → write-through to KV
    → broadcast delta-nudge to all subscribed WebSocket clients
  → return result to Worker
```

**Persisted-before-announced invariant:** the DO commits D1 and KV before broadcasting. If D1
commit fails, no broadcast occurs. A broadcast always describes state that is durable in D1.

The DO re-hibernates immediately after each config write (config writes are rare human clicks,
not high-frequency events).

## Broadcast payload (delta-nudge shape)

```
DeltaNudge {
  type:    'config.changed'          // required — discriminator
  entity:  'flag' | 'experiment' | 'run' | 'segment'  // required
  id:      string                    // required — entity id
  version: number                    // required — monotonic version for self-edit skip
}
```

The DO never sends config data. Clients do not apply the delta. On receiving a nudge:

1. Evaluation records the announced version and invalidates the matching Flag Configuration only.
2. Evaluation refetches the authoritative snapshot through the DO and rejects any version below
   the announcement as `STALE`.
3. The control panel invalidates its matching TanStack Query cache key and refetches from the API.

## Reconnect recovery

On reconnect, Evaluation invalidates the whole `(App, Environment)` cache and obtains current
committed versions before serving. The control panel triggers its existing full
invalidate-and-refetch. There is no delta-replay log.

## Scope

Live-update DO covers **config/operational state only** — Flag edits, Experiment edits, Run state
transitions (draft → running → ended), enabled/disabled toggles. It does **not** cover live
experiment statistics (Exposure counts, p-values, CIs) — those live in Tinybird and are a separate
mechanism.

## Seam contract

| Side                         | Responsibility                                                    |
| ---------------------------- | ----------------------------------------------------------------- |
| Config-write Worker (caller) | Passes validated input to DO; surfaces DO error to user           |
| DO (this seam)               | Validates invariants, commits to D1, writes KV, broadcasts nudge  |
| Evaluation subscriber        | Tracks version, invalidates Flag cache, reads current DO snapshot |
| Control-panel subscriber     | Invalidates Query cache key and refetches                         |
| Evaluation Flag cache        | Cross-request, version-aware cache scoped by App and Environment  |
| TanStack Query cache         | Control-panel synced server-state store                           |

**Failure contract:** if D1 commit fails → error returned to Worker → no KV write, no broadcast,
caller retries. If KV write fails after D1 commit → the authoritative DO read still serves the D1
snapshot and control-plane reads repair KV. If the subscriber cannot connect or cannot read at least
the announced version → Evaluation fails loud. A five-second lag emits a propagation breach with
App, Environment, announced version, served version, and elapsed time.

## Sources

- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../architecture/frontend-architecture.md](../../architecture/frontend-architecture.md)
