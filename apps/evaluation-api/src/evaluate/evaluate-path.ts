import type { PercentageRollout, TargetingRule, Variant } from "@splitch/contracts";
import { assign } from "../assignment/assign";
import { AssignmentStoreError } from "../assignment/assignment-store";
import { fractionalEval } from "../assignment/fractional-eval";
import type { RunConfig } from "../assignment/run-config";
import type { ExperimentConfig, FlagConfig } from "../provider/provider";
import { matchesConditions } from "./conditions";
import { EvaluatePathError, errorResult } from "./evaluate-errors";
import type {
  EvaluatePathDeps,
  EvaluatePathInput,
  EvaluateResult,
  ExposureDecision,
  FreshAssignmentEvaluateResult,
  NoMatchEvaluateResult,
  NonExposingEvaluateResult,
  RuleMatchEvaluateResult,
} from "./evaluate-path-types";

export type { EvaluatePathDeps, EvaluatePathInput, EvaluateResult } from "./evaluate-path-types";

export async function evaluatePath(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<EvaluateResult> {
  const { appId, environmentId, flagKey } = input;
  let defaultVariant: string | null = null;

  try {
    const flag = await deps.provider.getFlag(appId, environmentId, flagKey);
    defaultVariant = flag.defaultVariant;

    if (!flag.enabled) {
      return defaultResult("disabled", flag.defaultVariant);
    }

    if (flag.experimentId === null) {
      return evaluateFlagOnly(input, flag, null, deps.logger);
    }

    const experiment = await deps.provider.getExperiment(appId, environmentId, flag.experimentId);
    const validatedInput = withValidatedIdType(input, experiment);
    const held = await preloadHoldovers(validatedInput, deps);

    const holdover = held.get(flag.experimentId);
    if (holdover !== undefined) {
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

    if (experiment.liveRun === null) {
      return evaluateFlagOnly(input, flag, flag.experimentId, deps.logger);
    }

    return evaluateLiveRun(
      validatedInput,
      flag,
      flag.experimentId,
      experiment.liveRun,
      deps.logger,
    );
  } catch (cause) {
    return errorResult(defaultVariant, cause, deps.logger);
  }
}

function evaluateFlagOnly(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
  logger: EvaluatePathDeps["logger"],
): RuleMatchEvaluateResult | NoMatchEvaluateResult {
  const rules = [...flag.targetingRules].sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    const match = evaluateTargetingRule(input, flag, experimentId, null, rule, logger);
    if (match !== null) return match;
  }

  return {
    kind: "no_match_default",
    variant: flag.defaultVariant,
    reason: { type: "no_match_default" },
    ...(experimentId === null ? {} : { experimentId }),
    liveRunId: null,
    exposure: null,
  };
}

function withValidatedIdType(
  input: EvaluatePathInput,
  experiment: ExperimentConfig,
): EvaluatePathInput {
  const validatedIdType = experiment.targetingKeyType;
  if (input.evaluationContext.idType !== validatedIdType) {
    throw new EvaluatePathError(
      `Evaluation idType "${input.evaluationContext.idType}" does not match Experiment targetingKeyType "${validatedIdType}"`,
      "VALIDATION_ERROR",
    );
  }

  return {
    ...input,
    evaluationContext: { ...input.evaluationContext, idType: validatedIdType },
  };
}

async function preloadHoldovers(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<Awaited<ReturnType<EvaluatePathDeps["assignmentStore"]["getAll"]>>> {
  try {
    return await deps.assignmentStore.getAll({
      appId: input.appId,
      idType: input.evaluationContext.idType,
      targetingKey: input.evaluationContext.targetingKey,
    });
  } catch (cause) {
    if (cause instanceof AssignmentStoreError) {
      throw cause;
    }
    deps.logger?.warn("assignment_store_get_all_failed", { cause });
    return new Map();
  }
}

function defaultResult(
  kind: "disabled" | "null_experiment" | "no_live_run",
  variant: string,
): NonExposingEvaluateResult {
  return {
    kind,
    variant,
    reason: { type: "default_disabled" },
    liveRunId: null,
    exposure: null,
  };
}

function evaluateLiveRun(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string,
  run: RunConfig,
  logger: EvaluatePathDeps["logger"],
): FreshAssignmentEvaluateResult | RuleMatchEvaluateResult | NoMatchEvaluateResult {
  const rules = [...run.targetingRules].sort((a, b) => a.priority - b.priority);
  if (rules.length === 0) {
    const variant = assign(run, input.evaluationContext.targetingKey);
    return {
      kind: "fresh_assignment",
      variant,
      reason: { type: "fresh_assignment" },
      experimentId,
      liveRunId: run.runId,
      exposure: exposureDecision(input, experimentId, run.runId, variant),
    };
  }

  for (const rule of rules) {
    const match = evaluateTargetingRule(input, flag, experimentId, run, rule, logger);
    if (match !== null) return match;
  }

  return {
    kind: "no_match_default",
    variant: flag.defaultVariant,
    reason: { type: "no_match_default" },
    experimentId,
    liveRunId: run.runId,
    exposure: exposureDecision(input, experimentId, run.runId, flag.defaultVariant),
  };
}

function evaluateTargetingRule(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
  run: RunConfig | null,
  rule: TargetingRule,
  logger: EvaluatePathDeps["logger"],
): RuleMatchEvaluateResult | null {
  if (!matchesConditions(rule.conditions, input.evaluationContext, { logger, ruleId: rule.id })) {
    return null;
  }

  const directVariant = variantNameForId(flag.variants, rule.variantId);
  const rollout = rule.percentageRollout ?? null;
  const selection = rollout === null ? "direct" : "percentage_rollout";
  const variant = variantForTargetingRule(input, flag.defaultVariant, directVariant, rollout);

  return {
    kind: rollout === null ? "rule_match_direct" : "rule_match_percentage",
    variant,
    reason: {
      type: "rule_matched",
      ruleId: rule.id,
      ruleName: null,
      priority: rule.priority,
      selection,
      rollout: rolloutReason(directVariant, rollout),
    },
    ...(experimentId === null ? {} : { experimentId }),
    liveRunId: run?.runId ?? null,
    exposure:
      experimentId === null || run === null
        ? null
        : exposureDecision(input, experimentId, run.runId, variant),
  };
}

function variantForTargetingRule(
  input: EvaluatePathInput,
  defaultVariant: string,
  directVariant: string,
  rollout: PercentageRollout | null,
) {
  if (rollout === null) {
    return directVariant;
  }
  return fractionalEval(rollout.salt, input.evaluationContext.targetingKey, [
    { variantName: directVariant, weight: rollout.percentage },
    { variantName: defaultVariant, weight: 100 - rollout.percentage },
  ]);
}

function exposureDecision(
  input: EvaluatePathInput,
  experimentId: string,
  liveRunId: string,
  variant: string,
): ExposureDecision {
  return {
    appId: input.appId,
    environmentId: input.environmentId,
    experimentId,
    flagKey: input.flagKey,
    idType: input.evaluationContext.idType,
    liveRunId,
    targetingKey: input.evaluationContext.targetingKey,
    variant,
  };
}

function rolloutReason(variantName: string, rollout: PercentageRollout | null) {
  if (rollout === null) {
    return null;
  }
  return { variantWeights: [{ variantName, weight: rollout.percentage }] };
}

function variantNameForId(variants: Variant[], variantId: string): string {
  const variant = variants.find((item) => item.id === variantId);
  if (variant === undefined) {
    throw new EvaluatePathError(`Targeting Rule variantId "${variantId}" names no Variant`);
  }
  return variant.name;
}
