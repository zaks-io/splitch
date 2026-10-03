import type {
  FlagRemovalEnvironmentServing,
  FlagRemovalServingBlocker,
  PercentageRollout,
  Variant,
} from "@splitch/contracts";
import {
  evaluatePath,
  type AssignmentStoreReader,
  type FlagConfig,
  type Provider,
} from "@splitch/evaluation-core";

/**
 * Configuration-derived "which Variant does this Environment serve?" for the
 * removal brief. Uses evaluation-core (same path as the evaluation API) with
 * each Environment's stored Configuration, including its own defaultVariantId
 * and enabled state. Not runtime telemetry.
 *
 * Targeting Rules and partial rollouts are never uniform: traffic can diverge
 * by Evaluation Context. Only disabled / null / 0% / 100% baseline paths are
 * evaluated, and an evaluation rejection is reported rather than substituted.
 */

/** Key is irrelevant for 0%/100%/disabled/null paths; never used for fractional. */
const UNIFORMITY_TARGETING_KEY = "flag-removal-brief-uniformity";

export async function analyzeEnvironmentServing(input: {
  appId: string;
  flagKey: string;
  environmentId: string;
  environmentKey: string;
  enabled: boolean;
  defaultVariantId: string;
  availableVariantNames: readonly string[];
  targetingRulesCount: number;
  rollout: PercentageRollout | null;
  hasLiveExperiment: boolean;
  variants: readonly Variant[];
}): Promise<FlagRemovalEnvironmentServing> {
  const blockers = structuralBlockers(input);
  if (blockers.length > 0) {
    return environmentServing(input, null, blockers);
  }

  const defaultVariant = input.variants.find((variant) => variant.id === input.defaultVariantId);
  if (!defaultVariant) {
    throw new Error(
      `flag-removal-serving: Environment ${input.environmentId} defaultVariantId ${input.defaultVariantId} names no Variant`,
    );
  }

  const flagConfig: FlagConfig = {
    flagKey: input.flagKey,
    appId: input.appId,
    environmentId: input.environmentId,
    experimentId: null,
    enabled: input.enabled,
    defaultVariant: defaultVariant.name,
    variants: [...input.variants],
    availableVariantNames: [...input.availableVariantNames],
    targetingRules: [],
    rollout: input.rollout,
  };

  const result = await evaluatePath(
    {
      appId: input.appId,
      environmentId: input.environmentId,
      flagKey: input.flagKey,
      evaluationContext: {
        targetingKey: UNIFORMITY_TARGETING_KEY,
        idType: "user",
        attributes: {},
      },
    },
    { provider: staticFlagProvider(flagConfig), assignmentStore: emptyAssignmentStore() },
  );

  if (result.kind === "error") {
    return environmentServing(input, null, ["evaluation_rejected"], result.errorMessage);
  }
  if (result.variant === null) {
    return environmentServing(
      input,
      null,
      ["evaluation_rejected"],
      "evaluation returned no Variant",
    );
  }
  return environmentServing(input, result.variant, []);
}

export function removalUniformity(servings: readonly FlagRemovalEnvironmentServing[]): {
  uniformAcrossEnvironments: boolean;
  keepVariant: string | null;
  removalSafe: boolean;
  removalBlockers: string[];
} {
  const removalBlockers = collectUniformityBlockers(servings);
  const keepVariant = sharedKeepVariant(servings, removalBlockers);
  return {
    uniformAcrossEnvironments: keepVariant !== null,
    keepVariant,
    removalSafe: keepVariant !== null,
    removalBlockers,
  };
}

function structuralBlockers(input: {
  targetingRulesCount: number;
  rollout: PercentageRollout | null;
  hasLiveExperiment: boolean;
}): FlagRemovalServingBlocker[] {
  const blockers: FlagRemovalServingBlocker[] = [];
  if (input.hasLiveExperiment) blockers.push("live_experiment");
  if (input.targetingRulesCount > 0) blockers.push("multi_variant_targeting");
  if (isPartialRollout(input.rollout)) blockers.push("fractional_rollout");
  return blockers;
}

