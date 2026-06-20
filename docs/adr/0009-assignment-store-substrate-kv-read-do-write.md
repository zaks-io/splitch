# Assignment Store substrate: KV for the read, a per-key Durable Object for the write

**Status:** accepted

The Assignment Store port (ADR-0008) maps onto two Cloudflare primitives, split by its two halves:

- **`getAll` (hot-path read)** → **Workers KV only.** Edge-local (~10ms hot reads), eventually consistent,
  read-heavy sweet spot. This is the entire hot path; no Durable Object is touched on evaluate.
- **`put` (first-touch write)** → a **Durable Object, one per `(experiment, idType, targetingKey)`.** The
  DO is a single-threaded, globally-unique instance per key; its `get`-then-`put-if-absent` is atomic by
  construction, so two POPs racing the same Entity's first-touch cannot both win. On commit, the DO
  write-throughs to KV, fanning the assignment out to all POPs for subsequent reads.

This is Cloudflare's documented control-plane/data-plane split: a Durable Object as the authoritative
serialized writer, KV as the globally-cached read replica. Neither primitive does both jobs — KV has no
conditional write and is stale up to ~60s (can't resolve the race); a DO lives in one location (a network
hop from far POPs, not edge-local). Using both lets each cover the other's weakness.

**Fine-grained DOs are the documented pattern, not an anti-pattern.** Cloudflare supports an *unlimited*
number of Durable Objects ("millions of objects... scale horizontally"); idle DOs are evicted and incur no
compute/duration cost (only bytes at rest). The *only* warned-against grain is the opposite — a single hot
DO is a ~1,000 req/s bottleneck, and the documented fix is to shard into more DOs. One DO per key gives
zero cross-key contention and one cheap first-touch write before hibernation. The coarser "one DO per
Entity" option was rejected precisely because a heavily-trafficked Entity in many concurrent Experiments
would funnel all its writes through one single-threaded object — the exact bottleneck shape to avoid. The
per-key DO's inability to *enumerate* an Entity's assignments doesn't bite us: enumeration is the `getAll`
read, which KV serves; the DO is only ever the writer.

## Considered options

- **DO read-fallback on KV miss** (read KV, hop to the DO on a miss to close the boundary window) —
  rejected: a KV miss is the *normal* case for every genuinely new Entity, so this pays a DO hop on the
  common path to fix a rare, self-healing glitch. Bad trade.
- **D1** — wrong shape: regional single-primary relational DB, eventually-consistent replicas, no cross-POP
  write serialization. Fine as a downstream system-of-record/analytics sink, not the hot-path holdover store.
- **Coarse DO (one per Entity)** — rejected (bottleneck shape above).

## Consequences

KV-only reads accept a **transient boundary window**: for up to ~60s after a Run-boundary first-touch, a
concurrent cross-POP read may miss the holdover and compute a fresh `assign()` instead of replaying. This is
**cosmetic and self-healing**, and bounded to a narrow intersection — *returning Entity × live Run boundary ×
cross-POP × within the propagation window*. For a brand-new Entity it cannot occur: `assign()` is
deterministic (ADR-0001), so a stale KV miss computes the identical Variant the DO is about to store. The
DO still guarantees exactly one true first-touch winner, so **no Run's dataset is ever corrupted** — only one
returning user's momentary experience near a boundary, which converges once KV propagates. Accepted over a
hot-path hop.

The write path (Exposure pipeline → DO → KV write-through) and its failure/retry behavior are specified in
[the design doc](../architecture/assignment-store-seam.md); the DO's `blockConcurrencyWhile` / input-gate
discipline (no intervening non-storage I/O between the get and the put) is a correctness rule for the
implementation, not a re-litigable decision.
