import type {
  ErrorCode,
  EvaluationContext,
  PercentageRollout,
  TestEvaluationReason,
  Variant,
} from "@splitch/contracts";
import type { AssignmentStore } from "../assignment/assignment-store.js";
import { fractionalEval } from "../assignment/fractional-eval.js";
import type { RunConfig } from "../assignment/run-config.js";
import { type FlagConfig, type Provider, ProviderError } from "../provider/provider.js";
import { matchesConditions } from "./conditions.js";

type EvaluateKind =
  | "disabled"
  | "null_experiment"
  | "holdover_replay"
  | "no_live_run"
  | "rule_match_direct"
  | "rule_match_percentage"
  | "no_match_default"
  | "error";

type VariantName = string;

export interface EvaluatePathInput {
  appId: string;
  environmentId: string;
  flagKey: string;
  evaluationContext: EvaluationContext;
}

export interface EvaluatePathDeps {
  assignmentStore: AssignmentStore;
  provider: Provider;
  logger?: Pick<Console, "error" | "warn">;
}

interface ExposureDecision {
  appId: string;
  environmentId: string;
  experimentId: string;
  flagKey: string;
  idType: string;
  liveRunId: string;
  targetingKey: string;
  variant: VariantName;
}

interface BaseEvaluateResult {
  kind: EvaluateKind;
  variant: VariantName | null;
  reason: TestEvaluationReason | "ERROR";
  exposure: ExposureDecision | null;
}

interface NonExposingEvaluateResult extends BaseEvaluateResult {
  kind: "disabled" | "null_experiment" | "no_live_run";
  exposure: null;
  liveRunId: null;
  reason: { type: "default_disabled" };
  variant: VariantName;
}

interface HoldoverEvaluateResult extends BaseEvaluateResult {
  kind: "holdover_replay";
  exposure: null;
  isHoldover: true;
  liveRunId: null;
  priorRunId: string;
  reason: { type: "holdover_replay"; priorRunId: string };
  variant: VariantName;
}

interface RuleMatchEvaluateResult extends BaseEvaluateResult {
  kind: "rule_match_direct" | "rule_match_percentage";
  exposure: ExposureDecision;
  experimentId: string;
  liveRunId: string;
  reason: Extract<TestEvaluationReason, { type: "rule_matched" }>;
  variant: VariantName;
}

interface NoMatchEvaluateResult extends BaseEvaluateResult {
  kind: "no_match_default";
  exposure: ExposureDecision;
  experimentId: string;
  liveRunId: string;
  reason: { type: "no_match_default" };
  variant: VariantName;
}

interface ErrorEvaluateResult extends BaseEvaluateResult {
  kind: "error";
  errorCode: ErrorCode;
  errorMessage: string;
  exposure: null;
  liveRunId: null;
  reason: "ERROR";
}

export type EvaluateResult =
  | NonExposingEvaluateResult
  | HoldoverEvaluateResult
  | RuleMatchEvaluateResult
  | NoMatchEvaluateResult
  | ErrorEvaluateResult;

class EvaluatePathError extends Error {
  readonly errorCode: ErrorCode = "INTERNAL_SERVER_ERROR";
}

export async function evaluatePath(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<EvaluateResult> {
  const { appId, environmentId, flagKey } = input;
  const held = await preloadHoldovers(input, deps);
  let defaultVariant: string | null = null;

  try {
    const flag = await deps.provider.getFlag(appId, environmentId, flagKey);
    defaultVariant = flag.defaultVariant;

    if (!flag.enabled) {
      return defaultResult("disabled", flag.defaultVariant);
    }

    if (flag.experimentId === null) {
      return defaultResult("null_experiment", flag.defaultVariant);
    }

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

    const experiment = await deps.provider.getExperiment(appId, environmentId, flag.experimentId);
    if (experiment.liveRun === null) {
      return defaultResult("no_live_run", flag.defaultVariant);
    }

    return evaluateLiveRun(input, flag, flag.experimentId, experiment.liveRun);
  } catch (cause) {
    return errorResult(defaultVariant, cause, deps.logger);
  }
}

async function preloadHoldovers(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<Awaited<ReturnType<AssignmentStore["getAll"]>>> {
  try {
    return await deps.assignmentStore.getAll({
      appId: input.appId,
      idType: input.evaluationContext.idType,
      targetingKey: input.evaluationContext.targetingKey,
    });
  } catch (cause) {
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
): RuleMatchEvaluateResult | NoMatchEvaluateResult {
  const rules = [...run.targetingRules].sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    if (!matchesConditions(rule.conditions, input.evaluationContext)) {
      continue;
    }

    const directVariant = variantNameForId(flag.variants, rule.variantId);
    const rollout = rule.percentageRollout ?? null;
    const selection = rollout === null ? "direct" : "percentage_rollout";
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
        selection,
        rollout: rolloutReason(directVariant, rollout),
      },
      experimentId,
      liveRunId: run.runId,
      exposure: exposureDecision(input, experimentId, run.runId, variant),
    };
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

function errorResult(
  defaultVariant: string | null,
  cause: unknown,
  logger: EvaluatePathDeps["logger"],
): ErrorEvaluateResult {
  const errorCode = errorCodeFor(cause);
  const errorMessage = cause instanceof Error ? cause.message : "Evaluation failed";
  logger?.error("evaluate_path_failed", { cause, errorCode });

  return {
    kind: "error",
    variant: defaultVariant,
    reason: "ERROR",
    errorCode,
    errorMessage,
    liveRunId: null,
    exposure: null,
  };
}

function errorCodeFor(cause: unknown): ErrorCode {
  if (cause instanceof ProviderError || cause instanceof EvaluatePathError) {
    return cause.errorCode;
  }
  return "INTERNAL_SERVER_ERROR";
}
