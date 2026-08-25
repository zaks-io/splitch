# Assignment / Exposure / Run: the spine

Three domain terms, one immutable relationship. This is the subtlest correctness seam in splitch.

## Assignment

`assign(Run, targetingKey: string) -> variantName: string`

- **Pure deterministic function.** Same inputs always produce the same output.
- **Never recorded as an event.** There is no "assignment record" in any store.
- **Recomputable anywhere, anytime** — any of the five edge runtimes, offline, in backfills.
- **Pure _over a Run_.** The Run's frozen config (salt, allocation, Variant set, Targeting) is what makes determinism meaningful. The same `targetingKey` under a _different_ Run (different salt) may yield a different Variant — that is correct and expected.

Assignment leaves no trace. An Entity that is bucketable but has never been Exposed has **zero footprint**. This is not a limitation; it is the invariant that makes the holdover predicate work.

## Exposure

The **only event recorded on this seam.**

### Canonical Exposure row shape

| Field                | Type                         | Req | Meaning                                                                                                 |
| -------------------- | ---------------------------- | --- | ------------------------------------------------------------------------------------------------------- |
| `app_id`             | `string`                     | ✓   | Data-isolation key (injected at ingest, not from SDK)                                                   |
| `environment_id`     | `string`                     | ✓   | Environment scope; Exposures are per-Environment (injected at ingest, not from SDK) (ADR-0027)          |
| `experiment_id`      | `string`                     | ✓   | Experiment identifier                                                                                   |
| `run_id`             | `string`                     | ✓   | Experiment Run that owns this Exposure; stamped at SDK fire-time from the live Run config the SDK holds |
| `targeting_key_hash` | `string`                     | ✓   | HMAC-derived Entity identifier                                                                          |
| `id_type`            | `string`                     | ✓   | Entity type (e.g. `"user"`, `"workspace"`); always explicit, never derived                              |
| `variant`            | `string`                     | ✓   | Variant **name** assigned; never the value                                                              |
| `exposure_at`        | `timestamp`                  | ✓   | Canonical encounter time; remote receive time or verified trusted server commit (ADR-0049)              |
| `server_received_at` | `timestamp`                  | ✓   | When Splitch durably accepted the row; delivery diagnostics and retention                               |
| `client_timestamp`   | `timestamp \| null`          | ✗   | Client-fired time; diagnostics only                                                                     |
| `type`               | `"exposure" \| "activation"` | ✓   | Row type discriminator (unified event log; see [activation-event.md](./activation-event.md))            |
| `counterfactual`     | `boolean`                    | ✓   | `true` only on Control-arm would-have-activated events (additive deferred extension; false by default)  |

**`run_id` stamping:** stamped at SDK fire-time using the live Run config the SDK currently holds. The SDK is responsible for carrying `run_id` from its most recent flag resolution. The pipeline validates `run_id` is a known Run for the Experiment at ingest; malformed rows are quarantined.

**`id_type` is always required.** It is explicit on every Exposure row (not derived from Experiment config) to guard against Targeting Key value collisions across Entity types.

### First-touch identity

`(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`

This is the first-touch identity, resolved by `MIN(exposure_at)` at query time. (`environment_id` co-scopes alongside `app_id` since Exposures are per-Environment, ADR-0027.) Many raw Exposures for the same Entity/Run share it; the earliest encounter wins. Variant is **excluded** so that different-Variant Exposures for the same Entity/Run are not suppressed; they arrive at the `__multiple__` quarantine query downstream (see [exposure-dedup.md](./exposure-dedup.md)). This is distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key for at-least-once ingest); see [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

### Exposure fires on read

Reading a Variant through the standard SDK accessor fires the Exposure as a side effect. You cannot branch on the Variant without being exposed. This kills the #1 real-world experimentation bug: evaluate → branch → forget to fire exposure → silent under-exposure.

**Peek accessor:** a distinct, loudly-named SDK method (e.g. `sdk.peekVariant(...)`) that resolves the Variant without firing an Exposure. Peeked Entities are **not eligible for analysis**: no Exposure row, no Conversion Window anchor, no inclusion in SRM denominator.

## Run

See [run-lifecycle.md](./run-lifecycle.md) for the state machine and edit taxonomy.

**Key invariants in scope here:**

- Every Exposure is stamped with `run_id`. Analysis (SRM, significance, Conversion Window) is always scoped to a single Run.
- Runs are **independent**: the latest Run is the live result; prior Runs are frozen archives, **never pooled**. Pooling is a future explicit guarded feature.
- **Assignment is pure over a Run.** Because the Run's config is frozen, re-bucketing within a Run is impossible by construction.

## Holdover semantics (Run boundary)

When Run N ends and Run N+1 opens, a returning Entity already **exposed** under Run N is a **holdover.**

```
on evaluate(flag, targetingKey, idType):
  validatedIdType = assertMatchesExperiment(idType, experiment.targetingKeyType)
  held = AssignmentStore.getAll(appId, environmentId, validatedIdType, targetingKey)
  if held[experiment] present:           # holdover: exposed under a prior Run
      show held[experiment].variant      # sticky experience — no jarring flip
      do NOT fire a new Exposure         # already counted, attached to the old Run
  else:                                  # new / never-exposed Entity
      variant = assign(liveRun, targetingKey)
      # Exposure fires on read; pipeline writes holdover to Assignment Store at first-touch
```

**Sticky experience (assignment-for-experience):** holdover sees its prior Variant. Avoids mid-experiment flip / carryover bias.

**Run attribution (assignment-for-analysis):** holdover Exposures remain attached to the Run in which they were first recorded. They are **not re-counted** in Run N+1. Run N+1's dataset contains only Entities first-exposed under N+1's config.

**Holdover predicate:** "has a first-touch Exposure under a prior Run." Because Assignment is pure and leaves no trace, an Entity that was bucketable-but-never-exposed under Run N is simply a new Entity to Run N+1 — correct and free.

**Sticky experience requires persisting the original Variant.** `assign()` cannot recompute it once Run N's config is gone. This is the single piece of durable per-Entity state on the seam: see [assignment-store.md](./assignment-store.md).

## Seam contract

This is a **single-implementation boundary** for the Assignment function (it is a pure hash with no port needed). The Exposure event and the Assignment Store are the seam boundaries that do carry ports. The Assignment-as-pure-function earns its keep by the deletion test: removing the purity guarantee would force the holdover predicate, SRM, and diagnostic replay to consult a stored assignment log — a superposition-generating write that gains nothing.

## Sources

- [ADR-0001](../../adr/0001-assignment-is-pure-not-an-event.md)
- [ADR-0002](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [ADR-0003](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md)
