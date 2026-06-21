# Per-App live-update DO: fan-out, write-through, delta-nudge

One Durable Object per App serializes config writes and fans out delta-nudge signals to subscribed
control-panel WebSocket clients.

## DO identity and isolation

- DO name: `idFromName(appId)` — one DO per App
- A WebSocket connection authenticated to App X can attach only to `DO(X)`. This extends the
  `app_id` isolation boundary (ADR-0018) to the live-update channel.

## Transport: Hibernating WebSocket (ADR-0019)

WebSocket with DO Hibernation API. While the WebSocket is idle, the DO evicts from memory and
billable Duration (GB-s) stops accruing. The edge holds the socket and re-wakes the DO on the
next message. SSE was rejected because SSE has no DO hibernation — it keeps the DO resident and
billing for the full connection duration.

## Write-through-the-DO

All config writes route through the per-App DO:

```
Config-write Worker
  → DO(appId).write(configDelta)
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

The DO never learns the config schema. Clients do not apply the delta. On receiving a nudge, the
client:

1. Checks if `nudge.version <= cached_version` — if so, skip (self-edit, already have this state)
2. Invalidates the matching TanStack Query cache key via the query-key factory
3. Refetches from the read API

## Reconnect recovery

On WebSocket reconnect, the client triggers a full invalidate-and-refetch (same path the loader
runs). No delta-replay log, no last-seen-version bookkeeping. A missed broadcast during a
reconnect window self-heals with one refetch.

## Scope

Live-update DO covers **config/operational state only** — Flag edits, Experiment edits, Run state
transitions (draft → running → ended), enabled/disabled toggles. It does **not** cover live
experiment statistics (Exposure counts, p-values, CIs) — those live in Tinybird and are a separate
mechanism.

## Seam contract

| Side                          | Responsibility                                                   |
| ----------------------------- | ---------------------------------------------------------------- |
| Config-write Worker (caller)  | Passes validated input to DO; surfaces DO error to user          |
| DO (this seam)                | Validates invariants, commits to D1, writes KV, broadcasts nudge |
| WebSocket client (subscriber) | Receives nudge, invalidates Query cache key, refetches           |
| TanStack Query cache          | Sole synced server-state store; authoritative after refetch      |

**Failure contract:** if D1 commit fails → error returned to Worker → no KV write, no broadcast,
caller retries. If KV write fails after D1 commit → KV miss self-heals via D1 fallback on next
read. If broadcast fails → clients recover on reconnect via full refetch.

## Sources

- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../architecture/frontend-architecture.md](../../architecture/frontend-architecture.md)
