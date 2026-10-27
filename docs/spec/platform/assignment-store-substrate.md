# Assignment Store substrate: KV read / DO write

The Assignment Store port (`getAll` / `put`) maps onto two Cloudflare primitives: Workers KV for
reads, a per-Entity Durable Object for writes. Each covers the other's weakness.

## Interface contract

```
AssignmentStore:
  getAll({ appId, idType, targetingKey, identityVersion? })
    → Promise<Map<experimentId, { runId: string; variant: string }>>

  put({ appId, experimentId, idType, targetingKey, identityVersion?,
        runId, sourceCreatedAtMs, variant })
    → Promise<{ status: 'stored' | 'existing'; assignment: { runId, variant } }>

  putHashed({ appId, experimentId, idType, targetingKeyHash, identityVersion?,
              runId, sourceCreatedAtMs, variant })
    → same result  // Exposure Ticket redemption never carries a raw Targeting Key
```

`getAll` returns all stored holdovers for this Entity across all Experiments in one call. The map
key is `experimentId` (string). A missing entry means no holdover — new Entity.

`idType` is explicit in both key and call signature even when an Experiment pins one Entity type.
It is a cheap guard against Targeting Key _value_ collisions across Entity types (a `session` id
that equals a `user` id). Mirrors Statsig's `<userId>:<idType>` keying.

## Physical split

### `getAll` → Workers KV only

The substrate derives `targetingKeyHash` using the privacy lifecycle HMAC before constructing any
physical key. The raw Targeting Key never appears in KV key names or DO names.

- KV key: `assignment:{appId}:{idType}:{targetingKeyHash}` — the per-Entity read key (no
  `experimentId`), so one `getAll` returns every Experiment's holdover for this Entity in a
  single round-trip per retained identity epoch
- Value: `Map<experimentId, { runId, variant }>` carried under a KV envelope that holds the
  single `schemaVersion` (entries themselves carry no `schemaVersion`; the version is
  envelope-level only — see `AssignmentStoreValueSchema` / `kvEnvelope` in
  `@splitch/contracts` and [contracts-and-validation.md](./contracts-and-validation.md);
  Zod-validated on read)
- Latency: ~10ms edge-local (read from nearest POP replica)
- Consistency: eventually consistent; up to ~60s propagation lag across POPs
- **No Assignment Store DO read-fallback on evaluate.** Holdover reads use KV. Privacy identity
  authority and config reads use their own DOs independently.

### `put` → per-Entity Durable Object

- DO name: `{appId}:{idType}:{targetingKeyHash}` via `assignmentWriterName`
- One DO per Entity serializes every Experiment entry merged into that Entity's KV value
- Atomic `get → check absent → put`: the DO's input gate ensures no intervening non-storage I/O
  between get and put (use `blockConcurrencyWhile` or keep the storage access synchronous)
- **First writer wins:** if the Experiment winner already exists, `put` preserves it and
  reasserts its KV projection before returning `existing`
- **Write-through to KV on commit:** after storing, the DO merges its `{ runId, variant }`
  entry into the Entity-keyed KV value (a single envelope-level `schemaVersion`) under its
  `experimentId`, so subsequent
  `getAll` calls on any POP are served without an Assignment Store DO round-trip. Writer storage
  holds one `assignment:{experimentId}` winner per Experiment inside the Entity-scoped DO.

## DO atomicity and crash-recovery guarantee

The DO's `get → check absent → put` must be wrapped in `blockConcurrencyWhile` (or kept as a
single synchronous storage operation) so the input gate's atomicity holds. Durable Object storage
is itself durable (persisted to disk, not RAM); a DO crash between get and put results in neither
operation being visible — the storage write is atomic at the Cloudflare layer. Two POPs racing a
first-touch therefore have exactly one winner: the DO guarantees it, not application-level retry.

This is distinct from the KV consistency window: the DO is the serialization point; KV is the
read-replica. The DO's durability guarantee means "exactly one true first-touch winner." KV's
consistency window means "up to ~60s before all POPs see the winner's Variant."

## DO write failure contract

- **DO winner persists, KV write-through fails:** `put` rejects. The winner remains durable and a
  retry reasserts that same winner into KV before returning success. Write-through is awaited,
  including when the winner already exists; it is not fire-and-forget.
- **DO `put` fails:** the Exposure may already be durably accepted by Event Ingest. Remote
  `evaluate` returns `503 SERVICE_UNAVAILABLE` instead of claiming a successful Assignment commit.
  Exposure Ticket and trusted-adapter paths use the durable holdover-write outbox, with bounded
  alarm retries and an observable poisoned state. See
  [holdover-write-contract.md](../pipeline/holdover-write-contract.md).

## Consistency window

For up to ~60s after a DO write-through, cross-POP reads may miss the holdover in KV and recompute
`assign()` instead of replaying. This is bounded to:
`returning Entity × live Run boundary × cross-POP × within ~60s propagation window`.

For new Entities it cannot produce wrong behavior: `assign()` is deterministic, so a KV miss
produces the identical Variant the DO just stored.

For an Entity held over across a Run boundary it can. Evaluate resolves fresh under the new Run and
seals that Exposure before `put` returns the earlier Run's winner as `existing`, and the result is
discarded. The Entity sees the new Run's Variant once and can count in both Runs' denominators,
against ADR-0006. ADR-0064 withdrew ADR-0009's "no Run dataset is ever corrupted"; SPL-812 tracks the
fix. Until it lands, the store guarantees one first-touch winner per Entity and Experiment, not a
clean Run dataset.

**No DO read-fallback on KV miss.** A KV miss is the normal case for every new Entity. Paying a
DO round-trip on the common path is the wrong trade for the new-Entity case (ADR-0009). SPL-812's
fix keeps that hop off the new-Entity path unless an ADR accepts its measured cost.

## DO scale (unlimited)

Cloudflare supports millions of DOs; idle DOs hibernate with zero compute cost (bytes-at-rest only).
One DO per Entity avoids cross-Entity contention; that Entity's Experiment writes serialize together.
An App with 100 Experiments × many Entities = millions of DOs is the intended operating point, not
an edge case (ADR-0009).

## Holdover retention

Holdovers for ended Runs are meant to be retained in the DO and KV until the Experiment is archived
or deleted, with Experiment cleanup removing its entries from the shared Entity value rather than
deleting sibling Experiment holdovers. That cleanup is not implemented yet: Experiment archive only
updates the D1 row, and the writer exposes no Experiment-scoped removal, so records persist until App
or Entity deletion purges them. Entity deletion purges matching writer rows and rewrites or deletes the KV
value after the tombstone is committed; a durable cutoff rejects stale writes while preserving
newly collected Assignments. App identity reset separately fences destroyed identity versions.

## Sources

- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../adr/0001-assignment-is-pure-not-an-event.md](../../adr/0001-assignment-is-pure-not-an-event.md)
- [../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
- [privacy-data-lifecycle.md](./privacy-data-lifecycle.md)
