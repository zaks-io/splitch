# Holdover and replay policy

When a Run boundary is crossed, a returning Entity (a **holdover**) keeps seeing its prior
Variant (sticky experience) but is not re-counted in the new Run. This separates
assignment-for-experience from assignment-for-analysis.

## Holdover definition

An Entity is a **holdover** if and only if it has a first-touch Exposure recorded under a
prior Run of the same Experiment — i.e. `AssignmentStore.getAll()` returns a record for
this `(appId, experimentId, idType, targetingKey)`.

The predicate is purely fact-based: "does an Exposure record exist?" Because Assignment is
pure and leaves no trace (ADR-0001), there is no "assigned but unexposed" ambiguity. An
Entity bucketable under old Run N but never exposed is a **new Entity** to Run N+1 — zero
footprint, correct by construction.

## Replay semantic

If the Entity is a holdover:

- Serve `holdoverRecord.variant` (the Variant from the original Exposure).
- Do **not** recompute `assign(liveRun, targetingKey)`.
- Do **not** fire a new Exposure.
- Do **not** write to Assignment Store (the record already exists).
- Return `{ variant, isHoldover: true, priorRunId: holdoverRecord.runId }`.

Why not recompute: `assign()` requires the Run's frozen config. The old Run's salt and
allocation may be archived or deleted; recomputing is impossible without them. The stored
`holdoverRecord.variant` is the only durable source of truth for the prior Variant.

## Experience vs analysis split

| Concern                                    | Behavior                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Experience** (what to show)              | Replay prior Variant; no mid-experiment flip                                       |
| **Analysis** (what Run counts this Entity) | Exposures remain attributed to `holdoverRecord.runId`; not accrued to the live Run |

Run N+1's dataset is pure: it contains only Entities first-exposed under Run N+1's config.
Holdovers cannot pollute it because they fire no new Exposures (nothing stamped with
`runId = N+1`).

## No re-counting invariant

A holdover's reads through `read-variant()` do **not** fire a new Exposure event. The
Exposure pipeline receives nothing new for a holdover request. The dedup query counts the
Entity exactly once: under the Run whose `runId` is stored in `holdoverRecord.runId`.

This is a load-bearing implementation invariant. The pipeline must enforce it:

- Evaluate path returns `isHoldover: true` to signal "do not fire Exposure."
- `read-variant()` accessor checks `isHoldover` before firing (see
  [exposure-firing-and-accessor.md](./exposure-firing-and-accessor.md)).
- If the pipeline ever fires an Exposure for a holdover with the new `runId`, that Entity
  would appear in two Runs' denominators — a silent analysis corruption. Fail-loud if detected.

## Run-boundary KV window

For up to ~60s after a Run-boundary first-touch write, a concurrent cross-POP KV read may
miss the holdover and fall through to `assign(liveRun, targetingKey)` instead of replaying.
Since `assign()` is deterministic, a brand-new Entity gets the identical Variant the DO is
about to store — no corruption. A _returning_ holdover in this exact window may momentarily
get a fresh assignment instead of a replay — cosmetic and self-healing once KV propagates.
No Run dataset is corrupted; only momentary experience near a boundary. (ADR-0009 accepted.)

## Sources

- [../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (boundary behavior, holdover predicate)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
