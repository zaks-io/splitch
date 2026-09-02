import { randomUUID } from "node:crypto";
import { captureCleanupFailure, throwPrimaryWithCleanup } from "./cleanup-failures.mjs";
import { PROPAGATION_WINDOW_MS } from "./constants.mjs";
import { deleteExperiment, deleteFlag, endRun, updateFlagConfig } from "./control-plane.mjs";
import {
  assertBalancedExperimentResults,
  SIMULATION_VARIANTS,
  selectBalancedCohort,
} from "./experiment-simulation-assertions.mjs";

const OUTCOME_FIELD = "outcome_count";
const RESULT_STABILITY_WINDOW_MS = 2_000;

export async function runBalancedExperimentSimulation(deps) {
  const keys = simulationKeys(deps.runId);
  const resources = {
    appId: deps.appId,
    environmentId: deps.environmentId,
    experimentId: null,
    flagId: null,
    metricId: null,
    runId: null,
  };
  let failure;
  let evidence;

  try {
    await provisionSimulation(deps, keys, resources);
    evidence = await exerciseSimulation(deps, keys, resources);
  } catch (error) {
    failure = error;
  }
  const cleanupFailures = await cleanupSimulation(deps, resources);
  throwPrimaryWithCleanup(failure, cleanupFailures, "Experiment simulation and cleanup failed");
  return evidence;
}

async function provisionSimulation(deps, keys, resources) {
  const flag = await deps.callTool("flags_create", {
    appId: deps.appId,
    key: keys.flagKey,
    name: `Experiment smoke ${deps.runId}`,
    schema: { type: "string" },
    variants: SIMULATION_VARIANTS.map((name) => ({
      name,
      value: name,
      isDefault: name === "control",
    })),
    description: "Disposable balanced Experiment pipeline smoke.",
    idempotency_key: `experiment-smoke-flag-${deps.runId}`,
  });
  resources.flagId = flag.id;
  await updateFlagConfig(deps, deps.appId, deps.environmentId, flag.id, {
    enabled: true,
    availableVariantNames: SIMULATION_VARIANTS,
  });

  const eventDefinition = await createOutcomeDefinition(deps, keys);
  const metric = await createOutcomeMetric(deps, keys, eventDefinition.id);
  resources.metricId = metric.id;
  const experiment = await deps.callTool("experiments_create", {
    appId: deps.appId,
    environmentId: deps.environmentId,
    name: `Balanced Experiment smoke ${deps.runId}`,
    key: keys.experimentKey,
    flagId: flag.id,
    targetingKey: "targetingKey",
    targetingKeyType: "user",
    metrics: [{ metricId: metric.id }],
    allocation: { control: 34, "candidate-a": 33, "candidate-b": 33 },
    salt: `balanced-experiment-smoke-${deps.runId}`,
    idempotency_key: `experiment-smoke-create-${deps.runId}`,
  });
  resources.experimentId = experiment.id;
  const started = await deps.callTool("experiments_start", {
    appId: deps.appId,
    environmentId: deps.environmentId,
    experimentId: experiment.id,
    idempotency_key: `experiment-smoke-start-${deps.runId}`,
  });
  resources.runId = started.run.id;
}

async function createOutcomeDefinition(deps, keys) {
  const definition = await deps.callTool("event_definitions_create", {
    appId: deps.appId,
    name: keys.eventName,
    family: "metric",
    displayName: `Experiment smoke outcome ${deps.runId}`,
    description: "Synthetic outcome used only by the disposable shared-preview smoke.",
    idempotency_key: `experiment-smoke-event-${deps.runId}`,
  });
  await deps.callTool("event_definition_versions_create", {
    appId: deps.appId,
    eventDefinitionId: definition.id,
    entityType: "user",
    fields: [
      {
        name: OUTCOME_FIELD,
        type: "number",
        required: true,
        numberKind: "count",
        minimum: 0,
        maximum: 1,
      },
    ],
    dimensions: [],
    idempotency_key: `experiment-smoke-event-version-${deps.runId}`,
  });
  return definition;
}

function createOutcomeMetric(deps, keys, eventDefinitionId) {
  return deps.callTool("metrics_create", {
    appId: deps.appId,
    name: `Experiment smoke outcome ${deps.runId}`,
    key: keys.metricKey,
    kind: "count",
    eventDefinitionId,
    eventFieldName: OUTCOME_FIELD,
    description: "Synthetic count Metric for the disposable shared-preview smoke.",
    idempotency_key: `experiment-smoke-metric-${deps.runId}`,
  });
}

async function exerciseSimulation(deps, keys, resources) {
  const cohort = await selectBalancedCohort(
    (targetingKey) => resolveAssignment(deps, keys, resources, targetingKey),
    { runId: deps.runId },
  );
  await waitForSimulationPropagation(
    deps,
    keys,
    cohort.find((entity) => entity.variantName !== "control"),
  );
  for (const entity of cohort) await evaluateAndTrack(deps, keys, entity);

  const replay = await trackOutcome(deps, keys, cohort[0]);
  if (!replay.duplicate) throw new Error("Metric Event retry was not reported as a duplicate");
  const results = await pollBalancedResults(deps, resources, resources.metricId);
  return {
    experimentKey: keys.experimentKey,
    eventName: keys.eventName,
    metricKey: keys.metricKey,
    exposureCounts: results.stats.health.exposure_counts,
    activationRates: results.stats.health.activation_rates,
    metricResults: results.stats.arm_results.filter((row) => row.metric_id === resources.metricId),
    metricEventRetryDuplicate: replay.duplicate,
  };
}