function environmentServing(
  input: { environmentId: string; environmentKey: string; enabled: boolean },
  configurationServedVariant: string | null,
  blockers: readonly FlagRemovalServingBlocker[],
  evaluationError: string | null = null,
): FlagRemovalEnvironmentServing {
  return {
    environmentId: input.environmentId,
    environmentKey: input.environmentKey,
    enabled: input.enabled,
    configurationServedVariant,
    servingEvidence: "configuration_unverified",
    blockers: [...blockers],
    evaluationError,
  };
}

function collectUniformityBlockers(servings: readonly FlagRemovalEnvironmentServing[]): string[] {
  const removalBlockers: string[] = [];
  for (const serving of servings) {
    for (const blocker of serving.blockers) {
      removalBlockers.push(`${serving.environmentKey}: ${blockerLabel(blocker, serving)}`);
    }
    if (serving.configurationServedVariant === null && serving.blockers.length === 0) {
      removalBlockers.push(
        `${serving.environmentKey}: configuration does not pin a single served Variant`,
      );
    }
  }
  removalBlockers.push(...crossEnvironmentBlockers(servings));
  return [...new Set(removalBlockers)];
}

function crossEnvironmentBlockers(servings: readonly FlagRemovalEnvironmentServing[]): string[] {
  if (servings.length === 0) return ["App has no Environments to compare"];
  const keepVariants = pinnedVariants(servings);
  if (keepVariants.size > 1) {
    return [`Environments disagree on the Variant to keep: ${[...keepVariants].sort().join(", ")}`];
  }
  if (keepVariants.size === 1 && servings.some((s) => s.configurationServedVariant === null)) {
    return ["Not every Environment pins the same single Variant; removal is not yet safe"];
  }
  if (keepVariants.size === 0) {
    return ["No Environment pins a single served Variant yet"];
  }
  return [];
}

function sharedKeepVariant(
  servings: readonly FlagRemovalEnvironmentServing[],
  blockers: readonly string[],
): string | null {
  if (blockers.length > 0) return null;
  const keepVariants = pinnedVariants(servings);
  if (keepVariants.size !== 1) return null;
  for (const name of keepVariants) return name;
  return null;
}

function pinnedVariants(servings: readonly FlagRemovalEnvironmentServing[]): Set<string> {
  const names = new Set<string>();
  for (const serving of servings) {
    if (serving.configurationServedVariant !== null) {
      names.add(serving.configurationServedVariant);
    }
  }
  return names;
}

function isPartialRollout(rollout: PercentageRollout | null): boolean {
  if (rollout === null) return false;
  return rollout.percentage > 0 && rollout.percentage < 100;
}

function staticFlagProvider(flag: FlagConfig): Provider {
  return {
    async getFlag(appId, environmentId, flagKey) {
      if (
        appId !== flag.appId ||
        environmentId !== flag.environmentId ||
        flagKey !== flag.flagKey
      ) {
        throw new Error(
          `flag-removal-serving: Provider asked for ${appId}/${environmentId}/${flagKey}, have ${flag.appId}/${flag.environmentId}/${flag.flagKey}`,
        );
      }
      return flag;
    },
    async getFlags() {
      return [flag];
    },
    async getExperiment() {
      throw new Error("flag-removal-serving: Experiments are blocked before evaluation");
    },
  };
}

function emptyAssignmentStore(): AssignmentStoreReader {
  return {
    async getAll() {
      return new Map();
    },
    async put() {
      throw new Error("flag-removal-serving: Assignment Store writes are not used");
    },
    async putHashed() {
      throw new Error("flag-removal-serving: Assignment Store writes are not used");
    },
  };
}

function blockerLabel(
  blocker: FlagRemovalServingBlocker,
  serving: FlagRemovalEnvironmentServing,
): string {
  switch (blocker) {
    case "live_experiment":
      return "a live Experiment controls assignment";
    case "fractional_rollout":
      return "a fractional Percentage Rollout serves more than one Variant";
    case "multi_variant_targeting":
      return "Targeting Rules make serving depend on Evaluation Context";
    case "evaluation_rejected":
      return serving.evaluationError ?? "evaluation rejected this Configuration";
    default: {
      const _exhaustive: never = blocker;
      return _exhaustive;
    }
  }
}
