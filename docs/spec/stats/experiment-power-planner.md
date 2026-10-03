# Experiment power and MDE planner

Pre-run sample-size and minimum detectable effect (MDE) planning for sequential
Runs that use the engine's normal-mixture asymptotic confidence sequence. Exposed
as the read-only `experiment_plan` operation. The caller passes the returned
`targetN` into `experiments_start` (PR #644 froze `target_n` at Start). A plan is
**not** mandatory at Start in this slice; that behavior change belongs with
pre-registration.

## Inputs

| Field                                    | Role                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `metricKind`                             | `continuous` (count/revenue-style) or `binomial`           |
| `baselineMean` / `baselineVariance`      | Required for continuous; never invented                    |
| `baselineRate`                           | Required for binomial in `(0, 1)`; variance is `p(1-p)`    |
| `alpha`, `power`                         | Default `0.05` / `0.8`                                     |
| `mdeAbsolute` or `mdeRelative`           | Size from MDE (exactly one)                                |
| `fixedSampleSizePerArm`                  | Solve MDE at a fixed Control-arm size (exclusive with MDE) |
| `armCount`, `trafficSplit`               | Control is index 0; default equal shares                   |
| `expectedDailyEligibleEntities`          | Duration = ceil(total planned Entities / daily)            |
| `guardrailBreachAbsolute` or `…Relative` | Optional; yields guardrail power at the planned n          |

There is no input path for observed effects. Post-hoc power is never computed.

Cold start: when the App has no Metric history, the caller must supply baselines.
This slice is **caller-only** (`baselineSource: "caller"`). Missing baselines are
refused with `VALIDATION_ERROR` naming the fields. Historical baseline lookup is
left for a later slice.

## Outputs

| Field                  | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `fixedHorizonNPerArm`  | Fixed-horizon Control-arm n for the stated MDE at `z_{alpha/2}`         |
| `alwaysValidInflation` | Schultzberg closed-form `k* = (u_alpha / z_{alpha/2})^2`                |
| `nPerArm`              | Always-valid Entities per arm (exact mixture critical scale + `z_beta`) |
| `targetN`              | `n_control + n_primary_treatment`; pass to Start as `targetN`           |
| `expectedDurationDays` | Calendar days at the stated daily eligibility                           |
| `guardrailPower`       | Two-sided power to detect the stated breach size at planned n, or null  |

`u_alpha` is the engine's normal-mixture scale at the tuned decision time
(`packages/stats/src/sequential-ci.ts`). At `n = target_n` the mixture information
ratio equals the alpha-only optimum, so `k*` does not depend on the chosen
`target_n`.

Sizing uses `u_alpha + z_beta` (exact power at the tuned time). Reported `k*` is
the Schultzberg reference; realized `n_av / n_fh` is close but not identical
because `z_beta` is shared by both formulas.

## References

- Howard, Ramdas, McAuliffe, Sekhon (2021). Time-uniform Chernoff bounds via
  nonnegative supermartingales. arxiv.org/abs/1810.08240
- Waudby-Smith, Arbour, Sinha, Kennedy, Ramdas (2024). Time-uniform central limit
  theory. arxiv.org/abs/2103.06476
- Maharaj et al. (2023). Anytime-valid confidence sequences (Adobe). WWW '23
  Companion. arxiv.org/abs/2302.10108
- Schultzberg (2026). Always-valid inference and sample-size inflation `k*`
  (Spotify experiment design practice; closed-form reference for the mixture
  critical-value ratio)
- Kohavi, Deng, Vermeer (2022). A/B testing intuition busters.

## Simulation gate

`packages/stats/src/experiment-plan.simulation.test.ts` (in `stats:simulation`)
uses a predeclared seed and Monte Carlo tolerance to check that rejection rate
under the stated MDE at the planned `target_n` matches the planned power.
