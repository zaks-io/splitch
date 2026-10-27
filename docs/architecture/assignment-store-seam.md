# The Assignment Store seam (holdover / sticky experience)

Status: reference design. Output of an upfront architecture grill on 2026-06-20.
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

OpenFeature separates `resolve`, contractually `(flag key, default, evaluation context) ->
resolution details`, from Client `track()` (§6). The spec describes an invalidatable flag-config cache
but neither requires nor forbids per-Entity assignment storage behind a Provider. This is a design
choice following that read/write separation, not a protocol prohibition (ADR-0007). flagd achieves
stickiness with deterministic hashing and no per-user storage. Splitch keeps its Exposure-time
holdover write outside `resolve`.

Statsig (`IUserPersistentStorage`) and GrowthBook (`StickyBucketService`) independently confirm the shape:
both keep persistent/sticky assignment as a swappable port the evaluation engine consults, never baked
into the resolver. Two shipping adapters = a real seam by our own rule.

### 2. Dumb storage, policy on the evaluate path (ADR-0008)

The store does one thing: durable memory. The Evaluation Worker owns all behavior outside that store:
its evaluate policy module owns the holdover predicate, replay-vs-`assign()` decision, write intent,
and runId stamping; its Exposure orchestration owns write timing after durable Event Ingest
acceptance. This was a deliberate rejection of a `resolveAssignment()` that fuses storage with
`assign()`: that interface is a three-state superposition (replayed / freshly assigned / stamped) you
cannot collapse without reading the implementation. Dumb get/put keeps the evaluate flow explicit.

## The interface

```
interface AssignmentStore:
  getAll({appId, idType, targetingKey, identityVersion?}) -> Map<experiment, {runId, variant}>
  put({appId, experimentId, idType, targetingKey, identityVersion?, runId, variant, sourceCreatedAtMs?})
  putHashed({appId, experimentId, idType, targetingKeyHash, identityVersion?, runId, variant, sourceCreatedAtMs?})
```

**Environment follows the Experiment, not a separate KV namespace.** The shared Assignment Store
reads an App-scoped Entity map across Experiments. `experimentId` identifies an Experiment in exactly
one Environment, so the evaluator selects the entry for the Environment-scoped Experiment it resolved.
`appId` and `idType` co-scope every call. The deployed signatures live in
[`assignment-store.ts`](../../apps/evaluation-api/src/assignment/assignment-store.ts).

**Key — `(app_id, Experiment, idType, targeting_key_hash)`.** Raw Targeting Keys are hashed with the
App identity key before storage; `idType` keeps Entity types distinct. `putHashed` supports Exposure
Ticket redemption without sending the raw Targeting Key. Production writes require the source
encounter time so privacy deletion cutoffs can reject delayed pre-deletion work.

**Value — `(runId, Variant)`.** Both fields are load-bearing:

- `Variant` — what to **replay** for a holdover.
- `runId` — which **Run owns this Entity's Exposures**. Without it, ADR-0006's "counted in the old Run" is
  unimplementable; replay would show the right Variant but lose the attribution anchor.

