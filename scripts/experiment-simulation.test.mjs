import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBalancedExperimentResults,
  assertSharedPreviewOrigins,
  SIMULATION_VARIANTS,
  selectBalancedCohort,
} from "./dark-launch/experiment-simulation-assertions.mjs";

test("selects exactly four preflighted Entities for each Variant", async () => {
  const cohort = await selectBalancedCohort(
    async (targetingKey) => {
      const index = Number(targetingKey.split("-").at(-1));
      return { variantName: SIMULATION_VARIANTS[index % SIMULATION_VARIANTS.length] };
    },
    { runId: "unit" },
  );

  assert.equal(cohort.length, 12);
  assert.deepEqual(
    Object.fromEntries(
      SIMULATION_VARIANTS.map((variant) => [
        variant,
        cohort.filter((entity) => entity.variantName === variant).length,
      ]),
    ),
    { control: 4, "candidate-a": 4, "candidate-b": 4 },
  );
});

test("balanced cohort selection fails loud when a Variant cannot be found", async () => {
  await assert.rejects(
    selectBalancedCohort(async () => ({ variantName: "control" }), {
      runId: "unit",
      maxCandidates: 12,
    }),
    /could not select 4 Entities for every Variant/u,
  );
});

test("shared-preview guard rejects production and lookalike origins", () => {
  assert.doesNotThrow(() => assertSharedPreviewOrigins({ api: "https://api.preview.splitch.dev" }));
  assert.throws(
    () => assertSharedPreviewOrigins({ api: "https://api.splitch.dev" }),
    /must target shared preview/u,
  );
  assert.throws(
    () => assertSharedPreviewOrigins({ api: "https://api.preview.splitch.dev.example.com" }),
    /must target shared preview/u,
  );
});

test("balanced Results require Exposures and Metric values for all Variants", () => {
  const results = readyResults();
  assert.doesNotThrow(() => assertBalancedExperimentResults(results, "metric-smoke"));

  results.stats.arm_results[1].sample_size_n = 0;
  assert.throws(
    () => assertBalancedExperimentResults(results, "metric-smoke"),
    /unexpected Metric result/u,
  );

  const gated = readyResults();
  gated.stats.health.activation_rates = { control: 1, "candidate-a": 1, "candidate-b": 1 };
  assert.throws(
    () => assertBalancedExperimentResults(gated, "metric-smoke"),
    /ungated Experiment unexpectedly returned activation rates/u,
  );
});

function readyResults() {
  const counts = { "candidate-b": 4, control: 4, "candidate-a": 4 };
  return {
    state: "ready",
    stats: {
      health: {
        exposure_counts: counts,
        deduped_counts: counts,
        multiple_count: 0,
        activation_rates: null,
      },
      srm: { observed_counts: counts },
      arm_results: [
        {
          metric_id: "metric-smoke",
          variant: "candidate-a",
          sample_size_n: 4,
          point_estimate: 1,
        },
        {
          metric_id: "metric-smoke",
          variant: "candidate-b",
          sample_size_n: 4,
          point_estimate: 1,
        },
      ],
    },
  };
}
