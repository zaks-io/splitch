import type { PercentageRollout, ResolvedTargetingRule, Variant } from "@splitch/contracts";
import { assign, fractionalEval } from "./assignment";
import { matchesConditions } from "./conditions";
import {
  AssignmentStoreError,
  ConditionMatchError,
  EvaluatePathError,
  ProviderError,
} from "./errors";
import type {
  BaselineRolloutEvaluateResult,
  EvaluatePathDeps,
  EvaluatePathInput,
  EvaluateResult,
  ExposureDecision,
  FlagConfig,
  FreshAssignmentEvaluateResult,
  NoMatchEvaluateResult,
  NonExposingEvaluateResult,
  RuleMatchEvaluateResult,
  RunConfig,
} from "./types";

export async function evaluatePath(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<EvaluateResult> {
  let defaultVariant: string | null = null;
  try {
    const flag = await deps.provider.getFlag(input.appId, input.environmentId, input.flagKey);
    defaultVariant = flag.defaultVariant;
    if (!flag.enabled) return defaultResult("disabled", flag.defaultVariant);
    if (flag.experimentId === null) return evaluateFlagOnly(input, flag, null, deps.logger);
    const experiment = await deps.provider.getExperiment(
      input.appId,
      input.environmentId,
      flag.experimentId,
    );
    if (input.evaluationContext.idType !== experiment.targetingKeyType) {
      throw new EvaluatePathError(
        `Evaluation idType "${input.evaluationContext.idType}" does not match Experiment targetingKeyType "${experiment.targetingKeyType}"`,
        "VALIDATION_ERROR",
      );
    }
    let held: Map<string, { runId: string; variant: string }>;
    try {
      held = await deps.assignmentStore.getAll({
        appId: input.appId,
        idType: input.evaluationContext.idType,
        targetingKey: input.evaluationContext.targetingKey,
      });
    } catch (cause) {
      if (cause instanceof AssignmentStoreError) throw cause;
      deps.logger?.warn("assignment_store_get_all_failed", { cause });
      held = new Map();
    }
    const holdover = held.get(flag.experimentId);
    if (holdover) {
      return {
        kind: "holdover_replay",
        variant: holdover.variant,
        reason: { type: "holdover_replay", priorRunId: holdover.runId },
        isHoldover: true,
        priorRunId: holdover.runId,
        liveRunId: null,
        exposure: null,
      };
    }
    if (experiment.liveRun === null)
      return evaluateFlagOnly(input, flag, flag.experimentId, deps.logger);
    return evaluateLiveRun(input, flag, flag.experimentId, experiment.liveRun, deps.logger);
  } catch (cause) {
    return errorResult(defaultVariant, cause, deps.logger);
  }
}

function evaluateFlagOnly(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
  logger: EvaluatePathDeps["logger"],
): RuleMatchEvaluateResult | BaselineRolloutEvaluateResult | NoMatchEvaluateResult {
  for (const rule of [...flag.targetingRules].sort((a, b) => a.priority - b.priority)) {
    const match = evaluateTargetingRule(input, flag, experimentId, null, rule, logger);
    if (match) return match;
  }
  return unmatchedResult(input, flag, experimentId);
}

function evaluateLiveRun(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string,
  run: RunConfig,
  logger: EvaluatePathDeps["logger"],
): FreshAssignmentEvaluateResult | RuleMatchEvaluateResult | NoMatchEvaluateResult {
  const rules = [...run.targetingRules].sort((a, b) => a.priority - b.priority);
  if (rules.length === 0)
    return fresh(input, experimentId, run.runId, assign(run, input.evaluationContext.targetingKey));
  for (const rule of rules) {
    const match = evaluateTargetingRule(input, flag, experimentId, run, rule, logger);
    if (match) return match;
  }
  return {
    kind: "no_match_default",
    variant: flag.defaultVariant,
    reason: { type: "no_match_default" },
    experimentId,
    liveRunId: run.runId,
    exposure: exposure(input, experimentId, run.runId, flag.defaultVariant),
  };
}

function evaluateTargetingRule(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
  run: RunConfig | null,
  rule: ResolvedTargetingRule,
  logger: EvaluatePathDeps["logger"],
): RuleMatchEvaluateResult | null {
  if (!matchesConditions(rule.conditions, input.evaluationContext, { logger, ruleId: rule.id }))
    return null;
  const directVariant = variantNameForId(flag.variants, rule.variantId);
  const rollout = rule.percentageRollout ?? null;
  const variant =
    rollout === null
      ? directVariant
      : fractionalEval(rollout.salt, input.evaluationContext.targetingKey, [
          { variantName: directVariant, weight: rollout.percentage },
          { variantName: flag.defaultVariant, weight: 100 - rollout.percentage },
        ]);
  return {
    kind: rollout === null ? "rule_match_direct" : "rule_match_percentage",
    variant,
    reason: {
      type: "rule_matched",
      ruleId: rule.id,
      ruleName: null,
      priority: rule.priority,
      selection: rollout === null ? "direct" : "percentage_rollout",
      rollout: rolloutReason(directVariant, rollout),
    },
    ...(experimentId === null ? {} : { experimentId }),
    liveRunId: run?.runId ?? null,
    exposure:
      experimentId === null || run === null
        ? null
        : exposure(input, experimentId, run.runId, variant),
  };
}

function unmatchedResult(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
): BaselineRolloutEvaluateResult | NoMatchEvaluateResult {
  const experiment = experimentId === null ? {} : { experimentId };
  if (flag.rollout === null)
    return {
      kind: "no_match_default",
      variant: flag.defaultVariant,
      reason: { type: "no_match_default" },
      ...experiment,
      liveRunId: null,
      exposure: null,
    };
  const scope =
    flag.availableVariantNames.length > 0
      ? flag.availableVariantNames
      : flag.variants.map((variant) => variant.name);
  const candidates = scope.filter((name) => name !== flag.defaultVariant);
  const target = candidates[0];
  if (candidates.length !== 1 || !target)
    throw new EvaluatePathError(
      `FlagConfig ${flag.appId}/${flag.environmentId}/${flag.flagKey}: a baseline rollout needs exactly one non-Default Variant to roll into, found ${candidates.length}`,
    );
  const weights = [
    { variantName: target, weight: flag.rollout.percentage },
    { variantName: flag.defaultVariant, weight: 100 - flag.rollout.percentage },
  ];
  return {
    kind: "baseline_rollout",
    variant: fractionalEval(flag.rollout.salt, input.evaluationContext.targetingKey, weights),
    reason: { type: "baseline_rollout", rollout: { variantWeights: weights } },
    ...experiment,
    liveRunId: null,
    exposure: null,
  };
}

function fresh(
  input: EvaluatePathInput,
  experimentId: string,
  runId: string,
  variant: string,
): FreshAssignmentEvaluateResult {
  return {
    kind: "fresh_assignment",
    variant,
    reason: { type: "fresh_assignment" },
    experimentId,
    liveRunId: runId,
    exposure: exposure(input, experimentId, runId, variant),
  };
}

function exposure(
  input: EvaluatePathInput,
  experimentId: string,
  runId: string,
  variant: string,
): ExposureDecision {
  return {
    appId: input.appId,
    environmentId: input.environmentId,
    experimentId,
    flagKey: input.flagKey,
    idType: input.evaluationContext.idType,
    liveRunId: runId,
    targetingKey: input.evaluationContext.targetingKey,
    variant,
  };
}

function defaultResult(
  kind: "disabled" | "null_experiment" | "no_live_run",
  variant: string,
): NonExposingEvaluateResult {
  return { kind, variant, reason: { type: "default_disabled" }, liveRunId: null, exposure: null };
}

function rolloutReason(variantName: string, rollout: PercentageRollout | null) {
  return rollout === null
    ? null
    : { variantWeights: [{ variantName, weight: rollout.percentage }] };
}

function variantNameForId(variants: Variant[], variantId: string): string {
  const variant = variants.find((item) => item.id === variantId);
  if (!variant)
    throw new EvaluatePathError(`Targeting Rule variantId "${variantId}" names no Variant`);
  return variant.name;
}

function errorResult(
  defaultVariant: string | null,
  cause: unknown,
  logger: EvaluatePathDeps["logger"],
): EvaluateResult {
  const known =
    cause instanceof EvaluatePathError ||
    cause instanceof ProviderError ||
    cause instanceof AssignmentStoreError ||
    cause instanceof ConditionMatchError;
  const errorCode = known ? cause.errorCode : "INTERNAL_SERVER_ERROR";
  logger?.error("evaluate_path_failed", { cause, errorCode });
  return {
    kind: "error",
    variant: defaultVariant,
    reason: cause instanceof ProviderError ? cause.resolutionReason : "ERROR",
    errorCode,
    errorMessage: cause instanceof Error ? cause.message : "Evaluation failed",
    liveRunId: null,
    exposure: null,
  };
}
