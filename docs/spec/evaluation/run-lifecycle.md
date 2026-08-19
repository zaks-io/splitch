# Run lifecycle and state machine

A Run is the immutable unit of analysis for an Experiment. Its assignment config (salt,
allocation, Variant set, Control identity, Targeting rules, Targeting Key) is frozen for its entire
life.

## Identity

| Field           | Type     | Required | Meaning                                                                |
| --------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `runId`         | string   | yes      | Unique per Experiment; immutable once created                          |
| `experimentId`  | string   | yes      | Parent Experiment                                                      |
| `appId`         | string   | yes      | Isolation boundary; always scoped                                      |
| `environmentId` | string   | yes      | Co-scoped with `appId`; Experiment Runs are per-Environment (ADR-0027) |
| `startedAt`     | ISO 8601 | yes      | When the Run went live (explicit Start action)                         |
| `endedAt`       | ISO 8601 | optional | Set when the Run closes; absent means live                             |

## State machine

```
                  [Experiment created]
                         |
                         v
                       draft
                  (no live Run;
                  Entities see
                  Default Variant)
                         |
                  [Start]
                         v
                       running  <------- assignment edit accumulates on next draft
                         |
                  [assignment edit started]
                         v
                       ended
                  (frozen archive)
```

States: `draft → running → ended`

- **draft**: The staging area for the _next_ Run. A newly created Experiment has one draft
  and no live Run. Entities receive the Flag's Default Variant until Start.
- **running**: Started at least once; one Run is live. `running` is the only state in
  which Exposures stamp with this Run's `runId`.
- **ended**: Closed by a subsequent Start. Permanently frozen; `endedAt` is set; prior
  Exposures remain attributed here.

The draft is not a Run state; it is the staging area that accumulates edits before the
next Start. One explicit Start ends the live Run and opens exactly one new Run carrying
all batched changes: N edits = one sample reset, not N.

## Frozen config (assignment edits — opens new Run)

Changes to these fields are **assignment-affecting edits**. They end the current Run and
open a new one (sample resets to zero; UI must warn loudly):

- `salt` — per-experiment bucketing seed
- `allocation` — Variant proportions (weights)
- `variantSet` — the set of Variants
- `controlVariantId` — the Control identity copied from the Experiment at Start
- `targetingRules` — rule set (Conditions, Segments, Percentage Rollouts)
- `targetingKey` — which Entity attribute to bucket on
- **Activation Metric** — re-anchors the Conversion Window retroactively; redefines the
  analysis population's entry timestamp. A bucketing-class change. This amends ADR-0003,
  which had filed Activation config under measurement edits.

## Recomputable config (measurement edits — no new Run)

Changes to these fields apply to the live Run in place and **recompute through the canonical serving
layers**:

- Metric definitions (Binomial / Count / Revenue / Ratio)
- Conversion Window
- Guardrail Metric config
- Activation Metric is specifically excluded; see above.

The append-only raw logs remain systems of record, but recomputation reads
`serve_deduped_exposures` and `serve_deduped_metric_events`, not a physical Metric log. It re-runs the
logical dedup/metric query with the new definition. No new `runId`, no sample reset.

## Non-material edits (in place, same Run)

- `description`, `owner`, `tags`, `notes`, display name, dashboard layout.
  Mutate in place; no change to `runId`, no recompute.

## Run independence

- The latest Run is the live result.
- Prior Runs are frozen archives; never pooled by default (pooling is a documented future
  extension — one-Flag Experiment scope).
- Prior Run's Exposures stay attributed to their own `runId`; they never accrue to the new Run.

## No-superposition guarantee

The three edit types map to distinct, observable outcomes:

- Assignment edit → new `runId` in KV, new Run in D1 after Start.
- Measurement edit → same `runId`, analysis query re-runs.
- Non-material edit → same `runId`, no query impact.

A caller can always determine which case occurred by inspecting whether `runId` changed.

## Live Run is explicit persisted config

The live config the edge reads carries `liveRunId`. Start writes the new `liveRunId`. Drafts never
reach the edge. The five-second Flag Configuration propagation contract applies.

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (Run lifecycle section)
