# The Assignment Store is a sibling seam, not behind the Provider

**Status:** accepted

The durable holdover state from ADR-0006 — per-Entity `(Experiment, idType, Targeting Key) -> (runId,
Variant)`, read on evaluate, written at first Exposure — lives in its own **Assignment Store** port, a
**sibling** to the Provider, *not* behind the Provider interface. The evaluate path consults both: it
reads holdover from the Assignment Store, and falls through to `assign()` over the Run config the Provider
resolved. The Provider stays a stateless read-side flag-config resolver.

This follows the grain of the OpenFeature contract. `resolve` is defined as
`(flag key, default, evaluation context) -> resolution details` (spec §2.2); the Provider state the spec
*describes* is an invalidatable flag-config cache, and side-effecting experiment writes are given their own
path — **`track()` on the Client** (spec §6, Requirements 6.1.x), deliberately separate from resolve. The
spec is **silent** on per-subject assignment storage behind a Provider — it neither sanctions nor forbids it
— so this is an argument from the *design's grain*, not a literal prohibition: OpenFeature clearly intends
evaluation (read) and tracking (write) to be separate concerns, and a per-Entity write store buried behind
`resolve` cuts across that. (Note: §2.7.1 is a *different, optional* provider-side tracking hook — "the
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
