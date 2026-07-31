# Experiment Run state machine: states, transitions, and which endpoint triggers each

Pins the Experiment Run lifecycle so assignment-edit logic, holdover semantics, and invariant
enforcement in the Worker have a single unambiguous source. See
[endpoints-experiment-run.md](endpoints-experiment-run.md) for the full endpoint shapes (and
[control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md) for the full endpoint
index).

Per-Environment (ADR-0027): a Run belongs to an Experiment in one Environment; `run_id`, the
`live_run_id` KV key, and every Exposure are scoped to `(app_id, environment_id, experiment_id)`. The
lifecycle verb is **Start** (not "publish").

## States

```
draft ──[start]──► running ──[end]──► ended
```

- **`draft`**: Experiment created; no live Run; Entities receive the Flag's Default Variant.
  Only one draft exists per Experiment at a time (the staging area for the next Run's config).
- **`running`**: The started Run; edge reads this config; Exposures are stamped with this `run_id`.
  Exactly one Run per Experiment is `running` at any time.
- **`ended`**: Run closed; config frozen archive; no new Exposures stamped against it; analysis still
  reads it.

There is no `paused` state. Pausing is modeled as editing allocation to 0% (effectively stops
new Entities from being assigned) without closing the Run.

## Transitions

### draft → running: `POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/start`

Triggered by: explicit user/agent Start action. **Subject to the Environment Policy** (ADR-0029): if
this Environment gates "Start an Experiment Run" at `confirm`, the proposer must perform the
canonical `approve_and_apply` Review before it commits. The Confirmation UI is the proposer
self-reviewing the durable Approval Request, not a separate pipeline.

What happens, ordered:

1. Validate all draft config is valid (allocation sums to 100%, at least one Variant, Targeting Key set,
   every Variant available in this Environment per ADR-0028)
2. Under `allow`, enter the application seam directly. Under `confirm` or future `approve`, resolve
   the `pending` Approval Request and authorize the Review from current membership and Policy.
3. Recompute the Experiment-draft target version, including `live_run_id` and the relevant
   Environment Policy projection; a mismatch records `stale` and applies nothing.
4. In one D1 transaction, end the existing running Run if present, create the new `running` Run with
   its frozen draft config, and update the Experiment's canonical `live_run_id`. On an
   approval-gated path, the same transaction also records the successful Review and resulting
   version and moves the Approval Request to `applied`.
5. After D1 commit, project the new Run config and
   `live_run:{app_id}:{environment_id}:{experiment_id}` pointer to KV.
6. Return the new Run object and the applied Approval Request inline, or `null` under `allow` (no
   separate GET needed).

Review authorization and target-version validation precede any canonical mutation. If application
inside step 4 fails, D1 rolls back the Run mutation and, on an approval-gated path, its Approval
Request and Review changes. A failed gated Review attempt is recorded separately and the request
remains `pending`; an `allow` failure returns the underlying application error. A KV failure in
step 5 is a loud, retryable projection failure, not an application rollback: D1 has already
committed the canonical mutation.

**KV propagation:** ~60s until all POPs see the new `live_run_id` (accepted; self-healing per
ADR-0009). The Worker returns the new Run immediately; the edge catches up within the window.

**Assignment edits accumulate on the draft; Start is the single reset point.** While a Run is
running, the PATCH must explicitly carry `stageForNextRun: true`; an ordinary assignment PATCH is
refused with `RUN_FROZEN`. N staged edits = one sample reset, not N.

### running → ended: `POST /apps/{app_id}/envs/{environment_id}/runs/{run_id}/end`

Triggered by: explicit user/agent End action.

What happens:

1. Assert Run is `running`; reject with `RUN_NOT_RUNNING` if already ended
2. Set `status = ended`, `ended_at = now()` in D1
3. Clear `live_run_id` from KV (or write a sentinel value indicating no running Run)
4. Experiment reverts to draft state (receiving future edits as staging for Run N+2)
5. Return the ended Run object

Required role: App `owner` or `admin` (member cannot end a Run).

### What is never a valid transition

- `ended → running` (a Run cannot be restarted; open a new Run via Start)
- `draft → ended` (no Run to end)
- Editing frozen fields on a `running` Run (rejected; draft fields are the staging area)

## Assignment config fields (frozen in a Run)

These fields are copied from the Experiment draft to the Run row at Start time. They cannot be
PATCH'd on a Run — the PATCH-Run Zod schema omits them (Run-immutability enforced at parse time,
not just Worker logic):

