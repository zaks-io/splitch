# SRM and health metrics

Sample Ratio Mismatch diagnostics and health metrics for data quality. All SRM computation reads
the same deduped-Entity denominator used by variance math — one definition, never two.

## Sample Ratio Mismatch (SRM)

### Definition (CONTEXT.md)

A diagnostic failure where observed traffic split across Variants deviates significantly from the
expected split. Signals broken bucketing/Assignment and **invalidates the Experiment's results**.

### Full-exposed SRM

Chi-square test over the full exposed population.

**Denominator:** `COUNT DISTINCT targeting_key_hash` per arm, from the first-touch dedup query (ADR-0010).

- First-touch per `(targeting_key_hash, run_id)`: `MIN(exposure_at)`.
- `__multiple__` Entities excluded from all arms (ADR-0011).
- This is the **same denominator** Metrics and Conversion Window anchoring use. No secondary
  raw-count denominator exists.

**Expected counts:** from the Run's declared `allocation` percentages (e.g., `[50, 50]` for a
two-arm test). Expected count per arm = `(allocation_pct / 100) * total_deduped_n`.

**Test:**

```
chi2_stat = SUM_arms [ (observed_i - expected_i)^2 / expected_i ]
degrees_of_freedom = n_arms - 1
p_value = chi2_cdf(chi2_stat, df=degrees_of_freedom, upper_tail=true)
srm_is_mismatch = p_value < 0.001
```

