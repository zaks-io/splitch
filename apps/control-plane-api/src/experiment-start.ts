import type {
  Condition,
  GuardrailDecision,
  MetricRef,
  MetricQueryConfig,
  MetricVarianceConfig,
  ResolvedTargetingRule,
  TargetingRule,
  Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { randomHex } from "./credential-cache";
import {
  allocationInvalid,
  experimentNoDraft,
  segmentReferenceMissing,
  variantNotAvailable,
} from "./experiment-errors";
import { validateMetricRefs } from "./experiment-handler-shared";
import {
  type ExperimentRow,
  jsonArray,
  jsonArrayOrNull,
  jsonObject,
  runConfigHash,
} from "./experiment-model";
import { frozenAnalysisConfig } from "./experiment-start-analysis";
import { flagNotFound } from "./flag-definition-errors";
import { resolveTargetingRules } from "./targeting-rule-resolution";

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
    controlVariantId: string;
    targetingRules: ResolvedTargetingRule[];
    configHash: string;
    decisionFamily: MetricRef[];
    guardrailDecisions: GuardrailDecision[];
    metricQueryConfig: MetricQueryConfig[];
    metricVarianceConfig: MetricVarianceConfig[];
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

  const variants = await frozenVariantSet(repo, scope, experiment, allocation, requestId);
  if (!variants.ok) return variants;

  const resolved = await resolvedTargetingRules(repo, scope, experiment, requestId);
  if (!resolved.ok) return resolved;
  const targetingRules = resolved.value;

  const metricsReady = await frozenMetricRefs(repo, scope.appId, experiment, requestId);
  if (!metricsReady.ok) return metricsReady;

  const analysis = await frozenAnalysisConfig(
    repo,
    scope.appId,
    metricsReady.value,
    treatmentVariants(allocation, variants.value),
    experiment.conversionWindowMs,
    requestId,
  );
  if (!analysis.ok) return analysis;

  const salt = experiment.draftSalt ?? `salt_${randomHex(12)}`;
  const configHash = await runConfigHash({
    salt,
    allocation,
    variantSet: variants.value.variantSet,
    targetingRules,
  });
  return {
    ok: true,
    value: {
      allocation,
      salt,
      variantSet: variants.value.variantSet,
      controlVariantId: variants.value.controlVariantId,
      targetingRules,
      configHash,
      decisionFamily: metricsReady.value.metrics,
      guardrailDecisions: analysis.value.guardrailDecisions,
      metricQueryConfig: analysis.value.metricQueryConfig,
      metricVarianceConfig: analysis.value.metricVarianceConfig,
    },
  };
}

/**
 * Allocation is keyed by Variant NAME and the Control is identified by id, so
 * the frozen Variant set is the only place the two meet. Sorted for a stable
 * frozen order, matching how the Run Snapshot expands the decision family.
 */
function treatmentVariants(
  allocation: Record<string, number>,
  variants: { variantSet: Variant[]; controlVariantId: string },
): string[] {
  const control = variants.variantSet.find(
    (variant) => variant.id === variants.controlVariantId,
  )?.name;
  return Object.keys(allocation)
    .filter((name) => name !== control)
    .sort();
}

async function frozenVariantSet(
  repo: Repository,
  scope: EnvScope,
  experiment: ExperimentRow,
  allocation: Record<string, number>,
  requestId: string,
): Promise<Result<{ variantSet: Variant[]; controlVariantId: string }>> {
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
  const controlVariantId = experiment.defaultVariantId;
  if (!isFrozenControlVariant(controlVariantId, variantSet.value)) {
    return {
      ok: false,
      response: variantNotAvailable(
        experiment.flagId,
        scope.environmentId,
        [controlVariantId ?? "control"],
        requestId,
      ),
    };
  }
  return { ok: true, value: { variantSet: variantSet.value, controlVariantId } };
}

/**
 * Metric delete after End is allowed (SPL-289), so a draft can still name a
 * Metric that no longer exists. Re-check with the same Create/PATCH helper
 * before freezing the decision family into the Run.
 */
async function frozenMetricRefs(
  repo: Repository,
  appId: string,
  experiment: ExperimentRow,
  requestId: string,
): Promise<Result<{ metrics: MetricRef[]; guardrailMetrics: MetricRef[] }>> {
  const metrics = jsonArray<MetricRef>(experiment.metrics);
  const guardrailMetrics = jsonArray<MetricRef>(experiment.guardrailMetrics);
  const metricError = await validateMetricRefs(
    repo,
    appId,
    {
      metrics,
      guardrailMetrics,
      ...(experiment.activationMetricId
        ? { activationMetricId: experiment.activationMetricId }
        : {}),
    },
    requestId,
  );
  if (metricError) return { ok: false, response: metricError };
  return { ok: true, value: { metrics, guardrailMetrics } };
}

function isFrozenControlVariant(
  controlVariantId: string | null,
  variantSet: Variant[],
): controlVariantId is string {
  return controlVariantId !== null && variantSet.some((variant) => variant.id === controlVariantId);
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
): Promise<Result<ResolvedTargetingRule[]>> {
  const rules = jsonArray<TargetingRule>(experiment.draftTargetingRules);
  const resolvedRules = await resolveTargetingRules(repo, scope.appId, rules);
  if (!resolvedRules.ok) {
    return {
      ok: false,
      response: segmentReferenceMissing(experiment.id, resolvedRules.missingSegmentIds, requestId),
    };
  }
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
      ...resolvedRules.rules,
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
