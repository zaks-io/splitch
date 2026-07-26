import { fractionalEval } from "../assignment/fractional-eval";
import type { FlagConfig } from "../provider/provider";
import { EvaluatePathError } from "./evaluate-errors";
import type {
  BaselineRolloutEvaluateResult,
  EvaluatePathInput,
  NoMatchEvaluateResult,
} from "./evaluate-path-types";

/**
 * What traffic matching NO Targeting Rule resolves to: the config-level baseline
 * rollout if one is set, otherwise the Default Variant. A matched rule never
 * reaches here — it wins outright and honours its own `percentageRollout`.
 *
 * Reached only off the flag-only path, so there is no live Run and no Exposure.
 */
export function unmatchedResult(
  input: EvaluatePathInput,
  flag: FlagConfig,
  experimentId: string | null,
): BaselineRolloutEvaluateResult | NoMatchEvaluateResult {
  const experiment = experimentId === null ? {} : { experimentId };

  if (flag.rollout === null) {
    return {
      kind: "no_match_default",
      variant: flag.defaultVariant,
      reason: { type: "no_match_default" },
      ...experiment,
      liveRunId: null,
      exposure: null,
    };
  }

  const weights = baselineWeights(flag, rolloutVariantName(flag));
  return {
    kind: "baseline_rollout",
    variant: fractionalEval(flag.rollout.salt, input.evaluationContext.targetingKey, weights),
    reason: { type: "baseline_rollout", rollout: { variantWeights: weights } },
    ...experiment,
    liveRunId: null,
    exposure: null,
  };
}

/**
 * The Variant the baseline rolls traffic INTO. The Default Variant is what the
 * rollout rolls AWAY from, so the target is the one other available Variant.
 * Anything but exactly two available Variants is ambiguous, and guessing would
 * silently roll traffic into an arbitrary Variant, so it throws (ADR-0036).
 */
function rolloutVariantName(flag: FlagConfig): string {
  const candidates = flag.availableVariantNames.filter((name) => name !== flag.defaultVariant);
  const target = candidates[0];
  if (candidates.length !== 1 || target === undefined) {
    throw new EvaluatePathError(
      `FlagConfig ${flag.appId}/${flag.environmentId}/${flag.flagKey}: a baseline rollout needs ` +
        `exactly one non-Default available Variant, found ${candidates.length}`,
    );
  }
  return target;
}

function baselineWeights(flag: FlagConfig, rolledInto: string) {
  // Order is part of the bucket layout (fractional-eval.ts), so the rolled-into
  // share must always come first for boundaries to stay stable.
  const percentage = flag.rollout?.percentage ?? 0;
  return [
    { variantName: rolledInto, weight: percentage },
    { variantName: flag.defaultVariant, weight: 100 - percentage },
  ];
}
