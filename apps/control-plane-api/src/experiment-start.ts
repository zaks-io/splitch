import type { Condition, MetricRef, TargetingRule, Variant } from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { randomHex } from "./credential-cache";
import {
  allocationInvalid,
  experimentNoDraft,
  segmentReferenceMissing,
  variantNotAvailable,
} from "./experiment-errors";
import {
  jsonArray,
  jsonArrayOrNull,
  jsonObject,
  runConfigHash,
  type ExperimentRow,
} from "./experiment-model";
import { flagNotFound } from "./flag-definition-errors";

type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function prepareStart(
  repo: Repository,
  scope: EnvScope,
  experiment: ExperimentRow,
  requestId: string,
): Promise<
  Result<{
    allocation: Record<string, number>;
    salt: string;
    variantSet: Variant[];
    targetingRules: TargetingRule[];
    configHash: string;
    decisionFamily: MetricRef[];
    guardrailDecisions: MetricRef[];
  }>
> {
  const allocation = jsonObject<Record<string, number>>(experiment.draftAllocation);
  if (!allocation) {
    return {
      ok: false,
      response: experimentNoDraft(experiment.id, experiment.liveRunId, requestId),
    };
  }

  const allocationError = validateAllocation(allocation, requestId);
  if (allocationError) return { ok: false, response: allocationError };

  const flagConfig = await repo.flags.getFlagConfig(scope, experiment.flagId);
  const flag = await repo.flags.getFlag(appScope(scope.appId), experiment.flagId);
  if (!flag || !flagConfig) return { ok: false, response: flagNotFound(requestId) };

  const available = new Set(jsonArray<string>(flagConfig.availableVariantNames));
  const missing = Object.keys(allocation).filter((name) => !available.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      response: variantNotAvailable(experiment.flagId, scope.environmentId, missing, requestId),
    };
  }

  const variantSet = await variantSetForAllocation(repo, scope, experiment.flagId, allocation);
  if (!variantSet.ok) {
    return {
      ok: false,
      response: variantNotAvailable(
        experiment.flagId,
        scope.environmentId,
        variantSet.missing,
        requestId,
      ),
    };
  }

  const resolved = await resolvedTargetingRules(repo, scope, experiment, requestId);
  if (!resolved.ok) return resolved;
  const targetingRules = resolved.value;
  const salt = experiment.draftSalt ?? `salt_${randomHex(12)}`;
  const configHash = await runConfigHash({
    salt,
    allocation,
    variantSet: variantSet.value,
    targetingRules,
  });
  return {
    ok: true,
    value: {
      allocation,
      salt,
      variantSet: variantSet.value,
      targetingRules,
      configHash,
      decisionFamily: jsonArray<MetricRef>(experiment.metrics),
      guardrailDecisions: jsonArray<MetricRef>(experiment.guardrailMetrics),
    },
  };
}

function validateAllocation(
  allocation: Record<string, number>,
  requestId: string,
): Response | null {
  const sum = Object.values(allocation).reduce((total, value) => total + value, 0);
  const invalidShare = Object.values(allocation).some(
    (value) => !Number.isFinite(value) || value < 0 || value > 100,
  );
  if (Object.keys(allocation).length === 0 || invalidShare || Math.abs(sum - 100) > 1e-6) {
    return allocationInvalid(allocation, sum, requestId);
  }
  return null;
}

async function variantSetForAllocation(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
  allocation: Record<string, number>,
): Promise<{ ok: true; value: Variant[] } | { ok: false; missing: string[] }> {
  const catalog = await repo.flags.listVariants(appScope(scope.appId), flagId);
  const variantsByName = new Map(
    catalog.map((variant) => [
      variant.name,
      {
        id: variant.id,
        name: variant.name,
        value: JSON.parse(variant.value) as Variant["value"],
        ...(variant.description ? { description: variant.description } : {}),
      },
    ]),
  );
  const variantSet = Object.keys(allocation).map((name) => variantsByName.get(name));
  if (variantSet.some((variant) => variant === undefined)) {
    return {
      ok: false,
      missing: Object.keys(allocation).filter((name) => !variantsByName.has(name)),
    };
  }
  return { ok: true, value: variantSet as Variant[] };
}

async function resolvedTargetingRules(
  repo: Repository,
  scope: EnvScope,
  experiment: ExperimentRow,
  requestId: string,
): Promise<Result<TargetingRule[]>> {
  const rules = jsonArray<TargetingRule>(experiment.draftTargetingRules);
  const segmentIds = jsonArrayOrNull<string>(experiment.draftSegmentIds) ?? [];
  const segments = await repo.flags.listSegmentsByIds(appScope(scope.appId), segmentIds);

  // Fail loud on a dangling reference: `listSegmentsByIds` silently drops
  // missing IDs, so a Segment deleted after the draft was staged would freeze a
  // Run with NO segment rule — silently widening the audience to everyone.
  const found = new Set(segments.map((segment) => segment.id));
  const missing = segmentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return { ok: false, response: segmentReferenceMissing(experiment.id, missing, requestId) };
  }

  return {
    ok: true,
    value: [
      ...rules,
      ...segments.map((segment, index) => ({
        id: `rule_${segment.id}`,
        flagId: experiment.flagId,
        priority: rules.length + index,
        conditions: jsonArray<Condition>(segment.conditions),
        variantId: experiment.defaultVariantId ?? "",
      })),
    ],
  };
}
