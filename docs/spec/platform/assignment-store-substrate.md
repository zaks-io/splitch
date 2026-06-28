# Assignment Store substrate: KV read / DO write

The Assignment Store port (`getAll` / `put`) maps onto two Cloudflare primitives: Workers KV for
reads, a per-key Durable Object for writes. Each covers the other's weakness.

## Interface contract

```
AssignmentStore:
  getAll(appId: string, idType: string, targetingKey: string)
    → Map<experimentId, { runId: string; variant: string }>

  put(experimentId: string, idType: string, targetingKey: string,
      runId: string, variant: string)
    → void  // fire-and-forget; failure semantics below
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
  single round-trip
- Value: `Map<experimentId, { runId, variant }>` carried under a KV envelope that holds the
  single `schemaVersion` (entries themselves carry no `schemaVersion`; the version is
  envelope-level only — see `AssignmentStoreValueSchema` / `kvEnvelope` in
  `@splitch/contracts` and [contracts-and-validation.md](./contracts-and-validation.md);
  Zod-validated on read)
- Latency: ~10ms edge-local (read from nearest POP replica)
- Consistency: eventually consistent; up to ~60s propagation lag across POPs
- **No DO touch on the evaluate hot path.** The DO is the writer, never the reader on evaluate.

### `put` → per-key Durable Object

- DO name: `{experimentId}:{idType}:{targetingKeyHash}` (via `idFromName`)
- One DO per key: single-threaded, globally-unique instance; eliminates write-race
- Atomic `get → check absent → put`: the DO's input gate ensures no intervening non-storage I/O
  between get and put (use `blockConcurrencyWhile` or keep the storage access synchronous)
- **First writer wins:** if the key already exists in the DO's storage, the new `put` is a no-op
- **Write-through to KV on commit:** after storing, the DO merges its `{ runId, variant }`
  entry into the Entity-keyed KV value (a single envelope-level `schemaVersion`) under its
  `experimentId`, so subsequent
  `getAll` calls on any POP are served without a DO round-trip. Read granularity (per-Entity)
  and write granularity (per-Experiment) differ by design (ADR-0008/0009)

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

- **DO `put` succeeds, KV write-through fails:** The holdover is durable in the DO. KV is stale.
  The next `getAll` call on the same or another POP misses KV and recomputes `assign()` fresh.
  Because `assign()` is deterministic (ADR-0001), the recomputed Variant is identical to the stored
  one. The experience is correct; only KV convergence is delayed. **KV write-through from the DO
  is fire-and-forget.** The DO does not wait for KV confirmation before returning success to the
  Exposure pipeline.
- **DO `put` fails (DO unavailable):** The Exposure fires and is logged to Tinybird
  independently (at-least-once, idempotent key). The holdover is not written. The next evaluate
  call for this Entity will compute `assign()` fresh — producing the same Variant. The sticky
  experience is transiently broken for this Entity until the DO becomes available and a subsequent
  `put` succeeds. This is an accepted, bounded failure mode.

## Consistency window (accepted, self-healing)

For up to ~60s after a DO write-through, cross-POP reads may miss the holdover in KV and recompute
`assign()` instead of replaying. This is bounded to:
`returning Entity × live Run boundary × cross-POP × within ~60s propagation window`.

For new Entities it cannot produce wrong behavior: `assign()` is deterministic, so a KV miss
produces the identical Variant the DO just stored. **No Run dataset is ever corrupted** — only a
returning Entity's momentary experience near a boundary, which self-heals.

**No DO read-fallback on KV miss.** A KV miss is the normal case for every new Entity. Paying a
DO round-trip on the common path to fix a rare, self-healing glitch is the wrong trade (ADR-0009).

## DO scale (unlimited)

Cloudflare supports millions of DOs; idle DOs hibernate with zero compute cost (bytes-at-rest only).
One DO per key yields zero cross-key contention and one cheap first-touch write before hibernation.
An App with 100 Experiments × many Entities = millions of DOs is the intended operating point, not
an edge case (ADR-0009).

## Holdover retention

Holdovers for ended Runs are retained in the DO and KV until the Experiment is archived or deleted.
A hard delete of the Experiment triggers a cleanup of all DO state and KV keys for that Experiment.
An Entity deletion request deletes the matching Entity read key and writer row immediately after the
`entity_deletions` tombstone is committed.

## Sources

- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../adr/0001-assignment-is-pure-not-an-event.md](../../adr/0001-assignment-is-pure-not-an-event.md)
- [../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
- [privacy-data-lifecycle.md](./privacy-data-lifecycle.md)
