# The Assignment Store seam (holdover / sticky experience)

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture terms (module, seam, adapter,
depth, locality) per the deepening discipline. Builds directly on the
[Assignment / Exposure seam](./assignment-exposure-seam.md) and ADR-0006.

## Where this came from

ADR-0006 (Run boundary: sticky experience, counted in the old Run) introduced a single piece of durable
per-Entity state — the only one on the Assignment/Exposure seam — and deferred its home to "the
Provider/storage seam." This is that grill. It answers two questions: **where does the holdover store sit
relative to the Provider**, and **what does its interface promise**.

## The decisions (verified against the contracts, not guessed)

Both decisions were checked against OpenFeature's spec and Statsig/GrowthBook/Eppo source before being
made — see [references.md](./references.md). The docs settled both forks.

### 1. Sibling seam, not behind the Provider (ADR-0007)

The **Provider** stays a stateless read-side flag-config resolver (Flagship default, swappable). The
holdover store is a **separate port — the Assignment Store** — that the evaluate path consults alongside
the Provider.

OpenFeature forces this. `resolve` is contractually `(flag key, default, evaluation context) ->
resolution details`; the only Provider state the spec permits is an invalidatable flag-config cache, never
a per-subject assignment ledger (§2.2, §2.6). Side-effecting experiment writes have a separate path,
`track()` on the Client (§6, Cond. 2.7.1). flagd, the reference Provider, achieves stickiness with zero
per-user storage. Our holdover write happens at Exposure — a `track`-side concern — so it belongs on a
`track`-side seam, never behind `resolve`.

Statsig (`IUserPersistentStorage`) and GrowthBook (`StickyBucketService`) independently confirm the shape:
both keep persistent/sticky assignment as a swappable port the evaluation engine consults, never baked
into the resolver. Two shipping adapters = a real seam by our own rule.

### 2. Dumb storage, policy on the evaluate path (ADR-0008)

The store does one thing: durable memory. All policy — the holdover predicate, replay-vs-`assign()`,
first-touch write timing, runId stamping — lives on the evaluate path. This was a deliberate rejection of
a `resolveAssignment()` that fuses storage with `assign()`: that interface is a three-state superposition
(replayed / freshly assigned / stamped) you cannot collapse without reading the implementation. Dumb
get/put keeps the evaluate path a readable straight line.

## The interface

```
interface AssignmentStore:
  getAll(experiment, idType, targetingKey) -> Map<experiment, {runId, variant}>   # eager pre-load
  put(experiment, idType, targetingKey, runId, variant)                            # first-touch write
```

**Key — `(Experiment, idType, Targeting Key)`.** The Entity-type (`idType`) is explicit in the key even
though an Experiment pins one Entity type today. It is the cheap guard against a Targeting Key *value*
colliding across Entity types (a `session` id string that equals a `user` id string). Mirrors Statsig's
`<userID>:<idType>` keying. Fail-loud over fail-clever.

**Value — `(runId, Variant)`.** Both fields are load-bearing:
- `Variant` — what to **replay** for a holdover.
- `runId` — which **Run owns this Entity's Exposures**. Without it, ADR-0006's "counted in the old Run" is
  unimplementable; replay would show the right Variant but lose the attribution anchor.

**Load model — eager pre-load (GrowthBook-style).** One edge-local read pre-loads an Entity's holdovers
into context before flag resolution, so each per-flag decision is an in-memory lookup. Chosen over Statsig's
lazy per-call fetch because the hot path across five edge runtimes wants the round-trips front-loaded, not
one read per Experiment. (The *physical* substrate behind this read — KV vs Durable Object vs edge cache,
replication, staleness — is the next grill; this seam only fixes that the read is edge-local and eager.)

## The evaluate path (no superposition — every branch visible)

```
held = AssignmentStore.getAll(experiment, idType, targetingKey)   # one edge-local read, all Experiments

for flag in flags:
    if held[exp] present:                       # holdover: returning Entity, already exposed
        variant = held[exp].variant             #   replay prior Variant (ADR-0006: sticky experience)
        # no write, no new Exposure: already counted under held[exp].runId
    else:                                       # new or never-exposed Entity
        variant = assign(liveRun, targetingKey) #   pure hash (ADR-0001)
        # Exposure fires on read (ADR-0004); pipeline writes holdover at first-touch (ADR-0005)
```

Each ADR maps to one pointable line. The Provider resolved `liveRun`'s config; `assign()` is pure; the
store is dumb; the policy is here and legible.

## Why this is a deep seam

A two-method interface (`getAll` / `put`) sits in front of: sticky-experience continuity across Run
boundaries, exposure-attribution integrity (the `runId` anchor), cross-Entity-type key isolation, and an
edge-local hot-path read across five runtimes. The complexity is concentrated behind get/put, and the
storage adapter is independently testable as pure memory — exactly the depth the deletion test rewards.

## Open constraint handed to the next grill

The Assignment Store needs a **low-latency, edge-local read on the evaluate path** (ADR-0006). The
storage-substrate grill must satisfy that — and decide the write path from the Exposure pipeline back into
the store, including how a first-touch write races against concurrent reads at other POPs.
