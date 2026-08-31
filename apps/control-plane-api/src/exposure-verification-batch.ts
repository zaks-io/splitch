import {
  type ConvexExposureVerificationBatchRequest,
  ConvexExposureVerificationBatchRequestSchema,
  type ConvexExposureVerificationBatchResult,
  ConvexExposureVerificationBatchResultSchema,
  ConvexExposureVerificationConfigSchema,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";

interface InstallationReader {
  listInstallationsByIds(
    scope: ReturnType<typeof envScope>,
    installationIds: readonly string[],
  ): Promise<Array<{ installationId: string; status: "active" | "revoked" }>>;
}

export async function loadExposureVerificationConfigs(
  repo: Repository,
  installations: InstallationReader,
  rawInput: ConvexExposureVerificationBatchRequest,
): Promise<ConvexExposureVerificationBatchResult> {
  const input = ConvexExposureVerificationBatchRequestSchema.parse(rawInput);
  const scope = envScope(input.appId, input.environmentId);
  const [installationRows, experiments, runs] = await Promise.all([
    installations.listInstallationsByIds(
      scope,
      input.items.map((item) => item.installationId),
    ),
    repo.experiments.listExperimentsByIds(
      scope,
      input.items.map((item) => item.experimentId),
    ),
    repo.experiments.listRunsByIds(
      scope,
      input.items.map((item) => item.runId),
    ),
  ]);
  const flags = await repo.flags.listFlagsByIds(
    appScope(input.appId),
    experiments.map((experiment) => experiment.flagId),
  );
  const activeInstallationIds = new Set(
    installationRows
      .filter((installation) => installation.status === "active")
      .map((installation) => installation.installationId),
  );
  const experimentById = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  const flagById = new Map(flags.map((flag) => [flag.id, flag]));
  const runById = new Map(runs.map((run) => [run.id, run]));

  return ConvexExposureVerificationBatchResultSchema.parse(
    input.items.map((item) => {
      if (!activeInstallationIds.has(item.installationId)) {
        return { status: "installation_not_found" as const };
      }
      const experiment = experimentById.get(item.experimentId);
      const flag = experiment ? flagById.get(experiment.flagId) : undefined;
      const run = runById.get(item.runId);
      if (
        !experiment ||
        !flag ||
        !run ||
        flag.key !== item.flagKey ||
        run.experimentId !== item.experimentId
      ) {
        return { status: "configuration_not_found" as const };
      }
      return {
        status: "found" as const,
        config: ConvexExposureVerificationConfigSchema.parse({
          appId: input.appId,
          environmentId: input.environmentId,
          flagKey: flag.key,
          experimentId: experiment.id,
          runId: run.id,
          runConfigHash: run.configHash,
          targetingKey: run.targetingKeyField,
          targetingKeyType: run.targetingKeyType,
          controlVariantId: run.controlVariantId,
          salt: run.salt,
          allocation: JSON.parse(run.allocation),
          variantSet: JSON.parse(run.variantSet),
          targetingRules: JSON.parse(run.targetingRules),
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        }),
      };
    }),
  );
}
