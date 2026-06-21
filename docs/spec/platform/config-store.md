# Config store: draft/live config, liveRunId, and write failure contract

The edge-serving config that Workers read and the authoring config editors write are the **same
KV/D1 store** — no separate config-copy seam (ADR-0017). This file pins what "live config" means, how
`liveRunId` is managed, and the failure contract for config writes.

## Live config shape (what the edge reads from KV)

KV key: `config:app:{appId}:{environmentId}:flag:{flagKey}` — Flag Configuration is per-Environment
(ADR-0027); the same Flag Key resolves to a distinct config per Environment.

```
AppFlagConfig {
  flagKey:       string          // required — Flag Key, unique within App
  environmentId: string          // required — owning Environment; config is per-Environment (ADR-0027)
  enabled:       boolean         // required — false → Default Variant for all Entities
  variants:      Variant[]       // required — full set; one is defaultVariant
  defaultVariant: string         // required — Variant name to return when no rule matches or disabled
  targetingRules: TargetingRule[] // ordered priority list; first match wins
  liveRunId:     string | null   // null if no started Experiment Run is controlling this Flag
  salt:          string          // required — stable hash salt for Fractional Evaluation
  schemaVersion: number          // required — KV envelope version; see [contracts-and-validation.md](./contracts-and-validation.md)
}
```

`liveRunId` is the explicit, persisted field the edge stamps on Exposures. It is
written when Start creates a new Run. "Latest in D1" is never used to infer the live Run —
`liveRunId` is the only source of truth.

## Draft vs live config

A newly created Experiment is a draft with no live Run. The draft holds all pending
assignment-affecting edits (salt, allocation, Variant set, Targeting/Segment, Targeting Key,
Activation Metric). The live Run's config remains unchanged at the edge until Start.

**Start** is the one action that:
1. Ends the current live Run (sets `ended_at`).
2. Creates Run N+1 carrying all batched draft changes.
3. Writes the new `liveRunId` into `AppFlagConfig` in both D1 and KV.
4. Broadcasts a delta-nudge from the per-App DO.

N draft edits = **one** sample reset (one new Run), never N.

## Edit taxonomy and their config-write behavior

| Edit type | Drafts? | Opens new Run? | KV update? |
|---|---|---|---|
| Assignment-affecting (salt, allocation, Variant set, Targeting, Targeting Key, Activation Metric) | Yes — accumulates on draft | On Start only | On Start |
| Measurement edit (Metric defs, Conversion Window, Guardrail config) | No — applies in place | No — recomputes over live Run | Yes, immediately |
| Non-material edit (description, owner, tags) | No — applies in place | No | Yes, immediately |

The Activation Metric is an assignment-affecting edit because it re-anchors the
Conversion Window retroactively, redefining the analysis population's entry timestamp. It is frozen
per Run.

## Config write path (the no separate-copy invariant)

```
Worker validates input
  → calls DO(appId).write(configDelta)
    → DO validates invariants (Run immutability, schema shape)
    → DO commits to D1 (authoritative relational record)
    → DO writes through to KV (read cache, ~60s propagation)
    → DO broadcasts delta-nudge to subscribed WebSocket clients
  → Worker returns 200 with new version to caller
```

**Persisted-before-announced:** the DO commits before broadcasting. A broadcast can never describe
unpersisted state. If D1 commit fails, the DO returns an error and no KV write or broadcast occurs.

## Config write failure contract

D1 is the authoritative source. KV is a read-replica cache.

- **D1 write fails:** DO returns error to the Worker; Worker returns 4xx/5xx to caller. No KV
  write, no broadcast. No partial state. Caller retries.
- **D1 succeeds, KV write fails:** Config is durable in D1. The Worker may return success (the
  durable write succeeded). The KV miss self-heals: the next Worker that reads KV and finds a
  stale/missing blob falls back to D1 and re-populates KV. The propagation window extends by
  however long it takes for that fallback read to occur. This is accepted eventual consistency,
  not silent data loss.
- **D1 succeeds, broadcast fails:** The nudge is best-effort. Panel clients reconnect and do a
  full invalidate-refetch on reconnect, recovering any missed broadcast for free (ADR-0019).

KV cache reads **always** include a D1 fallback path on Zod parse failure or cache miss. D1 is
never bypassed as truth. See [contracts-and-validation.md](./contracts-and-validation.md) for
the KV schema-version envelope and fallback rules.

## ~60s KV propagation window (accepted)

After Start, Evaluation Worker instances serving old config for up to ~60s are accepted and self-healing
(ADR-0009). New Entities hash deterministically to the same Variant under either config version.
No Run dataset is corrupted; only a narrow window of returning-Entity experience near a Run
boundary may temporarily serve the prior Variant, which converges as KV propagates.

## Sources

- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
