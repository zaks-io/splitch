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
though an Experiment pins one Entity type today. It is the cheap guard against a Targeting Key _value_
colliding across Entity types (a `session` id string that equals a `user` id string). Mirrors Statsig's
`<userID>:<idType>` keying. Fail-loud over fail-clever.

**Value — `(runId, Variant)`.** Both fields are load-bearing:

- `Variant` — what to **replay** for a holdover.
- `runId` — which **Run owns this Entity's Exposures**. Without it, ADR-0006's "counted in the old Run" is
  unimplementable; replay would show the right Variant but lose the attribution anchor.

**Load model — eager pre-load (GrowthBook-style).** One edge-local read pre-loads an Entity's holdovers
into context before flag resolution, so each per-flag decision is an in-memory lookup. Chosen over Statsig's
lazy per-call fetch because the hot path across five edge runtimes wants the round-trips front-loaded, not
one read per Experiment. (The _physical_ substrate behind this read — Workers KV, with a per-key Durable
Object as the serialized writer — is pinned below in [The substrate](#the-substrate-adr-0009-kv-read-per-key-durable-object-write).)

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

## The substrate (ADR-0009): KV read, per-key Durable Object write

The port maps onto two Cloudflare primitives, split by its two halves — neither primitive does both jobs,
so the canonical control-plane/data-plane split applies. Verified against Cloudflare docs (see
[references.md](./references.md)).

```
              evaluate (hot path)                 Exposure pipeline (first-touch)
                     |                                        |
                getAll(key)                                put(key, ...)
                     |                                        |
                     v                                        v
              +-------------+      write-through      +-----------------------+
              |  Workers KV | <---------------------- |  Durable Object       |
              | (read repl) |                         |  id = exp:idType:tk   |
              +-------------+                         |  get-then-put-if-absent|
               ~10ms, edge-local                      |  (atomic, one winner) |
               eventually consistent                  +-----------------------+
                                                       single-threaded, one location
```

- **`getAll` → Workers KV only.** Edge-local ~10ms, eventually consistent, the read-replica fan-out. The
  entire hot path; no DO is touched on evaluate.
- **`put` → one Durable Object per `(experiment, idType, targetingKey)`.** Single-threaded and globally
  unique per key, so its `get`-then-`put-if-absent` is atomic — two POPs racing the same Entity's
  first-touch cannot both win. On commit the DO write-throughs to KV.

**Why fine-grained DOs (one per key), not one per Entity.** Cloudflare supports unlimited DOs ("millions...
scale horizontally"); idle DOs hibernate free (only bytes at rest cost). The _only_ documented anti-pattern
is the opposite — a single hot DO is a ~1,000 req/s bottleneck whose fix is to shard into more DOs. One DO
per key has zero cross-key contention and one cheap write before hibernation. A coarser per-Entity DO would
funnel a busy Entity's many concurrent Experiments through one single-threaded object — the bottleneck shape
to avoid. The per-key DO can't _enumerate_ an Entity's assignments, but it never needs to: enumeration is
`getAll`, which KV serves.

### The consistency window (accepted, self-healing)

KV-only reads accept a transient window: for up to ~60s after a Run-boundary first-touch, a concurrent
cross-POP read may miss the holdover and compute a fresh `assign()` instead of replaying. It is **cosmetic
and self-healing**, bounded to _returning Entity × live Run boundary × cross-POP × within propagation_. For a
new Entity it cannot happen — `assign()` is deterministic (ADR-0001), so a stale miss computes the identical
Variant the DO is about to store. The DO still yields exactly one true first-touch winner, so **no Run's
dataset is ever corrupted**; only one returning user's momentary experience near a boundary, which converges.
A DO read-fallback on KV miss was rejected: a miss is the normal new-Entity case, so it would pay a hop on
the common path to fix a rare, self-healing glitch.

### Implementation correctness rule (not re-litigable)

The DO's first-touch must keep `get → decide → put` free of intervening non-storage I/O (e.g. `fetch()`),
or wrap it in `blockConcurrencyWhile`, so the input gate's atomicity holds. The write path is Exposure
pipeline → DO → KV write-through; its retry/failure behavior is an implementation concern of the
Exposure-pipeline seam, not this one.
