# The Assignment / Exposure seam

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture terms (module, seam,
adapter, depth, locality) per the deepening discipline.

This is the subtlest correctness seam in splitch. Get it wrong and experiments are silently
invalidated (SRM-style) in ways that are near-impossible to debug after the fact. It was designed
upfront, before any code, so the first code lands deep.

## The spine

Three domain terms, one immutable relationship between them:

- **Assignment** — a **pure deterministic computation**, `assign(Run, Targeting Key) -> Variant`.
  Never an event, never recorded on its own. Recomputable anywhere, anytime (any of the five
  runtimes, offline, in a backfill).
- **Exposure** — the **only event recorded on this seam**. Carries
  `(app_id, environment_id, Targeting Key, Experiment, Run, Variant, timestamp)`. Deduped to **unique
  Entities per Run, first-touch**. This is the denominator for all analysis. `app_id` and
  `environment_id` co-scope every record because Experiments and their Runs are per-Environment
  (ADR-0027); they ride through dedup as carried scope columns, never collapsing rows.
- **Run** — a **time-boxed, immutable window** of an Experiment. Config (salt, allocation, Variant
  set, Control identity, Targeting) is frozen for the Run's life. The **unit of analysis**. A material config edit ends
  one Run and opens the next, keeping each Run's dataset clean. Because the Run is immutable,
  assignment is pure over it and re-bucketing within a Run cannot happen by construction.

## Why this is a deep module

A small interface — `assign()` (pure) + one Exposure event + Run-scoped analysis — sits in front of:
deterministic bucketing, config-change safety, dedup across a distributed edge, SRM, significance,
and Conversion Window anchoring. The complexity is concentrated, not smeared across call sites.

**Deletion test**: collapse Run into a bare `configVersion` counter and the complexity reappears at
every analysis query (which versions are comparable? where did re-bucketing happen?). The Run earns
its keep — it _is_ the "this dataset is analyzable as a unit" invariant, made explicit.

## Core Invariants

1. **Assignment is a pure function, not an event.** Determinism means you never persist it — you
   recompute it. Advanced diagnostics (deterministic replay to separate a bucketing bug from an
   exposure bug) are therefore available _on demand later_, without recording anything extra now.

2. **The Run is the unit of analysis; Exposure is stamped with `runId`.** Replaces an ad-hoc
   `configVersion`. The immutability invariant is what SRM, significance, and Conversion Windows all
   silently depend on. Config edits open a new Run rather than mutating in place.

3. **Exposure fires on read (safe default).** Reading a Variant through the SDK accessor fires the
   Exposure as a side effect — you cannot branch on the Variant without having been exposed. Kills the
   #1 real-world experimentation bug (evaluate, branch, forget to fire exposure → silent, often
   differential, under-exposure). Deferral (below-the-fold) is a distinct, loudly-named
   "peek without exposing" accessor. The side-effecting read must be documented prominently.

4. **Dedup = unique Entities per Run, first-touch.** Exposure-on-read makes raw exposures
   many-per-Entity, so dedup is forced, not optional. Earliest exposure per (Entity, Run) wins because
   the Conversion Window anchors to it and a later anchor would let post-treatment behavior bias
   results. Two layers, two jobs: **SDK seen-set = hot-path/wire efficiency** (per-instance, not
   trusted); **pipeline dedup = correctness authority** (`GROUP BY entity, run`, `MIN(timestamp)`).
   Across five edge runtimes the SDK set is per-node and _cannot_ be the source of truth, so the
   pipeline dedup is the only correct one. Session is a **Dimension**, never the denominator unit.

5. **SRM is a standard query, not a built mechanism.** Chi-square of observed Exposure counts per
   Variant against the Run's **declared** allocation. No second event stream. (Deterministic replay of
   `assign()` over the exposed keys is a future root-causing tool if SRM ever fires — not a design
   commitment.)

## Run lifecycle

The Run freezes **bucketing**: a Run means _assignment_ was frozen for its entire life. Measurement is
**not** frozen into the Run; it recomputes losslessly over the Run's raw log (ADR-0003).

### Assignment vs measurement vs non-material edits

- **Assignment edit → ends the current Run, opens the next** (changes `assign()` or how its result is
  interpreted, so prior data is no longer comparable): salt, allocation, Variant set, Control identity,
  Targeting/Segment, Targeting Key.
