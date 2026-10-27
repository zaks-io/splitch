# The Assignment Store is App-scoped, with one Durable Object writer per Entity

**Status:** accepted; supersedes the interface in
[ADR-0008](./0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md) and the per-key
writer and consistency-window guarantee in
[ADR-0009](./0009-assignment-store-substrate-kv-read-do-write.md)

ADR-0008's core stands: the Assignment Store is dumb storage, and the evaluate path owns holdover,
replay, and write policy. ADR-0009's read half stands: `getAll` reads holdovers from Workers KV
only, with no Assignment Store Durable Object on the read path. (Evaluate can still read the App
identity authority to load an identity lease, per
[ADR-0057](./0057-evaluation-hot-path-uses-identity-leases-and-a-usage-outbox.md); that is not the
Assignment Store.) Two decisions change.

**The interface is App-scoped and reports the write outcome.**

```
getAll({appId, idType, targetingKey})                  -> Map<experimentId, {runId, variant}>
put({appId, experimentId, idType, targetingKey, runId, variant, sourceCreatedAtMs})
                                                       -> {status: 'stored' | 'existing', assignment}
putHashed({appId, experimentId, idType, targetingKeyHash, runId, variant, sourceCreatedAtMs})
                                                       -> {status: 'stored' | 'existing', assignment}
```

No call takes an `environment_id`. An Experiment belongs to one Environment
([ADR-0027](./0027-environment-is-a-first-class-axis-under-app.md)), so `experimentId` already pins
it, and one Entity's holdovers for every Experiment in the App share one KV value at
`assignment:{appId}:{idType}:{targetingKeyHash}`. The Targeting Key is HMAC'd with the App's identity
key before storage. `put` says whether this call won first touch or found an earlier winner, so the
caller can tell the two apart without a second read. `putHashed` serves Exposure Ticket redemption,
which never carries the raw Targeting Key
([ADR-0048](./0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md)).
The canonical signature, including identity versions, is in
[assignment-store.md](../spec/domain-model/assignment-store.md).

**One writer per Entity, not per Experiment and Entity.** The writer keeps the shared per-Entity KV
value by read-merge-write. ADR-0009's per-key writers each did that against the same value at the same
time and overwrote each other, losing a sibling Experiment's first-touch winner (fixed in #114). The
writer is now addressed by `assignmentWriterName`, `appId:idType:targetingKeyHash`
(`packages/contracts/src/storage-keys-durable-objects.ts`). It stores one winner per Experiment and
awaits the KV write-through before it responds. In production every write first passes the App's
holdover inventory Durable Object, which orders it against privacy reset and App deletion
([ADR-0056](./0056-privacy-durable-objects-exclude-reset-from-delivery-not-delivery-from-itself.md)).
ADR-0009's input-gate rule still applies: no non-storage I/O between the writer's get and put.

## Considered options

- **Per-key writer and one KV entry per Experiment** — rejected. `getAll` would become a KV list or one
  read per live Experiment on every evaluate. A list is eventually consistent and slower than a get,
  and per-Experiment reads grow with the App's Experiment count.
- **Per-key writer over the shared per-Entity value** (ADR-0009 as first built) — rejected as
  incorrect: concurrent first touches for one Entity lose entries.
- **Per-Entity writer** — accepted. It is the coarse grain ADR-0009 rejected: an Entity in many
  concurrent Experiments funnels its first-touch writes through one single-threaded object. First
  touch happens once per Entity and Experiment, so that rate is bounded by the Entity's live
  Experiments, not its request rate.

## Consequences

- **The App inventory object, not the per-Entity writer, is the current write ceiling.** It serializes
  all of one App's first-touch writes. SPL-799 replaces that with ADR-0056's readers-writer section
  and coalesces KV publication per Entity.
- **ADR-0009's "no Run's dataset is ever corrupted" is withdrawn.** A stale KV read is still harmless
  for a new Entity, because `assign()` is deterministic. For an Entity held over across a Run
  boundary it is not: evaluate can seal an Exposure under the new Run before `put` returns the earlier
  Run's winner, and that result is discarded, so the Entity can count in both Runs' denominators
  against [ADR-0006](./0006-run-boundary-sticky-experience-counted-in-old-run.md). SPL-812 tracks the
  fix. Until it lands, the store guarantees exactly one first-touch winner per Entity and Experiment,
  not a clean Run dataset.
- **A failed write fails loud.** Inline evaluate writes after the Exposure is accepted and returns
  `503 SERVICE_UNAVAILABLE` when the write or its KV write-through fails, so a retry re-sends the
  Exposure. Ticket redemption retries from a durable holdover outbox.
