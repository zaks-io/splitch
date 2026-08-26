import {
  ConvexExposureVerificationConfigSchema,
  type ConvexExposureVerificationRequest,
  ConvexExposureVerificationRequestSchema,
  type ConvexExposureVerificationResult,
  ConvexExposureVerificationResultSchema,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";

export async function loadCloudflareExposureVerificationConfig(
  repo: Repository,
  rawInput: ConvexExposureVerificationRequest,
): Promise<ConvexExposureVerificationResult> {
  const input = ConvexExposureVerificationRequestSchema.parse(rawInput);
  const scope = envScope(input.appId, input.environmentId);
  const installation = await repo.cloudflare.getInstallation(scope, input.installationId);
  if (installation?.status !== "active") return { status: "installation_not_found" };
  const experiment = await repo.experiments.getExperiment(scope, input.experimentId);
  if (!experiment) return { status: "configuration_not_found" };
  const [flag, run] = await Promise.all([
    repo.flags.getFlag(appScope(input.appId), experiment.flagId),
    repo.experiments.getRun(scope, input.runId),
  ]);
  if (!flag || !run || flag.key !== input.flagKey || run.experimentId !== experiment.id)
    return { status: "configuration_not_found" };
  const config = ConvexExposureVerificationConfigSchema.parse({
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
  });
  return ConvexExposureVerificationResultSchema.parse({ status: "found", config });
}
