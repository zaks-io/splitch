# Run lifecycle and state machine

A Run is the immutable unit of analysis for an Experiment. Its assignment config (salt,
allocation, Variant set, Targeting rules, Targeting Key) is frozen for its entire life.

## Identity

| Field | Type | Required | Meaning |
|---|---|---|---|
| `runId` | string | yes | Unique per Experiment; immutable once created |
| `experimentId` | string | yes | Parent Experiment |
| `appId` | string | yes | Isolation boundary; always scoped |
| `startedAt` | ISO 8601 | yes | When the Run went live (explicit Publish action) |
| `endedAt` | ISO 8601 | optional | Set when the Run closes; absent means live |

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
                  [Publish / Start]
                         v
                       running  <------- assignment edit accumulates on next draft
                         |
                  [assignment edit published]
                         v
                       ended
                  (frozen archive)
```

States: `draft → running → ended`

- **draft**: The staging area for the *next* Run. A newly created Experiment has one draft
  and no live Run. Entities receive the Flag's Default Variant until Publish.
- **running**: Published at least once; one Run is live. `running` is the only state in
  which Exposures stamp with this Run's `runId`.
- **ended**: Closed by a subsequent Publish. Permanently frozen; `endedAt` is set; prior
  Exposures remain attributed here.

The draft is not a Run state; it is the staging area that accumulates edits before the
next Publish. One explicit Publish ends the live Run and opens exactly one new Run carrying
all batched changes: N edits = one sample reset, not N.

## Frozen config (assignment edits — opens new Run)

Changes to these fields are **assignment-affecting edits**. They end the current Run and
open a new one (sample resets to zero; UI must warn loudly):

- `salt` — per-experiment bucketing seed
- `allocation` — Variant proportions (weights)
- `variantSet` — the set of Variants
- `targetingRules` — rule set (Conditions, Segments, Percentage Rollouts)
- `targetingKey` — which Entity attribute to bucket on
- **Activation Metric** — re-anchors the Conversion Window retroactively; redefines the
  analysis population's entry timestamp. A bucketing-class change. This amends ADR-0003,
  which had filed Activation config under measurement edits.

## Recomputable config (measurement edits — no new Run)

Changes to these fields apply to the live Run in place and **recompute over existing raw log**:

- Metric definitions (Binomial / Count / Revenue / Ratio)
- Conversion Window
- Guardrail Metric config
- Activation Metric is specifically excluded; see above.

The raw Exposure log is the system of record (append-only, never mutated); recomputing is a
re-run of the dedup/metric query with the new definition. No new `runId`, no sample reset.

## Non-material edits (in place, same Run)

- `description`, `owner`, `tags`, `notes`, display name, dashboard layout.
  Mutate in place; no change to `runId`, no recompute.

## Run independence

- The latest Run is the live result.
- Prior Runs are frozen archives; never pooled by default (pooling is a documented future
  extension — v1 Flag/Experiment scope).
- Prior Run's Exposures stay attributed to their own `runId`; they never accrue to the new Run.

## No-superposition guarantee

The three edit types map to distinct, observable outcomes:
- Assignment edit → new `runId` in KV, new Run in D1 after Publish.
- Measurement edit → same `runId`, analysis query re-runs.
- Non-material edit → same `runId`, no query impact.

A caller can always determine which case occurred by inspecting whether `runId` changed.

## Live Run is explicit persisted config

The published config the edge reads (KV) carries `liveRunId`. Publishing writes the new
`liveRunId`. Drafts never reach the edge. ~60s KV propagation window applies (self-healing,
per ADR-0009).

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (Run lifecycle section)