async function waitForSimulationPropagation(deps, keys, probe) {
  if (!probe) throw new Error("balanced cohort omitted every non-Control Variant");
  const deadline = Date.now() + (deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS);
  let last;
  while (Date.now() <= deadline) {
    last = await deps.resolve("verify", {
      clientKey: deps.clientKey,
      endpoint: deps.evaluationBaseUrl,
      flagKey: keys.flagKey,
      targetingKey: probe.targetingKey,
    });
    if (last.reason !== "ERROR" && last.variantName === probe.variantName) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`simulation Flag did not propagate: ${JSON.stringify(last)}`);
}

async function resolveAssignment(deps, keys, resources, targetingKey) {
  const assignment = await deps.callTool("flags_test_eval", {
    appId: deps.appId,
    environmentId: deps.environmentId,
    flagKey: keys.flagKey,
    evaluationContext: { targetingKey, idType: "user", attributes: {} },
  });
  if (assignment.liveRunId !== resources.runId) {
    throw new Error(`assignment expected live Run ${resources.runId}, got ${assignment.liveRunId}`);
  }
  return assignment;
}

async function evaluateAndTrack(deps, keys, entity) {
  const evaluation = await deps.resolve("evaluate", {
    clientKey: deps.clientKey,
    endpoint: deps.evaluationBaseUrl,
    flagKey: keys.flagKey,
    targetingKey: entity.targetingKey,
    idempotencyKey: `experiment-smoke-evaluate-${deps.runId}-${entity.targetingKey}`,
  });
  if (evaluation.reason === "ERROR" || evaluation.variantName !== entity.variantName) {
    throw new Error(
      `evaluation did not preserve selected assignment: ${JSON.stringify(evaluation)}`,
    );
  }
  entity.eventId = randomUUID();
  const tracked = await waitForTrack(deps, trackOptions(keys, entity));
  if (tracked.duplicate) {
    throw new Error(`first track was unexpectedly a duplicate for ${entity.eventId}`);
  }
}

function trackOutcome(deps, keys, entity) {
  return deps.track({
    clientKey: deps.clientKey,
    endpoint: deps.evaluationBaseUrl,
    ...trackOptions(keys, entity),
  });
}

function trackOptions(keys, entity) {
  return {
    eventName: keys.eventName,
    targetingKey: entity.targetingKey,
    eventId: entity.eventId,
    fields: { [OUTCOME_FIELD]: 1 },
  };
}

async function cleanupSimulation(deps, resources) {
  const failures = [];
  if (resources.runId) {
    await captureCleanupFailure(failures, `end simulation Run ${resources.runId}`, () =>
      endRun(deps, resources),
    );
  }
  if (resources.experimentId) {
    await captureCleanupFailure(
      failures,
      `delete simulation Experiment ${resources.experimentId}`,
      () => deleteExperiment(deps, resources),
    );
  }
  if (resources.flagId) {
    await captureCleanupFailure(failures, `delete simulation Flag ${resources.flagId}`, () =>
      deleteFlag(deps, deps.appId, resources.flagId),
    );
  }
  if (resources.metricId) {
    await captureCleanupFailure(failures, `delete simulation Metric ${resources.metricId}`, () =>
      deps.callTool("metrics_delete", { appId: deps.appId, metricId: resources.metricId }),
    );
  }
  return failures;
}

async function waitForTrack(deps, options) {
  const deadline = Date.now() + (deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS);
  let lastError;
  while (Date.now() <= deadline) {
    try {
      return await deps.track({
        clientKey: deps.clientKey,
        endpoint: deps.evaluationBaseUrl,
        ...options,
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("Metric Event definition did not propagate");
}

async function pollBalancedResults(deps, resources, metricId) {
  const deadline = Date.now() + (deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS);
  let lastError;
  let stableSince;
  while (Date.now() <= deadline) {
    try {
      const results = await deps.callTool("experiment_results_get", {
        appId: resources.appId,
        environmentId: resources.environmentId,
        experimentId: resources.experimentId,
        runId: resources.runId,
      });
      assertBalancedExperimentResults(results, metricId);
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= RESULT_STABILITY_WINDOW_MS) return results;
    } catch (error) {
      lastError = error;
      stableSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("balanced Experiment results did not converge");
}

function simulationKeys(runId) {
  const slug = runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
  return {
    flagKey: `experiment-smoke-${slug}`,
    eventName: `experiment_smoke_outcome_${slug}`,
    metricKey: `experiment-smoke-outcome-${slug}`,
    experimentKey: `balanced-experiment-smoke-${slug}`,
  };
}
