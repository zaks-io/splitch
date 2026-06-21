# Evaluation area spec

The evaluation area covers the hot-path from "SDK calls evaluate" to "Variant returned and
Exposure fired." Everything here is about contracts and shapes, not implementation.

**Spine idea:** Assignment is a pure function over a frozen Run. The evaluate path
orchestrates two sibling seams (Provider for config, Assignment Store for holdovers) with
zero superposition — every branch is visible, every decision maps to one pointable line.

## Files

| File                                                                     | Purpose                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [assign-pure-function.md](./assign-pure-function.md)                     | `assign(Run, targetingKey) -> variantName` — signature, determinism contract, no-event discipline                                                                   |
| [run-lifecycle.md](./run-lifecycle.md)                                   | Run state machine (`draft → running → ended`), the three edit types, what's frozen vs recomputable                                                                  |
| [provider-port.md](./provider-port.md)                                   | Provider interface as consumed by evaluate path — stateless config resolver, FlagConfig/ExperimentConfig/TargetingRule shapes                                       |
| [assignment-store-port.md](./assignment-store-port.md)                   | Assignment Store interface (`getAll`/`put`), key/value shapes, KV/DO substrate, holdover write failure contract                                                     |
| [evaluate-path-orchestration.md](./evaluate-path-orchestration.md)       | Hot-path pseudocode orchestrating Provider + Assignment Store; EvaluateResult shape; no-superposition guarantee                                                     |
| [holdover-and-replay-policy.md](./holdover-and-replay-policy.md)         | Holdover predicate, replay semantic, experience-vs-analysis split, no-re-counting invariant                                                                         |
| [exposure-firing-and-accessor.md](./exposure-firing-and-accessor.md)     | `evaluate()` vs `peekVariant()`/`verify()` accessor contract; Exposure event shape; first-touch identity + wire dedup_key; holdover short-circuit                   |
| [../sdk/test-evaluation-endpoint.md](../sdk/test-evaluation-endpoint.md) | Control-plane dry-run endpoint — request/response shapes, ReasonDetail discriminated union, structural exposure-free guarantee (single spec; lives in the SDK area) |

## Key invariants across files

1. **Assignment is pure.** No I/O, no side effects. Determinism requires a frozen RunConfig.
2. **Exposure is the only event.** No "assignment event" exists. Holdovers are proven by Exposure records, not assignment records.
3. **Provider and Assignment Store are siblings.** Neither is behind the other. Evaluate path orchestrates both.
4. **Zero superposition.** `evaluate()` returns `isHoldover` vs fresh-assign vs no-live-run vs disabled as structurally different shapes. `evaluate()` always fires Exposure; `peekVariant()`/`verify()` never do.
5. **Test-evaluation writes nothing.** Structural, not a parameter. The endpoint has no wiring to
   Exposure log or Assignment Store `put()`. Read-only holdover diagnostics are allowed.

## Key Evaluation Constraints

- Draft → Start model; N assignment edits become one sample reset.
- Activation Metric is an assignment-affecting edit.
- First Start opens the first Run; `draft` state has no live Run.
- Live Run is explicit persisted config in KV carrying `liveRunId`.
- Holdover write failure: DO is truth, KV miss self-heals, log is at-least-once.
- Variant is a string name; Provider is a pure config resolver; Segments are Conditions.
- Fractional Evaluation always hashes the Targeting Key.
- Test-evaluation reason is a discriminated union and always evaluates the live Run.