- **Measurement edit → recompute over the existing Run, no reset** (changes what the numbers mean, not who is
  in which arm): Metric definitions, Conversion Window, Guardrail/Activation config. The raw Exposure/event
  log is the system of record (ADR-0010), so the dedup/metric query simply re-runs with the new definition —
  Eppo/Statsig/GrowthBook all do this.
- **Non-material → mutate in place, same Run**: description, display name, owner, tags, notes, dashboard
  layout.

### Runs are independent

Each Run accumulates exposures from zero. The **latest Run is the live result**; prior Runs are
viewable **frozen archives**, never pooled. An **assignment edit** therefore **resets the sample** — the UI
must warn loudly, because the prior Run's exposures do not count toward the new Run's significance. (A
measurement edit does not reset; it recomputes.) This is the statistically honest default (GrowthBook "be
very careful with phases") and is the only choice coherent with "assignment edit → new Run": pooling across a
bucketing change would hand back the integrity the Run exists to protect. Pooling, if ever needed, is a
future explicit feature with loud guardrails — not the default. A future opt-in **locked-analysis /
pre-registration** mode could additionally freeze measurement per experiment for teams that want that
discipline; that is additive, not the default (ADR-0003).

### Boundary behavior: sticky experience, counted in the old Run

When Run N ends and Run N+1 opens, a returning Entity already **exposed** under Run N is a **holdover**:

```
on evaluate(flag, targetingKey) when live Run is N+1:
  if Entity has a first-touch Exposure under Run N (or any prior Run of this Experiment):
      show the Variant from that prior Run        # sticky EXPERIENCE — no jarring flip
      do NOT record a new exposure                # already counted, attached to the old Run
  else:
      variant = assign(Run N+1, targetingKey)     # clean new-Run assignment
      # exposure fires on read, first-touch, stamped runId = N+1
```

This separates two ideas usually conflated:

- **Assignment-for-experience** (which Variant to _show_ a returning user) → sticky, avoids carryover
  bias from a mid-stream flip.
- **Assignment-for-analysis** (which Run's denominator the Entity counts toward) → the Run it was
  _first exposed_ under, never reassigned.

Run N+1's dataset stays pure (only Entities first-exposed under N+1's config), and users don't get
whiplash. A holdover is "shown the experiment but not measured by the live Run" — legible because every
exposure already carries its `runId`.

### The holdover predicate, and the one piece of durable per-Entity state

- **Holdover = has a first-touch Exposure under a prior Run.** Not "was assigned" — assignment is pure
  and leaves no trace, so an Entity bucketable-but-never-exposed under Run N is simply a _new_ Entity to
  Run N+1 (correct, and free). Only an **Exposure** marks entry into a Run.
- **Sticky experience requires persisting the holdover's original Variant.** `assign()` cannot recompute
  it (Run N's config may be gone). So the system keeps exactly one piece of durable per-Entity state:
  `(Experiment, Targeting Key) -> (runId, Variant)`, written at first Exposure. This is precisely what
  Statsig "Persistent Assignment" / GrowthBook "Sticky Bucketing" store. Bounded (only exposed Entities).
- **This is the ONLY per-Entity durable state on the seam.** Everything else is pure-compute or
  append-only events. It needs a low-latency read on the evaluate path — on a five-runtime edge that is
  an architectural constraint (wants to be fast and edge-local). Thread into the Provider/storage grill.

## Vocabulary discipline applied

- Added **Run** to CONTEXT.md (canonical; _avoid_ phase/version/configVersion/analysis-window).
- Corrected **Assignment**: it was defined as "the event that an Entity was bucketed" — it is **not**
  an event. Now: a pure computation, recomputed not recorded.
- Updated **Exposure**: single recorded event, carries `runId`, first-touch dedup, exposure-on-read.
- Rejected introducing **"grain"** as a domain term. It is Kimball dimensional-modeling language for a
  fact-table row level — warehouse-internal only, quarantined like Flagship's "Variation." The domain
  says "unique Entities per Run," pairing two existing terms, not a new synonym.

## Open edge (next grill)

- **Activation Metric gating** — "filter analysis to Entities who first performed a defined action."
  It sits on this same seam because activation re-anchors which Exposure is the relevant first-touch
  (you may anchor the Conversion Window to the activation event rather than first Exposure). Grill next.

## Candidate ADRs

The load-bearing decisions worth recording so future architecture reviews don't re-litigate them:
pure-assignment-not-an-event; Run-as-immutable-unit-of-analysis; exposure-fires-on-read;
first-touch-dedup-authoritative-in-pipeline.
