# assign() — pure deterministic bucketing function

`assign(Run, targetingKey) -> variantName` is the single bucketing primitive. It is pure:
no I/O, no side effects, no state mutation. Every runtime (Workers, Durable Objects,
lambdas, offline backfill) must produce identical output for identical inputs.

## Signature

```
assign(run: RunConfig, targetingKey: string) -> string   // returns Variant name
```

`RunConfig` is the frozen snapshot the Provider delivers. Its fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `runId` | string | yes | Unique, immutable Run identity |
| `salt` | string | yes | Per-experiment bucketing seed; changes mean a different split |
| `allocation` | `{ variantName: string; weight: number }[]` | yes | Weights sum to 1.0; deterministic split |
| `variantSet` | `string[]` | yes | Ordered list of Variant names; frozen for the Run |
| `targetingRules` | `TargetingRule[]` | yes | Priority-ordered; first match wins |
| `targetingKey` | string | yes | The attribute name in EvaluationContext that identifies the Entity |

## Determinism contract

- **Same inputs, same output.** For a given `(salt, allocation, targetingKey value)` the
  output Variant name never varies — across POPs, runtimes, time, or language.
- **Scope is one Run.** Determinism is relative to a frozen `RunConfig`. If the Run ends and
  its config is gone, `assign()` cannot be recomputed — the direction is Run → assignment,
  never assignment → Run.
- **Fractional Evaluation always hashes the Targeting Key.** The hash input is always
  `salt + ":" + targetingKey` (implementation detail; the principle is: one hash target, the
  Targeting Key). Mismatched bucketing (e.g. hashing on something other than the configured
  Targeting Key) is a config error caught at design time, not runtime polymorphism.

## Return type

`assign()` returns the **Variant name** (a string like `"control"` or `"treatment-a"`).
Variant metadata (description, value/config) lives on the Flag definition, not the computed
name.

## No-event discipline

Assignment is **never logged, recorded, or persisted as a primary fact.** The only event
that rides on this seam is Exposure (see [exposure-firing-and-accessor.md](./exposure-firing-and-accessor.md)).
An Entity that is bucketable but never exposed has zero footprint — no "assigned but unexposed"
record exists.

## Error contract

`assign()` assumes valid inputs and never returns an error. Config writes (salt format,
allocation weights, Variant set) are validated by the Worker at write time (ADR-0025, Zod-first);
invalid configs are rejected at the write boundary. The read path never sees malformed input.

## Sources

- [../../adr/0001-assignment-is-pure-not-an-event.md](../../adr/0001-assignment-is-pure-not-an-event.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (spine, decision 1)
