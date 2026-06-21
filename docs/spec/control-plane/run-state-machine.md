# Run state machine: states, transitions, and which endpoint triggers each

Pins the Run lifecycle so assignment-edit logic, holdover semantics, and invariant enforcement
in the Worker have a single unambiguous source. See [endpoints-experiment-run.md](endpoints-experiment-run.md)
for the full endpoint shapes (and [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md)
for the full endpoint index).

## States

```
draft ──[publish]──► running ──[end]──► ended
```

- **`draft`**: Experiment created; no live Run; Entities receive the Flag's Default Variant.
  Only one draft exists per Experiment at a time (the staging area for the next Run's config).
- **`running`**: The published Run; edge reads this config; Exposures are stamped with this `run_id`.
  Exactly one Run per Experiment is `running` at any time.
- **`ended`**: Run closed; config frozen archive; no new Exposures stamped against it; analysis still
  reads it.

There is no `paused` state in v1. Pausing is modeled as editing allocation to 0% (effectively stops
new Entities from being assigned) without closing the Run.

## Transitions

### draft → running: `POST /experiments/{experiment_id}/publish`

Triggered by: explicit user/agent Publish action.

What happens (atomic in the control-plane Worker, ordered):
1. Validate all draft config is valid (allocation sums to 100%, at least one Variant, Targeting Key set)
2. If a `running` Run exists: transition it to `ended`, set `ended_at = now()`
3. Create a new Run row in D1 with `status = running`, `started_at = now()`, `run_id = ulid()`
4. Copy frozen assignment config from Experiment draft fields into the Run row
5. Write `live_run_id = run_id` to KV for the edge (key: `live_run:{app_id}:{experiment_id}`)
6. Return the new Run object inline in the response (no separate GET needed)

**KV propagation:** ~60s until all POPs see the new `live_run_id` (accepted; self-healing per
ADR-0009). The Worker returns the new Run immediately; the edge catches up within the window.

**Assignment edits accumulate on the draft; Publish is the single reset point.** N edits = one
sample reset, not N.

### running → ended: `POST /runs/{run_id}/end`

Triggered by: explicit user/agent End action.

What happens:
1. Assert Run is `running`; reject with `RUN_NOT_RUNNING` if already ended
2. Set `status = ended`, `ended_at = now()` in D1
3. Clear `live_run_id` from KV (or write a sentinel value indicating no running Run)
4. Experiment reverts to draft state (receiving future edits as staging for Run N+2)
5. Return the ended Run object

Required role: App `owner` or `admin` (member cannot end a Run).

### What is never a valid transition

- `ended → running` (a Run cannot be restarted; open a new Run via Publish)
- `draft → ended` (no Run to end)
- Editing frozen fields on a `running` Run (rejected; draft fields are the staging area)

## Assignment config fields (frozen in a Run)

These fields are copied from the Experiment draft to the Run row at Publish time. They cannot be
PATCH'd on a Run — the PATCH-Run Zod schema omits them (Run-immutability enforced at parse time,
not just Worker logic):

- `salt` (string) — random per-Run seed for Fractional Evaluation
- `allocation` (object `{ [variant_name]: number }`) — percentages, must sum to 100
- `variant_set` (string[]) — names of Variants participating in this Run
- `targeting_key_field` (string) — which attribute from Evaluation Context is the Targeting Key
- `targeting_rules` (TargetingRule[]) — the ordered rule set
- `segment_ids` (string[]) — Segment filter for this Run
- `activation_metric_id` (string | null) — frozen at Publish; changes require new Run

## Measurement edit fields (apply to live Run in place, no Run reset)

These are PATCH'd on the Experiment (not the Run); they recompute over the existing raw log:
- Metric definitions, Conversion Window, Guardrail config
- Non-material edits: description, owner, tags

## Run D1 record shape

| column                  | type    | required | meaning                                                  |
|-------------------------|---------|----------|----------------------------------------------------------|
| `run_id`                | TEXT PK | yes      | `run_<ulid>`                                             |
| `experiment_id`         | TEXT FK | yes      | Parent Experiment                                        |
| `app_id`                | TEXT    | yes      | Denormalized for isolation seam scoping                  |
| `status`                | TEXT    | yes      | `running` \| `ended`                                     |
| `started_at`            | TEXT    | yes      | ISO 8601; set at Publish                                 |
| `ended_at`              | TEXT    | no       | ISO 8601; set at End                                     |
| `salt`                  | TEXT    | yes      | Frozen assignment seed                                   |
| `allocation`            | TEXT    | yes      | JSON: `{ [variant_name]: number }`                       |
| `variant_set`           | TEXT    | yes      | JSON: string[]                                           |
| `targeting_key_field`   | TEXT    | yes      | Frozen Targeting Key field name                          |
| `targeting_rules`       | TEXT    | yes      | JSON: TargetingRule[]                                    |
| `segment_ids`           | TEXT    | yes      | JSON: string[]                                           |
| `activation_metric_id`  | TEXT    | no       | Frozen Activation Metric; null if no gate                |
| `created_at`            | TEXT    | yes      | ISO 8601                                                 |

## Error codes for Run invariants

| code                    | when                                                             |
|-------------------------|------------------------------------------------------------------|
| `RUN_FROZEN`            | Attempt to mutate frozen assignment field on a running Run        |
| `RUN_NOT_RUNNING`       | Attempt to end a Run that is not `running`                        |
| `RUN_INVALID_ALLOCATION`| Allocation percentages do not sum to 100, or unknown variant name |
| `EXPERIMENT_NO_DRAFT`   | Publish attempted when draft has no changes from current Run      |

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
