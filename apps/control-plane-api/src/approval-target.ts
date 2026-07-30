import {
  type ApprovalPolicyContext,
  ApprovalPolicyContextSchema,
  type ApprovalTarget,
  type EnvironmentPolicy,
  type PolicyChangeType,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { canonicalHash } from "./approval-canonical";
import { policyLevel, readEnvironmentPolicy } from "./flag-config-policy";

export function environmentPolicyContexts(
  environmentId: string,
  policy: EnvironmentPolicy,
  changeTypes: readonly PolicyChangeType[],
): ApprovalPolicyContext[] {
  const grouped = new Map<ApprovalPolicyContext["level"], PolicyChangeType[]>();
  for (const changeType of [...new Set(changeTypes)].sort()) {
    const level = policyLevel(policy, changeType);
    grouped.set(level, [...(grouped.get(level) ?? []), changeType]);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([level, types]) =>
      ApprovalPolicyContextSchema.parse({
        environmentId,
        changeTypes: types,
        level,
      }),
    );
}

export function requiresReview(contexts: readonly ApprovalPolicyContext[]): boolean {
  return contexts.some((context) => context.level !== "allow");
}

export async function currentPolicyProjection(
  repo: Repository,
  appId: string,
  contexts: readonly ApprovalPolicyContext[],
): Promise<Array<{ environmentId: string; changeType: PolicyChangeType; level: string }> | null> {
  const projection: Array<{
    environmentId: string;
    changeType: PolicyChangeType;
    level: string;
  }> = [];
  for (const context of contexts) {
    const policy = await readEnvironmentPolicy(repo, appId, context.environmentId);
    if (!policy) return null;
    for (const changeType of context.changeTypes) {
      projection.push({
        environmentId: context.environmentId,
        changeType,
        level: policyLevel(policy, changeType),
      });
    }
  }
  return projection.sort((left, right) =>
    `${left.environmentId}:${left.changeType}`.localeCompare(
      `${right.environmentId}:${right.changeType}`,
    ),
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: target projections fail closed and deliberately avoid a generic fallback
export async function approvalTargetVersion(
  repo: Repository,
  appId: string,
  target: Pick<ApprovalTarget, "type" | "id">,
  contexts: readonly ApprovalPolicyContext[],
  override?: {
    flagConfigVersion?: number;
    flagVersion?: number;
    experiment?: Record<string, unknown>;
  },
): Promise<`sha256:${string}` | null> {
  const policy = await currentPolicyProjection(repo, appId, contexts);
  if (!policy) return null;

  if (target.type === "flag_configuration") {
    const environmentId = contexts[0]?.environmentId;
    if (!environmentId) return null;
    const config = await repo.flags.getFlagConfigById(envScope(appId, environmentId), target.id);
    if (!config) return null;
    return canonicalHash({
      flagConfigVersion: override?.flagConfigVersion ?? config.version,
      policy,
    });
  }

  if (target.type === "flag_variant") {
    const variant = await repo.flags.getVariantById(appScope(appId), target.id);
    if (!variant) return null;
    const flag = await repo.flags.getFlag(appScope(appId), variant.flagId);
    if (!flag) return null;
    const configVersions = [];
    for (const context of contexts) {
      const config = await repo.flags.getFlagConfig(
        envScope(appId, context.environmentId),
        variant.flagId,
      );
      if (!config) return null;
      configVersions.push({
        environmentId: context.environmentId,
        version: config.version,
      });
    }
    return canonicalHash({
      flagVersion: override?.flagVersion ?? flag.version,
      configVersions: configVersions.sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId),
      ),
      policy,
    });
  }

  const environmentId = contexts[0]?.environmentId;
  if (!environmentId) return null;
  const experiment = await repo.experiments.getExperiment(
    envScope(appId, environmentId),
    target.id,
  );
  if (!experiment) return null;
  return canonicalHash({
    experiment:
      override?.experiment ??
      experimentTargetProjection(experiment as unknown as Record<string, unknown>),
    policy,
  });
}

export function experimentTargetProjection(
  experiment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: experiment.id,
    flagId: experiment.flagId,
    targetingKeyField: experiment.targetingKeyField,
    targetingKeyType: experiment.targetingKeyType,
    confidenceLevel: experiment.confidenceLevel,
    defaultVariantId: experiment.defaultVariantId,
    metrics: parseJson(experiment.metrics),
    guardrailMetrics: parseJson(experiment.guardrailMetrics),
    activationMetricId: experiment.activationMetricId,
    conversionWindowMs: experiment.conversionWindowMs,
    dimensions: parseJson(experiment.dimensions),
    draftAllocation: parseJson(experiment.draftAllocation),
    draftSalt: experiment.draftSalt,
    draftTargetingRules: parseJson(experiment.draftTargetingRules),
    draftSegmentIds: parseJson(experiment.draftSegmentIds),
    liveRunId: experiment.liveRunId,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  return JSON.parse(value) as unknown;
}