- `salt` (string) — random per-Run seed for Fractional Evaluation
- `allocation` (object `{ [variant_name]: number }`) — percentages, must sum to 100
- `variant_set` (string[]) — names of Variants participating in this Run
- `targeting_key_field` (string) — which attribute from Evaluation Context is the Targeting Key
- `targeting_key_type` (string) — Entity type label (the Run's `id_type`); changes require a new Run
- `targeting_rules` (TargetingRule[]) — the resolved rule snapshot. Any draft `segment_ids` are
  resolved to their concrete rules at Start and merged in here; the Run stores the frozen rules, never
  the segment references (a later Segment edit cannot change a finished Run's population)
- `activation_metric_id` (string | null) — frozen at Start; changes require new Run

## Measurement edit fields (apply to live Run in place, no Run reset)

These are PATCH'd on the Experiment (not the Run); they recompute through
`serve_deduped_exposures` and `serve_deduped_metric_events`, never by scanning a physical Metric log:

- Metric definitions, Conversion Window, Guardrail config
- Non-material edits: description, owner, tags

## Decision spec fields (locked in a Run)

These fields are copied into the Run at Start time and define what can produce
decision-valid significance or Guardrail breach output:

- `confidence_level`
- `horizon` and fixed/sequential tuning (`sample_size_locked`, `target_n`)
- goal Metric family members
- Primary Dimension members and declared values
- Guardrail Metric thresholds and directions

Post-start edits may recompute exploratory views over the same canonical serving layers, but they do
not mutate the current Run's decision spec. The Worker rejects attempts to change these fields for
the current decision-valid result with `DECISION_LOCKED`.

## Run D1 record shape

| column                 | type    | required | meaning                                                                        |
| ---------------------- | ------- | -------- | ------------------------------------------------------------------------------ |
| `run_id`               | TEXT PK | yes      | `run_<ulid>`                                                                   |
| `experiment_id`        | TEXT FK | yes      | Parent Experiment                                                              |
| `app_id`               | TEXT    | yes      | Denormalized for isolation seam scoping                                        |
| `environment_id`       | TEXT    | yes      | Denormalized; co-scope with `app_id` (ADR-0027)                                |
| `status`               | TEXT    | yes      | `running` \| `ended`                                                           |
| `started_at`           | TEXT    | yes      | ISO 8601; set at Start                                                         |
| `ended_at`             | TEXT    | no       | ISO 8601; set at End                                                           |
| `salt`                 | TEXT    | yes      | Frozen assignment seed                                                         |
| `allocation`           | TEXT    | yes      | JSON: `{ [variant_name]: number }`                                             |
| `variant_set`          | TEXT    | yes      | JSON: string[]                                                                 |
| `targeting_key_field`  | TEXT    | yes      | Frozen Targeting Key field name                                                |
| `targeting_key_type`   | TEXT    | yes      | Frozen Entity type label (the Run's `id_type`)                                 |
| `targeting_rules`      | TEXT    | yes      | JSON: TargetingRule[]; resolved snapshot (draft segments resolved in at Start) |
| `activation_metric_id` | TEXT    | no       | Frozen Activation Metric; null if no gate                                      |
| `confidence_level`     | REAL    | yes      | Locked decision alpha input; default 0.95                                      |
| `horizon`              | TEXT    | yes      | `sequential` \| `fixed`; locked at Run Start                                   |
| `target_n`             | INTEGER | no       | Sequential tuning target; null unless set                                      |
| `sample_size_locked`   | INTEGER | no       | Fixed-horizon sample size; required when `horizon = fixed`                     |
| `decision_family`      | TEXT    | yes      | JSON: locked goal Metric × Variant × Primary Dimension members                 |
| `guardrail_decisions`  | TEXT    | yes      | JSON: locked Guardrail Metric thresholds/directions                            |
| `created_at`           | TEXT    | yes      | ISO 8601                                                                       |

## Error codes for Run invariants

These are the canonical `ErrorCode` values relevant to Run lifecycle. Codes, detail shapes, and
HTTP status live once in [../contracts/error-responses.md](../contracts/error-responses.md); this
table is the Run-scoped subset for quick reference (it names codes, not statuses, to avoid drift).

Operational codes carry a machine-stable `recommendedAction` in `details` (canonical mapping in
[../contracts/error-responses.md](../contracts/error-responses.md#recommendedaction-machine-stable-recovery-guidance));
the `recovery` column below mirrors it for quick reference.

| code                    | when                                                                                    | `recommendedAction`     |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| `RUN_FROZEN`            | Attempt to mutate a frozen assignment field on a running Run                            | `CREATE_NEW_RUN`        |
| `RUN_NOT_RUNNING`       | Attempt to end (or otherwise run-only-op) a Run that is not `running`                   | `START_A_RUN`           |
| `ALLOCATION_INVALID`    | Allocation percentages do not sum to 100, or unknown variant name                       | — (fix the request)     |
| `EXPERIMENT_NO_DRAFT`   | Start attempted when draft has no changes from current Run                              | `EDIT_DRAFT_THEN_START` |
| `VARIANT_NOT_AVAILABLE` | A referenced Variant is not in the Flag's available set for this Environment (ADR-0028) | `ADD_VARIANT_TO_ENV`    |

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
