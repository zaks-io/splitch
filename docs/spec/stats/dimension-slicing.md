# Dimension slicing and FDR composition

How Dimensions multiply the analysis family, when they enter the BH FDR family, and how
Dimension analysis composes with Activation gates. The base BH FDR family and algorithm are in
[multiple-comparisons-fdr.md](multiple-comparisons-fdr.md); this file covers Dimension expansion.

## Dimension definition (CONTEXT.md)

An attribute used to slice Experiment results (e.g., `country`, `plan`, `device_type`, `cohort`).
Per-Dimension results are separate CI computations scoped to `Dimension = dimension_value`.

## Two classes of Dimension

| Class     | Declared when             | In BH family | Use case                              |
| --------- | ------------------------- | ------------ | ------------------------------------- |
| Primary   | At Experiment design time | Yes          | Geographic region, large cohort       |
| Secondary | At Experiment design time | No           | Exploratory; discovery, not guardians |

The class is set once, at Experiment creation or during the draft phase, and is frozen per Run.
Post-start Dimensions are allowed only as Secondary / exploratory outputs for the current Run.
They do not change the BH family size `m` and cannot produce decision-valid significance.

## Family expansion for Primary Dimensions

When a Primary Dimension with D declared values is added, the BH family expands:

```
m = (n_goal_metrics × n_treatment_variants)          # base family
  + (n_primary_dimensions × D × n_treatment_variants) # per declared dim + values
```

`m` is computed at design time and locked when the Run starts. `D` is the number
of declared dimension values (or the top-N by traffic if data-driven and declared upfront).

**No retroactive FDR recomputation.** Dimension values discovered at analysis time that were
not declared at design time are secondary and excluded from `m`.

## Per-Dimension CI computation

Each `(dimension_value, variant)` pair is an independent analysis:

1. Filter deduped Exposure rows to `entity.dimension_attribute = dimension_value`.
2. Run the full CI pipeline (winsorize -> type-variance -> delta-method -> CUPED -> aCS -> relative-lift -> Guardrail).
3. Collect the `p_value` for BH correction if the Dimension is Primary.

Per-Dimension n may be small; `health.low_n_warning = true` is set per slice.

## Composition with Activation gate

When an Activation gate is set, the Activation filter applies **before** Dimension slicing:

```
population = activated_entities             # gated population first
  |> group_by dimension_attribute           # then slice
  |> per_value: compute CI + SRM_check
```

Dimensions slice the _activated_ population, not the full-exposed population. This preserves
the analysis integrity: the gate defines the valid measurement population; Dimensions explore
within it.

The full-exposed SRM and activated-population SRM are computed on the **non-Dimension-sliced**
populations (all arms, all Dimensions together) so SRM is not distorted by low-n per slice.

## Dimension output shape

```
interface DimensionResult {
  dimension_id:    string;        // e.g., "country"
  dimension_value: string;        // e.g., "US"
  class:           'primary' | 'secondary';
  arm_results:     ArmResult[];   // same shape as top-level arm results
  sample_size_n:   integer;       // Entities in this dimension slice × arm
  in_bh_family:    boolean;
  exploratory:     boolean;
  decision_valid:  boolean;
}
```

`DimensionResult.arm_results[].is_significant` reflects BH correction over the unified family
(top-level goal Metrics + Primary Dimension slices). Secondary Dimension `is_significant` is
reported as a raw `p_value < alpha` — no BH — with `exploratory: true` and
`decision_valid: false`.

## Interaction with fixed-horizon mode

When `horizon = 'fixed'`, Dimension slicing is permitted but each slice must meet its own
`n >= sample_size_locked` per arm requirement. If a Dimension slice does not hit the required N,
it is suppressed in the output with `status = 'insufficient_n'`.

## Seam note: no superposition

A Dimension analysis can always determine:

- Whether a Dimension is Primary or Secondary (declared at design time, not inferred).
- Whether Activation filter was applied before slicing (from the input row's `activated` field).
- Whether `is_significant` was BH-corrected or raw (from `in_bh_family` flag).

No caller needs to guess. The output shape carries all three facts explicitly.

## Sources

- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md) §Threads handed forward (Dimension slicing)
- CONTEXT.md §Dimension
- [Benjamini and Hochberg (1995), controlling the false discovery rate](https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1995.tb02031.x)
- [Bakshy, Eckles, and Bernstein, Designing and Deploying Online Field Experiments](https://arxiv.org/abs/1409.3174)
