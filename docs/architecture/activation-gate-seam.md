# The Activation gate seam

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
Every decision here is on the final data model; the explicit guarantee is **no rewrite** to reach the
complete counterfactual gate. Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture
terms per the deepening discipline. Builds directly on the
[Exposure pipeline seam](./exposure-pipeline-seam.md) (ADR-0010/0011).

## Where this came from

The Exposure pipeline grill named the Activation gate as a forward thread: it _re-anchors_ first-touch.
This grill specifies it. The gate is the subtlest bias surface in the platform — conditioning analysis on a
post-exposure action is exactly how randomization gets silently broken — so it was designed against the
Kohavi/Microsoft experimentation literature, not just vendor docs (see [references.md](./references.md)).

## What's settled (the literature is unanimous)

- **Ordering — activation must follow Exposure** (ADR-0012): `activation_ts > first_exposure_ts` per
  `(Entity, Run)`. A pre-exposure activation is post-treatment selection bias and never counts.
- **Pipeline locus — a query-time filter composing with first-touch dedup** (ADR-0010): dedup to first
  Exposure, then JOIN activation events. No separate pipeline; it drops into the ELT model.

## The locked semantics

### Re-anchor the Conversion Window to activation (ADR-0012)

When a gate is set, the Conversion Window starts at `activation_ts`, not `first_exposure_ts` — activation
is the true entry moment (Eppo's automatic behavior; Statsig's toggle). The anchor is a clean branch,
`COALESCE(activation_ts, first_exposure_ts)`, never a superposition. The field is genuinely split here
(GrowthBook keeps first-exposure); we chose the causal-cleaner re-anchor deliberately.

### The bias trap and the two guardrails (ADR-0012)

🚩 If the Treatment changes whether an Entity activates, conditioning on activation biases every downstream
Metric — and the **full-population SRM does not catch it** (GrowthBook's explicit warning). The assignment
split can read a clean 50/50 while the activated subpopulation is skewed. splitch goes past every vendor:

- **Activated-population SRM** — chi-square on activated Entities per arm per Run (p < 0.001), _separate_
  from the full-exposed SRM. A gated-scorecard SRM with a clean full-exposed SRM is the canonical
  fingerprint of a Treatment-affected gate.
- **Per-arm activation rate as a first-class Metric** — chi-square over activated / not-activated by
  arm (p < 0.001) is a loud alert and the rate gap explains _why_ the gated SRM fired.

Either firing → gated results untrusted. Same fail-loud ethos as the `__multiple__` quarantine (ADR-0011).

## The gate composes onto the dedup query

```sql
-- exposures already deduped to first-touch per (entity, run), __multiple__ quarantined (ADR-0010/0011)
-- app_id + environment_id co-scope every CTE and join key — Experiments are per-Environment (ADR-0027)
WITH exposed AS ( /* ... app_id, environment_id, first_exposure_ts, variant ... */ ),
activated AS (
  SELECT app_id, environment_id, entity, run, MIN(activation_ts) AS activation_ts  -- first-class event row
  FROM raw_events WHERE type = 'activation'
  GROUP BY app_id, environment_id, entity, run
)
SELECT
  e.app_id, e.environment_id, e.entity, e.run, e.variant,
  a.activation_ts                                       AS anchor_ts,   -- re-anchor (ADR-0012)
  COALESCE(a.activation_ts, e.first_exposure_ts)        AS window_anchor
FROM exposed e
JOIN activated a
  ON a.app_id = e.app_id AND a.environment_id = e.environment_id
 AND a.entity = e.entity AND a.run = e.run
 AND a.activation_ts > e.first_exposure_ts                             -- activation follows exposure
-- un-activated exposed entities are dropped from the gated population;
-- activation rate per arm and activated-population SRM are computed from (exposed JOIN/ANTI-JOIN activated)
```

## Production-ready and progressive (ADR-0013): no rewrite to reach the full gate

The rewrite risk is the **data model**, not the counterfactual logging. The first-class Activation event
removes that risk:

- **Activation is a first-class logged event** — its own row on the same append-only log (ADR-0010), not a
  query-derived flag. This is the load-bearing choice.
- **Counterfactual triggering** (Kohavi's full unbiased gate: include Control Entities that _would have_
  activated) is then **additive** — the Control arm emits an activation-shaped event with
  `counterfactual: true`. A new column _value_, flowing through the **same** log, JOIN, anchor, and SRM.
  Zero schema change, zero query rewrite.
- **Deferred, and only because it's un-buildable now:** the SDK-side Control-arm would-have-activated
  _evaluation logic_ needs a running SDK/pipeline/experiment to build and test. Building it blind today adds
  untestable code, not production-readiness. The activated-population SRM is precisely the signal that tells
  you which real experiment justifies building it.

## Why this is a deep seam

A small interface — "gate analysis to activated Entities" — sits in front of: the exposure-ordering rule,
window re-anchoring, two SRM populations, the activation-rate balance Metric, and a forward-compatible
event schema. All the correctness lives in one composed query plus one first-class event type. Delete the
seam and post-treatment-bias logic smears across every gated analysis — the locality the deletion test
rewards.

## Threads handed forward

- **SDK counterfactual evaluation** (ADR-0013) — built when a real gated-scorecard SRM demands it.
- The **Metric analysis seam** (Binomial/Count/Revenue/Ratio aggregation, CUPED, sequential testing) reads
  the `window_anchor` this seam produces — the bigger statistics surface, its own grill.
