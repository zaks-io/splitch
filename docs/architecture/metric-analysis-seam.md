# The Metric analysis seam (the statistics engine)

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
**Production target — not a bootstrap stopgap.** These are the production statistical defaults on the final
data model. Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture terms per the
deepening discipline. Reads what the [Exposure pipeline](./exposure-pipeline-seam.md) and
[Activation gate](./activation-gate-seam.md) produce.

## Where this came from

Upstream seams deliver the inputs: deduped first-touch unique Entities per arm per Run, `__multiple__`
excluded (ADR-0010/0011), each with per-Entity Metric values windowed on `window_anchor` =
`COALESCE(activation_ts, first_exposure_ts)` (ADR-0012). This seam turns those into the result a user
trusts: point estimate, uncertainty, significance call. It is where peeking bias, clustered-data variance,
ratio-metric variance, heavy tails, and multiple comparisons all live — each a known, often *silent*, trap.

## The one CI object

The engine's spine is a single confidence-interval object that every Metric type flows through. Reading it
top to bottom is reading the whole engine:

```
per-Entity Metric values (aggregated to the randomization unit — ADR-0015)
        │
        ▼  type-appropriate variance: Binomial p(1-p) | Count/Revenue sample var | Ratio delta method
   delta-method variance  ──────────────────────────────────────────────  (ADR-0015, covariance term)
        │
        ▼  winsorize additive Metrics (99.9% default; never binary)        (ADR-0016)
        │
        ▼  CUPED adjustment, gated on pre-period data; attribute-covariate fallback for new Entities (ADR-0016)
        │
        ▼  asymptotic confidence sequence (always-valid, peek anytime)     (ADR-0014)
        │
        ▼  relative-lift CI (itself a delta-method ratio)                  (ADR-0015)
        │
        ▼  Guardrail = CI lower-bound breach of a downside threshold       (ADR-0015)
        │
        ▼  Benjamini-Hochberg FDR across goal-metric × variant family      (see below)
```

One object, one place each correctness rule lives. The deletion test: collapse this seam and the variance
rules, the peeking correction, and the multiple-comparison control smear across every per-Metric query.

## The locked decisions

### Inference framework (ADR-0014)

- **Sequential / always-valid by default**, not fixed-horizon. Users peek continuously; fixed-horizon under
  peeking is a 25–57% real false-positive rate (Optimizely A/A sims). Always-valid keeps error at target no
  matter how often they look. Fixed-horizon is opt-in for a pre-committed sample.
- **Frequentist** point of view (no prior-manipulation surface in self-serve; converges with Bayesian at
  scale). Bayesian view may be added later, not the default.
- **Asymptotic confidence sequences (aCS/GAVI)**, not mSPRT — they *are* CIs, so they compose with the
  delta-method and CUPED machinery as one object.

### Variance correctness — non-negotiable (ADR-0015)

- **Aggregate to the Entity first**; denominator is `COUNT DISTINCT Entity`, never events/sessions.
- **Delta method** for Ratio Metrics and any Metric finer than the Entity (clustered data and ratio metrics
  are the same problem with the same fix).
- **No naive ratio-of-means / events-as-independent variance path exists** — the silent error is structurally
  unreachable, not just discouraged.

### Variance reduction — default-on but conditional (ADR-0016)

- **CUPED** on by default, gated on pre-period data + coverage, attribute-covariate fallback for the
  new-Entity slice this platform's own upstream produces.
- **Winsorization** default-on for additive Metrics (99.9%), never binary.

### Multiple comparisons — Benjamini-Hochberg FDR

Many Metrics × many Variants inflates false positives (5 Metrics × 2 Variants ≈ 40% FWER). splitch controls
the **false discovery rate via Benjamini-Hochberg** across the goal-metric × Variant family — more powerful
than Bonferroni, widely adopted (Statsig, GrowthBook), Kohavi-endorsed. Guardrail and secondary Metrics are
excluded from the family; a "none" option is exposed. (Eppo's preferential-Bonferroni/FWER was the
considered alternative — stricter, primary-metric-weighted; we chose FDR for power and adoption.)

## Why this is a deep seam

A narrow interface — "given windowed per-Entity Metric values, return the trusted result" — sits in front of
the entire statistical apparatus: clustered-variance correctness, the delta method, always-valid peeking
safety, two gated variance-reduction techniques, and FDR control. All of it concentrated in one CI object.
Every default is the safe / fail-loud one, consistent with the rest of the architecture (exposure-on-read,
`__multiple__`, the activated-population SRM).

## Threads handed forward

- **Power / sample-size & MDE planning** (pre-experiment) — consumes the same variance model; its own grill.
- **Dimension slicing** (per-Dimension results) multiplies the comparison family — must compose with the FDR
  control here.
- A **Bayesian results view** (chance-to-win, credible intervals) as an opt-in alternative surface.