**Load model — eager pre-load (GrowthBook-style).** One edge-local read pre-loads an Entity's holdovers
into context before flag resolution, so each per-flag decision is an in-memory lookup. Chosen over Statsig's
lazy per-call fetch because the hot path across five edge runtimes wants the round-trips front-loaded, not
one read per Experiment. (The _physical_ substrate behind this read — Workers KV, with a per-Entity Durable
Object as the serialized writer (ADR-0064) — is pinned below in [The substrate](#the-substrate-kv-read-per-entity-durable-object-write).)

## The evaluate path (no superposition — every branch visible)

```
held = AssignmentStore.getAll({appId, idType, targetingKey})   # one edge-local read, all Experiments

for flag in flags:
    if held[exp] present:                       # holdover: returning Entity, already exposed
        variant = held[exp].variant             #   replay prior Variant (ADR-0006: sticky experience)
        # no write, no new Exposure: already counted under held[exp].runId
    else:                                       # new or never-exposed Entity
        variant = assign(liveRun, targetingKey) #   pure hash (ADR-0001)
        # On exposing read, seal the Exposure in Event Ingest, then persist the holdover
```

Each ADR maps to one pointable line. The Provider resolved `liveRun`'s config; `assign()` is pure; the
store is dumb; the policy is here and legible.

## Why this is a deep seam

A read/write interface (`getAll` / `put` / `putHashed`) sits in front of: sticky-experience continuity across Run
boundaries, exposure-attribution integrity (the `runId` anchor), cross-Entity-type key isolation, and an
edge-local hot-path read across five runtimes. The complexity is concentrated behind get/put, and the
storage adapter is independently testable as pure memory — exactly the depth the deletion test rewards.

## The substrate: KV read, per-Entity Durable Object write

The port maps onto two Cloudflare primitives, split by its two halves — neither primitive does both jobs,
so the canonical control-plane/data-plane split applies. Verified against Cloudflare docs (see
[references.md](./references.md)).

```
              evaluate (read)                     after durable Exposure seal
                     |                                        |
                getAll(key)                                put(key, ...)
                     |                                        |
                     v                                        v
              +-------------+      write-through      +-----------------------+
              |  Workers KV | <---------------------- |  Durable Object       |
              | (read repl) |                         | id = app:idType:hash  |
              +-------------+                         |  get-then-put-if-absent|
               ~10ms, edge-local                      |  (atomic, one winner) |
               eventually consistent                  +-----------------------+
                                                       single-threaded, one location
```

- **`getAll` → Workers KV only.** Edge-local ~10ms, eventually consistent, the read-replica fan-out. The
  Assignment Store read path; first-touch writes and identity validation use Durable Objects.
- **`put` → one Durable Object per `(appId, idType, targetingKeyHash)`.** Single-threaded and globally
  unique per key, so its `get`-then-`put-if-absent` is atomic — two POPs racing the same Entity's
  first-touch cannot both win. On commit the DO write-throughs to KV.

**One writer per Entity protects the merged KV map.** `assignmentWriterName` in
`@splitch/contracts` is the canonical address. `AssignmentStoreDurableObjectV2` stores a winner per
Experiment within that instance and awaits the KV write-through before responding. Separate
per-Experiment writers would race on the shared Entity blob and overwrite sibling entries. A retry
of an existing winner retries a failed mirror write. Inline evaluate failures return an error for
retry. Exposure Ticket redemption uses a durable holdover outbox; the App inventory coordinates
writes with privacy reset.

### The consistency window

KV-only reads accept a transient window: for up to ~60s after a Run-boundary first-touch, a concurrent
cross-POP read may miss the holdover and compute a fresh `assign()` instead of replaying, bounded to
_returning Entity × live Run boundary × cross-POP × within propagation_. For a new Entity it is harmless —
`assign()` is deterministic (ADR-0001), so a stale miss computes the identical Variant the DO is about to
store. For an Entity held over across a Run boundary it is not cosmetic: evaluate seals the new Run's
Exposure before `put` reports the earlier winner, so the Entity can count in both Runs (SPL-812). ADR-0064
withdrew ADR-0009's "no Run's dataset is ever corrupted"; the DO still yields exactly one first-touch winner
per Entity and Experiment. A DO read-fallback on every KV miss was rejected: a miss is the normal new-Entity
case, so it would pay a hop on the common path.

### Implementation correctness rule (not re-litigable)

The DO's first-touch must keep `get → decide → put` free of intervening non-storage I/O (e.g. `fetch()`),
or wrap it in `blockConcurrencyWhile`, so the input gate's atomicity holds. The write path follows durable Event Ingest acceptance, then the
App inventory, Assignment Store DO, and awaited KV write-through. Exposure Ticket redemption also
uses a durable holdover outbox. Activation checks
that cannot accept a stale mirror read every retained identity map first, then consult the current
identity's authoritative instance once when no usable Assignment was found (ADR-0007).
