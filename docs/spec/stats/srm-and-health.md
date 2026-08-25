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
conservative.

**On mismatch:** results are flagged untrusted. The mismatch is surfaced loudly in the UI.

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
