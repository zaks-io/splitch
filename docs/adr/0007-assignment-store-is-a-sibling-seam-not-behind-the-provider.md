# The Assignment Store is a sibling seam, not behind the Provider

**Status:** accepted; amended 2026-09-02

The durable holdover state from ADR-0006 — per-Entity `(Experiment, idType, Targeting Key) -> (runId,
Variant)`, read on evaluate, written at first Exposure — lives in its own **Assignment Store** port, a
**sibling** to the Provider, _not_ behind the Provider interface. The evaluate path consults both: it
reads holdover from the Assignment Store, and falls through to `assign()` over the Run config the Provider
resolved. The Provider stays a stateless read-side flag-config resolver.

This follows the grain of the OpenFeature contract. `resolve` is defined as
`(flag key, default, evaluation context) -> resolution details` (spec §2.2); the Provider state the spec
_describes_ is an invalidatable flag-config cache, and side-effecting experiment writes are given their own
path — **`track()` on the Client** (spec §6, Requirements 6.1.x), deliberately separate from resolve. The
spec is **silent** on per-subject assignment storage behind a Provider — it neither sanctions nor forbids it
— so this is an argument from the _design's grain_, not a literal prohibition: OpenFeature clearly intends
evaluation (read) and tracking (write) to be separate concerns, and a per-Entity write store buried behind
`resolve` cuts across that. (Note: §2.7.1 is a _different, optional_ provider-side tracking hook — "the
provider MAY define a function for tracking" — not the Client `track()` that carries experiment data; the
load-bearing requirement is §6.) flagd, the reference Provider, gets stickiness with **zero per-user
storage** (deterministic hash only), which is exactly why a holdover write store doesn't belong behind a
swappable Provider. Our holdover write at Exposure is a `track`-side concern, so it belongs on a `track`-side
seam.

The deletion test passes for real, not hypothetically: Statsig (`IUserPersistentStorage`) and GrowthBook
(`StickyBucketService`) both ship this exact port as a swappable dependency the evaluation engine consults
— two real adapters in the wild, so the seam is real by our own "two adapters" rule.

## Considered options

- **Behind the Provider interface** (every adapter implements sticky storage) — rejected: cuts against the
  OpenFeature evaluate-vs-track grain, forces a non-Flagship Provider (e.g. flagd) to grow per-Entity write
  state it has no business holding, and couples flag-config distribution to an experiment datastore.
  Statsig packages resolution + persistence together, but it is not OpenFeature-shaped; we are.

## Consequences

The evaluate path becomes the orchestrator of two seams (Provider, Assignment Store) rather than one. That
orchestration logic is small and lives in one place (see ADR-0008). The Assignment Store inherits ADR-0006's
hard constraint: an edge-local, low-latency read on the hot path, to be satisfied by the storage-substrate
design.

## The instance is authoritative; KV is a lagging mirror (amended 2026-09-02)

The edge-local read ADR-0006 demands is served by a KV mirror of the Assignment Store. The instance commits
to its own storage and then awaits the mirror write before it answers, so the mirror is never ahead of the
instance and an HTTP success means the blob was written. What it does not mean is that a reader can see it:
KV propagates a write globally rather than read-your-writes, and it caches **negative** lookups per region
for `cacheTtl` (default 60s), so the first read that misses in a region pins that miss for up to a minute
in that region while another region already serves the value.[^kv-cache] Two reads of the same Entity
seconds apart can therefore disagree. The blob is one merged map per Entity, so a stale _update_ — a blob
present but predating the Entity's newest Assignment — lags exactly the same way a stale absence does.

Any read that must not act on a stale mirror therefore runs the full mirror pass first and, only when that
pass yields no usable answer, asks the instance once. Assignments are written under the current identity
epoch alone, so that is the single address worth asking: a retained historical epoch names an instance that
can never hold anything, and consulting one per missing key would bill every normally enrolled Entity a
cross-script hop on the hit path, which is precisely what ADR-0006 forbids. The activation path in
`event-ingest-api` does this. Read paths where a stale mirror is merely a slower answer (evaluate, which
recomputes the assignment) keep the plain KV read.

Because the instance name is an address rather than a key, a reader that derives it differently from the
writer silently addresses a different, empty instance. `assignmentWriterName` in `@splitch/contracts` is
the one definition the writer and every production reader import.

[^kv-cache]:
    <https://developers.cloudflare.com/kv/api/read-key-value-pairs/#cachettl-parameter>. "Both
    existing key-value pairs and non-existent key-value pairs (also known as negative lookups) are cached
    at the edge", and "Once a key has been read with a given `cacheTtl` in a region, it will remain cached
    in that region until the end of the `cacheTtl` or eviction".
