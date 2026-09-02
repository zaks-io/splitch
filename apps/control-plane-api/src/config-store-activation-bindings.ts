import { type ActivationBindingKV, ActivationBindingKVSchema } from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";

/**
 * Every Run that froze an activation Metric, each with the Metric IT froze.
 * Ended Runs stay published because their holdover Entities keep converting into
 * them (ADR-0006), and a measurement edit opens a new Run (ADR-0003), so the
 * live Run's Metric is not necessarily the one a prior Run is analyzed under.
 */
export async function activationBindingsForExperiment(
  repo: Repository,
  scope: EnvScope,
  experiment: Awaited<ReturnType<Repository["experiments"]["getExperiment"]>>,
): Promise<ActivationBindingKV[]> {
  if (!experiment) return [];
  const runs = await repo.experiments.listRunsForExperiment(scope, experiment.id);
  const activating = runs.flatMap((run) =>
    run.activationMetricId ? [{ run, activationMetricId: run.activationMetricId }] : [],
  );
  if (activating.length === 0) return [];

  const metrics = await repo.experiments.listMetricsByIds(
    appScope(scope.appId),
    activating.map(({ activationMetricId }) => activationMetricId),
  );
  const eventDefinitionIds = new Map(
    metrics.map((metric) => [metric.id, metric.eventDefinitionId]),
  );
  return activating.map(({ run, activationMetricId }) => {
    if (!eventDefinitionIds.has(activationMetricId)) {
      throw new Error("config-store: activation Metric does not exist");
    }
    const eventDefinitionId = eventDefinitionIds.get(activationMetricId);
    if (!eventDefinitionId) {
      throw new Error("config-store: activation Metric has no Event Definition");
    }
    return ActivationBindingKVSchema.parse({
      eventDefinitionId,
      experimentId: run.experimentId,
      runId: run.id,
      idType: run.targetingKeyType,
    });
  });
}
