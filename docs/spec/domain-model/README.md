# domain-model spec area

Canonical shapes, field lists, invariants, and lifecycle contracts for splitch's core domain. An implementing agent reads these instead of the ADRs. Cross-link to other spec areas; do not duplicate their contracts here.

## Spine idea

Assignment is pure. Exposure is the only event. The Run freezes bucketing (not measurement). These three facts compose into everything else: holdover semantics, dedup correctness, SRM, analysis denominators, and the Activation gate.

## Files

| File                                                       | Purpose                                                                                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [entities.md](./entities.md)                               | Canonical field lists for Organization, App, Flag, Variant, Experiment, Entity, and Evaluation Context                                                                                         |
| [run-lifecycle.md](./run-lifecycle.md)                     | Experiment Run state machine (draft → running → ended), edit taxonomy (assignment / measurement / non-material), draft/start model, Experiment Run entity fields                               |
| [assignment-exposure-run.md](./assignment-exposure-run.md) | The Assignment/Exposure/Run spine: Assignment as pure function, Exposure canonical row shape, holdover pseudocode, first-touch identity + wire dedup_key                                       |
| [assignment-store.md](./assignment-store.md)               | Assignment Store interface (`getAll` / `put`), key structure, substrate (KV read / DO write), failure contract, retention                                                                      |
| [exposure-dedup.md](./exposure-dedup.md)                   | First-touch dedup rule, two-layer dedup (SDK seen-set vs pipeline authority), `__multiple__` quarantine logic, SRM denominator, peek accessor                                                  |
| [activation-event.md](./activation-event.md)               | Activation Metric gate: ordering constraint (`activation_ts > first_exposure_ts`), Conversion Window re-anchoring, per-Run freeze, two mandatory bias guardrails, counterfactual row extension |
| [conflict-and-quarantine.md](./conflict-and-quarantine.md) | `__multiple__` quarantine: conflict definition, exhaustive root-cause list, why first-touch-wins is rejected, health-metric rate threshold                                                     |
| [metric-types.md](./metric-types.md)                       | Binomial / Count / Revenue / Ratio / Guardrail Metric field shapes, delta-method invariant, BH FDR family definition                                                                           |

## Key Invariants

- One Flag per Experiment; `experiment.flag_id` is a scalar.
- Draft → start model; N assignment edits become one sample reset.
- Activation Metric is an assignment-affecting edit and is frozen per Run.
- First Start opens the first Experiment Run; `"draft"` Experiment has no live Run.
- `live_run_id` is an explicit persisted field, not derived.
- DO is truth; KV miss is self-healing; no distributed transaction on the hot path.

## Cross-area links

- Evaluation path (evaluate seam, Provider, `assign()` implementation): see `evaluation/` area.
- Exposure pipeline (raw log, Tinybird schema, Copy Pipe): see `pipeline/` area.
- Stats engine (sequential testing, CUPED, delta-method): see `stats/` area.
- Control-plane API (Run CRUD, Start endpoint, measurement-edit endpoint): see `control-plane/` area.
