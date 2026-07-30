# Experiment Run lifecycle: state machine, edit taxonomy, and draft/start model

## Experiment Run entity fields

| Field                | Type                             | Req | Meaning                                                            |
| -------------------- | -------------------------------- | --- | ------------------------------------------------------------------ |
| `run_id`             | `string` (ULID)                  | ✓   | Unique, monotonically increasing within Experiment                 |
| `experiment_id`      | `string` (ULID)                  | ✓   | Owning Experiment                                                  |
| `app_id`             | `string` (ULID)                  | ✓   | Owning App                                                         |
| `environment_id`     | `string` (ULID)                  | ✓   | Owning Environment; Experiment Runs are per-Environment (ADR-0027) |
| `run_number`         | `integer`                        | ✓   | 1-based ordinal within Experiment; Run 1 = first Start             |
| `status`             | `RunStatus`                      | ✓   | `"running" \| "ended"`                                             |
| `salt`               | `string`                         | ✓   | Frozen at Run creation; drives Fractional Evaluation hash          |
| `allocation`         | `AllocationMap`                  | ✓   | `{ variantName: percentage }` summing to 100; frozen               |
| `control_variant_id` | `string` (ULID)                  | ✓   | Control identity frozen from the Experiment at Start               |
| `targeting_key_type` | `string`                         | ✓   | Frozen entity-type name                                            |
| `targeting_rules`    | `TargetingRule[]`                | ✓   | Priority-ordered; frozen at Run creation                           |
| `activation_metric`  | `ActivationMetricConfig \| null` | ✓   | Frozen at Run creation                                             |
| `started_at`         | `timestamp`                      | ✓   | When this Run went live (Start timestamp)                          |
| `ended_at`           | `timestamp \| null`              | ✓   | Set when a subsequent assignment edit starts a new Run             |

`AllocationMap` example: `{ "control": 50, "treatment": 50 }`. Values are percentages (not fractions).

## Experiment status

`ExperimentStatus = "draft" | "running" | "ended"`

- `"draft"` — created, never started. Entities receive the Flag's Default Variant.
- `"running"` — started at least once; has a live Run. `live_run_id` is non-null.
- `"ended"` — deliberately stopped; no live Run. Historical Runs remain as frozen archives.

## Experiment Run state machine

```
[created]
    │  first Start (first-Start Run rule)
    ▼
 running ──── assignment edit → Start ───► running (new Run N+1, Run N ends)
    │
    └─── Stop / End Experiment ──────────────► ended
```

**First Experiment Run opens on first Start.** A newly created Experiment is a draft with no Run; `live_run_id = null`. The Experiment transitions to `"running"` only after an explicit Start. (first-Start Run rule)

**Start is the only way to open a new Run.** Assignment-affecting edits accumulate on the draft; one Start ends the live Run and opens exactly one new Run carrying all batched changes. N edits = one sample reset, not N.

## Edit taxonomy

### Assignment-affecting edits → draft; opens new Run on Start

These change `assign()`, so Exposures collected before and after are in incomparable buckets:

| What changed                              | Why it's assignment-affecting                                        |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `salt`                                    | Changes the Fractional Evaluation hash; re-buckets every Entity      |
| `allocation`                              | Changes bucket boundaries; may move Entities between Variants        |
| Variant set (add/remove/rename Variant)   | Changes the range of `assign()`                                      |
| Control identity                          | Changes the baseline used to interpret every result                  |
| Targeting / Segment config                | Changes which Entities are eligible and which rule wins              |
| `targeting_key_type` (Targeting Key type) | Changes the bucketing identity                                       |
| Activation Metric config                  | Re-anchors Conversion Window retroactively; a bucketing-class change |

**Activation Metric is an assignment-affecting edit.** This amends ADR-0003, which originally filed Activation config under measurement edits. Setting or changing the Activation Metric re-anchors the Conversion Window retroactively, redefining the analysis population's entry timestamp. It is therefore frozen per Run.

### Measurement edits → applied to live Run in place; recompute, no reset

These change what the numbers mean, not who is in which arm. The raw Exposure/event log is the system of record (ADR-0010); the dedup/metric query re-runs with the new definition over the same raw log.

| What changed                                                  |
| ------------------------------------------------------------- |
| Metric definitions (name, aggregation, event name, threshold) |
| Conversion Window length                                      |
| Guardrail Metric config (add/remove/change threshold)         |
| Secondary Metric config                                       |

**Recompute timing:** eventual. Recomputing re-runs the Tinybird query over the full raw log; the pipeline may buffer recent Exposures. The UI shows stale results with a "recomputing" state indicator and refreshes when ready. There is no blocking SLA; the recompute is background, not synchronous.

### Non-material edits → mutate in place, same Run, no recompute

| What changed                   |
| ------------------------------ |
| `description`, `hypothesis`    |
| `owner`                        |
| `tags`                         |
| Dashboard layout, display name |
| Metric display label / notes   |

## Live Run and the edge

The live config the edge reads (KV) carries `liveRunId`. The edge stamps Exposures with it. Drafts never reach the edge. Starting a Run writes the new `liveRunId` to KV; the ~60s KV propagation window (ADR-0009) is accepted as self-healing.

**Run N+1 is created synchronously on Start.** The control plane creates the Run record and updates `live_run_id` in D1, then writes to KV, then broadcasts the live-config nudge. The nudge is never broadcast before D1 commits.

## Concurrent assignment edits

Assignment-affecting edits are serialized: only one draft per Experiment at a time. The control plane rejects a second concurrent assignment edit while a first is awaiting Start. This is the correct posture: `__multiple__` quarantine catches defects, not expected concurrency races.

## Sources

- [ADR-0002](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [ADR-0003](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md)