**Threshold:** `p < 0.001`, matching common experiment-platform SRM diagnostics. SRM is monitored
repeatedly and is not a sequentially-valid decision rule, so the threshold is intentionally
conservative. The observation process (which Entities enter the counts, and when a later watermark
revises rather than appends) is defined in
[data-contracts.md](data-contracts.md#observation-process-at-a-watermark-data-entry-audit).
Quarantine to `__multiple__` and late Activations can decrease an arm's earlier count.

**On mismatch:** results are flagged untrusted. The mismatch is surfaced loudly in the UI.

### Sequential Dirichlet-multinomial SRM (analysis-v2 gate)

`@splitch/stats` exports `computeSequentialSrm`, the Dirichlet-multinomial mixture martingale of
Lindon and Malek (NeurIPS 2022). Under `analysis-v2`, Exposure SRM and activated-population SRM
read this martingale: `srm_p_value` is the anytime p-value and `srm_is_mismatch` is
`threshold_crossed` at alpha 0.001. legacy-unversioned and analysis-v1 keep the chi-square
`p < 0.001` gate. Chi-square stays the fixed-horizon diagnostic and the activation-balance test
under every version (activation balance is equality of unknown rates, not the declared
allocation multinomial). `analysis-v2` is defined in the exhaustive version switch but is
**unsupported** for Start and Results: it is not in `SUPPORTED_ANALYSIS_VERSIONS`, new Runs
freeze `analysis-v1`, and a Run frozen under v2 refuses loudly. The open blocker is an
ingestion-ordered observation path (late ingestion with earlier event timestamps can erase an
alarm when the path is ordered by event time).

**Prior.** Dirichlet mean equals the declared allocation: `alpha_i = concentration * theta_i`.
Default `concentration` is 100. Type I control from Ville's inequality does not depend on this
value. The concentration only changes expected detection delay.

**Input.** Cumulative per-arm counts in arrival order, or batches of nonnegative integer increments
on the declared Variants. Allocation weights must be positive. Default threshold `alpha` is 0.001.

**Output.** `wealth` is the Bayes factor / e-value `O_n`. `anytime_p_value` is the running minimum
of `min(1, 1 / wealth)`, which is super-uniform under the null. `threshold_crossed` is true once
`anytime_p_value <= alpha` and stays true if later wealth falls (alarm persistence along the path).
`first_cross_n` is the total Entity count at the first crossing, or null.

**Observation contract (Results gate).** On every Results read, the analysis-v2 SRM gate rebuilds
an append-only arrival path from the current watermarked population and evaluates the martingale
after every Entity arrival (incremental log-gamma updates, O(N)). Exposure SRM orders Entities by
`first_exposure_ts`. Activated-population SRM orders activated Entities by their earliest valid
`activation_ts` (the time they entered the activated population), not by first Exposure. Ties at
identical timestamps break deterministically by Entity pseudonym (`targeting_key_hash`) so pinned
reads stay reproducible. The reported p-value is the running minimum along that path, so an early
mismatch stays sticky when later arrivals balance the totals. This holds as long as ingestion
before the pinned watermark is complete (the watermark contract). The Entity set is exactly the
pinned-watermark `StatsInput` exposures (and activation rows for activated SRM).

**Open issue (why v2 is unsupported).** Ordering by event time is not the same as ordering by
ingestion. A late-arriving row whose `activation_ts` / `first_exposure_ts` is earlier than rows
already on the path can rewrite history and erase a previously sticky alarm. Until the Results
gate has an ingestion-ordered (append-only across watermarks) observation path, `analysis-v2`
stays out of `SUPPORTED_ANALYSIS_VERSIONS`, `CURRENT_ANALYSIS_VERSION` stays `analysis-v1`, and
Start rejects a request for v2.

**Quarantine and revisions.** A later watermark that moves an Entity into `__multiple__` (or
revises `first_exposure_ts` / `activation_ts`) edits the dataset. The next read recomputes the
whole path from the cleaned rows; it does not feed a decreasing arm total into a live filtration.
Primitive `computeSequentialSrm` still fails loud if a single call's cumulative snapshots decrease
an arm count.

**Looks.** Wealth is a function of the sufficient statistic. The anytime p-value is the running
minimum after every singleton arrival in the reconstructed path. Continuous monitoring is the
gate default; batching arrivals into larger increments is allowed for the primitive but is not
how the Results gate rebuilds the path.

### Activated-population SRM

Computed separately when an Activation gate is set. Guards against Treatment-affected gates
(ADR-0012 / CONTEXT.md §Activation Metric).

**Denominator:** `COUNT DISTINCT targeting_key_hash` per arm among activated Entities only:

```sql
-- uses activation_rows from data-contracts.md
SELECT variant, COUNT(DISTINCT targeting_key_hash) AS activated_n
FROM exposed e
JOIN activation_rows a USING (targeting_key_hash, run_id)
WHERE a.activated = true
GROUP BY variant
```

**Threshold:** `p < 0.001`, same as full-exposed SRM.

**Two-guardrail interpretation:**

| Full-exposed SRM | Activated-population SRM | Interpretation                                                          |
| ---------------- | ------------------------ | ----------------------------------------------------------------------- |
| Clean            | Clean                    | Gated results are trustworthy                                           |
| Mismatch         | Mismatch                 | Broken bucketing; all results untrusted                                 |
| Clean            | Mismatch                 | Treatment-affected gate; gated results biased                           |
| Mismatch         | Clean                    | Bucketing broken; gated results may be incidentally OK; still untrusted |

**Either SRM firing → gated results untrusted.**

### Per-arm activation rate

A first-class balance Metric alongside gated results. Computed as:

```
activation_rate[arm] = activated_n[arm] / exposed_n[arm]
```

The balance test is a chi-square test over the 2 × Variant table
`activated` / `not_activated` by arm, with threshold `p < 0.001`. The output also reports the
largest absolute activation-rate gap across arms. The p-value is the alert; the rate gap is the
effect-size diagnosis.

## `__multiple__` quarantine

An Entity showing more than one distinct Variant in a Run is placed in the `__multiple__` bucket.

- Excluded from all arms.
- Excluded from both SRM denominators.
- Surfaced as `health.multiple_rate`.

**Tolerance:** ~1% is acceptable transient noise. Above 1% signals a defect: config race, SDK
bug, or a material-edit violation (ADR-0003 broken, a new Run should have been opened).

The quarantine is fail-loud by design. "First-touch wins" would silently bias the earlier-assigned
arm and SRM would not catch it (ADR-0011).

A later ingest of a second Variant for the same Entity **revises** that Entity out of its previous
arm. See [data-contracts.md](data-contracts.md#observation-process-at-a-watermark-data-entry-audit).

## Health metrics object

| Field                         | Type                              | Meaning                                                   |
| ----------------------------- | --------------------------------- | --------------------------------------------------------- |
| `multiple_rate`               | `number`                          | `__multiple__` Entities / total Exposed Entities in Run   |
| `multiple_count`              | `integer`                         | Raw count of `__multiple__` Entities                      |
| `activation_rates`            | `Record<variant, number> \| null` | Per-arm activation rate; null if no gate                  |
| `activation_balance_p_value`  | `number \| null`                  | Chi-square p-value for activated / not-activated by arm   |
| `activation_balance_mismatch` | `boolean \| null`                 | `true` if `activation_balance_p_value < 0.001`            |
| `exposure_counts`             | `Record<variant, integer>`        | Raw (pre-dedup) Exposure event counts per arm             |
| `deduped_counts`              | `Record<variant, integer>`        | First-touch deduped Entity counts per arm (the SRM input) |
| `low_n_warning`               | `boolean`                         | `true` if any arm has deduped n < 100                     |

## SRM output fields in the result object

See [result-contracts.md](result-contracts.md) §SRM result object for the full `SrmResult` shape.

Summary:

| Field                    | Condition on threshold                       |
| ------------------------ | -------------------------------------------- |
| `srm_is_mismatch`        | `p_value < 0.001` (full-exposed)             |
| `activated_srm_mismatch` | `p_value < 0.001` (activated; when gate set) |

## Seam boundary

**Port**: `SRMChecker` is a pure function:

```
interface SRMChecker {
  checkFull(
    observed: Record<variant, integer>,   // deduped counts per arm
    allocation: Record<variant, number>   // declared percentages, sum = 100
  ): { p_value: number; is_mismatch: boolean; chi2_stat: number };

  checkActivated(
    activated_observed: Record<variant, integer>,
    allocation: Record<variant, number>
  ): { p_value: number; is_mismatch: boolean } | null;   // null if no gate
}
```

Single implementation (chi-square); no adapter substitution needed. Not a deletion-test seam —
SRM has no alternative algorithm — but isolating it keeps the query-composition concerns out of
the stats engine core.

## Sources

- [../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- CONTEXT.md §SRM, §Activation Metric, §Exposure Pipeline
- [Fabijan et al., Diagnosing Sample Ratio Mismatch in Online Controlled Experiments](https://dl.acm.org/doi/10.1145/3292500.3330722)
- [Deng and Hu, Diluted Treatment Effect Estimation for Trigger Analysis](https://exp-platform.com/Documents/wsdm2015-dilution.pdf)
- [Lindon and Malek, Anytime-Valid Inference For Multinomial Count Data](https://proceedings.neurips.cc/paper/2022/hash/12f3bd5d2b7d93eadc1bf508a0872dc2-Abstract.html)
