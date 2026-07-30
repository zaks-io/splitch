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

/**
 * Every Environment where `variantName` is effectively servable, with the data
 * the App-level Variant target version hashes (storage-schemas-d1.md). The set
 * is recomputed live at every call: an Environment joining or leaving it is a
 * vector change that must render the proposal stale.
 */
export async function servableVariantEnvironments(
  repo: Repository,
  appId: string,
  flagId: string,
  variantName: string,
): Promise<Array<{ environmentId: string; configVersion: number; policy: EnvironmentPolicy }>> {
  const servable: Array<{
    environmentId: string;
    configVersion: number;
    policy: EnvironmentPolicy;
  }> = [];
  for (const environment of await repo.identity.listEnvironments(appScope(appId))) {
    const config = await repo.flags.getFlagConfig(envScope(appId, environment.id), flagId);
    if (!config) continue;
    const available = JSON.parse(config.availableVariantNames) as string[];
    if (available.length > 0 && !available.includes(variantName)) continue;
    const policy = await readEnvironmentPolicy(repo, appId, environment.id);
    if (!policy) {
      throw new Error(
        `Environment ${environment.id} disappeared while resolving Approval Policy for ${appId}`,
      );
    }
    servable.push({ environmentId: environment.id, configVersion: config.version, policy });
  }
  return servable.sort((left, right) => left.environmentId.localeCompare(right.environmentId));
}

export async function currentPolicyProjection(
  repo: Repository,
  appId: string,
  contexts: readonly ApprovalPolicyContext[],
): Promise<Array<{ environmentId: string; changeType: PolicyChangeType; level: string }>> {
  const projection: Array<{
    environmentId: string;
    changeType: PolicyChangeType;
    level: string;
  }> = [];
  for (const context of contexts) {
    const policy = await readEnvironmentPolicy(repo, appId, context.environmentId);
    // A deleted Environment drops out of the projection rather than aborting the
    // read: the token changes, so the proposal renders stale instead of 404.
    if (!policy) continue;
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

/**
 * The version of a target that no longer resolves. A vanished target is a
 * version change like any other, so the proposal renders and materializes
 * `stale` (terminal) instead of masquerading as a missing Approval Request.
 */
function absentTargetVersion(target: Pick<ApprovalTarget, "type" | "id">) {
  return canonicalHash({ absentTarget: { type: target.type, id: target.id } });
}

function reviewEnvironmentId(contexts: readonly ApprovalPolicyContext[]): string {
  const environmentId = contexts[0]?.environmentId;
  if (!environmentId) {
    throw new Error("Approval Request policy contexts are empty; cannot resolve a target version");
  }
  return environmentId;
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
): Promise<`sha256:${string}`> {
  if (target.type === "flag_configuration") {
    const config = await repo.flags.getFlagConfigById(
      envScope(appId, reviewEnvironmentId(contexts)),
      target.id,
    );
    if (!config) return absentTargetVersion(target);
    return canonicalHash({
      flagConfigVersion: override?.flagConfigVersion ?? config.version,
      policy: await currentPolicyProjection(repo, appId, contexts),
    });
  }

  if (target.type === "flag_variant") {
    const variant = await repo.flags.getVariantById(appScope(appId), target.id);
    if (!variant) return absentTargetVersion(target);
    const flag = await repo.flags.getFlag(appScope(appId), variant.flagId);
    if (!flag) return absentTargetVersion(target);
    return canonicalHash({
      flagVersion: override?.flagVersion ?? flag.version,
      environmentVector: await variantEnvironmentVector(repo, appId, variant, contexts),
    });
  }

  const experiment = await repo.experiments.getExperiment(
    envScope(appId, reviewEnvironmentId(contexts)),
    target.id,
  );
  if (!experiment) return absentTargetVersion(target);
  return canonicalHash({
    experiment:
      override?.experiment ??
      experimentTargetProjection(experiment as unknown as Record<string, unknown>),
    policy: await currentPolicyProjection(repo, appId, contexts),
  });
}

/**
 * `(environment_id, flag_configs.version, Policy level)` for every Environment
 * where the Variant is *currently* servable — not merely the Environments the
 * frozen `policy_contexts` happened to cover. One Environment cannot approve an
 * App-level Variant change behind a stricter Environment's Policy, and an
 * Environment entering or leaving the servable set makes the proposal stale.
 */
async function variantEnvironmentVector(
  repo: Repository,
  appId: string,
  variant: { flagId: string; name: string },
  contexts: readonly ApprovalPolicyContext[],
) {
  const changeTypes = [...new Set(contexts.flatMap((context) => context.changeTypes))].sort();
  const servable = await servableVariantEnvironments(repo, appId, variant.flagId, variant.name);
  return servable.map((environment) => ({
    environmentId: environment.environmentId,
    configVersion: environment.configVersion,
    levels: changeTypes.map((changeType) => ({
      changeType,
      level: policyLevel(environment.policy, changeType),
    })),
  }));
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
