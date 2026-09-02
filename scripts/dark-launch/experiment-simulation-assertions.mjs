import { assertExposureHealth } from "./hosted-results.mjs";

export const SIMULATION_VARIANTS = ["control", "candidate-a", "candidate-b"];
const SIMULATION_ENTITIES_PER_VARIANT = 4;

export function assertSharedPreviewOrigins(origins) {
  for (const [name, origin] of Object.entries(origins)) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".preview.splitch.dev")) {
      throw new Error(`${name} must target shared preview, got ${url.origin}`);
    }
  }
}

export async function selectBalancedCohort(resolveAssignment, options = {}) {
  const variants = options.variants ?? SIMULATION_VARIANTS;
  const perVariant = options.perVariant ?? SIMULATION_ENTITIES_PER_VARIANT;
  const maxCandidates = options.maxCandidates ?? 120;
  const selected = new Map(variants.map((variant) => [variant, []]));

  for (let index = 0; index < maxCandidates; index += 1) {
    const targetingKey = `experiment-smoke-entity-${options.runId ?? "test"}-${index}`;
    const assignment = await resolveAssignment(targetingKey);
    addAssignment(selected, assignment.variantName, targetingKey, perVariant);
    if (cohortComplete(selected, perVariant)) return flattenCohort(selected);
  }

  throw new Error(
    `could not select ${perVariant} Entities for every Variant in ${maxCandidates} candidates`,
  );
}

export function assertBalancedExperimentResults(results, metricId) {
  if (results?.state !== "ready") {
    throw new Error(`expected ready Experiment results, got ${JSON.stringify(results)}`);
  }
  const expectedCounts = Object.fromEntries(
    SIMULATION_VARIANTS.map((variant) => [variant, SIMULATION_ENTITIES_PER_VARIANT]),
  );
  assertExposureHealth(results, SIMULATION_VARIANTS.length * SIMULATION_ENTITIES_PER_VARIANT);
  assertExactRecord(results.stats.health.exposure_counts, expectedCounts, "raw Exposure counts");
  assertExactRecord(results.stats.health.deduped_counts, expectedCounts, "deduped Exposure counts");
  assertExactRecord(results.stats.srm.observed_counts, expectedCounts, "SRM observed counts");
  if (results.stats.health.activation_rates !== null) {
    throw new Error(
      `ungated Experiment unexpectedly returned activation rates: ${JSON.stringify(results.stats.health.activation_rates)}`,
    );
  }

  const metricResults = results.stats.arm_results.filter((row) => row.metric_id === metricId);
  const expectedTreatments = SIMULATION_VARIANTS.filter((variant) => variant !== "control");
  if (metricResults.length !== expectedTreatments.length) {
    throw new Error(
      `expected ${expectedTreatments.length} Metric results, got ${metricResults.length}`,
    );
  }
  for (const variant of expectedTreatments) {
    const row = metricResults.find((result) => result.variant === variant);
    if (!row || row.sample_size_n !== SIMULATION_ENTITIES_PER_VARIANT || row.point_estimate !== 1) {
      throw new Error(`unexpected Metric result for ${variant}: ${JSON.stringify(row)}`);
    }
  }
}

function addAssignment(selected, variantName, targetingKey, perVariant) {
  const cohort = selected.get(variantName);
  if (!cohort) {
    throw new Error(`assignment returned unknown Variant ${JSON.stringify(variantName)}`);
  }
  if (cohort.length < perVariant) cohort.push(targetingKey);
}

function cohortComplete(selected, perVariant) {
  return [...selected.values()].every((entities) => entities.length === perVariant);
}

function flattenCohort(selected) {
  return [...selected].flatMap(([variantName, targetingKeys]) =>
    targetingKeys.map((targetingKey) => ({ targetingKey, variantName })),
  );
}

function assertExactRecord(actual, expected, label) {
  const normalize = (record) =>
    Object.fromEntries(
      Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    );
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
