import type {
  FlagRemovalEnvironmentServing,
  FlagRemovalServingBlocker,
  HydratedFlagConfiguration,
  Variant,
} from "@splitch/contracts";

/**
 * Configuration-derived "which Variant does this Environment serve?" for the
 * removal brief. Not runtime telemetry: a fractional rollout or Targeting Rule
 * fan-out means no single served Variant, and a live Experiment blocks removal.
 */

export function analyzeEnvironmentServing(input: {
  environmentId: string;
  environmentKey: string;
  configuration: HydratedFlagConfiguration;
  defaultVariantName: string;
  variants: readonly Variant[];
}): FlagRemovalEnvironmentServing {
  const blockers = servingBlockers(input.configuration, input.defaultVariantName, input.variants);
  const candidates = configurationServableVariants(
    input.configuration,
    input.defaultVariantName,
    input.variants,
  );
  return {
    environmentId: input.environmentId,
    environmentKey: input.environmentKey,
    enabled: input.configuration.enabled,
    configurationServedVariant: soleCandidate(candidates, blockers),
    servingEvidence: "configuration_unverified",
    blockers,
  };
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

function soleCandidate(
  candidates: ReadonlySet<string>,
  blockers: readonly FlagRemovalServingBlocker[],
): string | null {
  if (blockers.length > 0 || candidates.size !== 1) return null;
  for (const name of candidates) return name;
  return null;
}

function collectUniformityBlockers(servings: readonly FlagRemovalEnvironmentServing[]): string[] {
  const removalBlockers: string[] = [];
  for (const serving of servings) {
    for (const blocker of serving.blockers) {
      removalBlockers.push(`${serving.environmentKey}: ${blockerLabel(blocker)}`);
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

function servingBlockers(
  configuration: HydratedFlagConfiguration,
  defaultVariantName: string,
  variants: readonly Variant[],
): FlagRemovalServingBlocker[] {
  const blockers = new Set<FlagRemovalServingBlocker>();
  if (configuration.experiment !== null) blockers.add("live_experiment");
  if (hasFractionalRollout(configuration)) blockers.add("fractional_rollout");
  const candidates = configurationServableVariants(configuration, defaultVariantName, variants);
  if (candidates.size > 1 && !blockers.has("fractional_rollout")) {
    blockers.add("multi_variant_targeting");
  }
  return [...blockers];
}

function hasFractionalRollout(configuration: HydratedFlagConfiguration): boolean {
  if (isFractional(configuration.rollout?.percentage ?? null)) return true;
  return configuration.targetingRules.some((rule) =>
    isFractional(rule.percentageRollout?.percentage ?? null),
  );
}

function configurationServableVariants(
  configuration: HydratedFlagConfiguration,
  defaultVariantName: string,
  variants: readonly Variant[],
): Set<string> {
  const names = baselineServableVariants(configuration, defaultVariantName, variants);
  const byId = new Map(variants.map((variant) => [variant.id, variant.name]));
  for (const rule of configuration.targetingRules) {
    addRuleVariants(names, rule, byId, defaultVariantName);
  }
  return names;
}

function baselineServableVariants(
  configuration: HydratedFlagConfiguration,
  defaultVariantName: string,
  variants: readonly Variant[],
): Set<string> {
  const names = new Set<string>();
  const rolloutPct = configuration.rollout?.percentage ?? null;
  if (rolloutPct === null || rolloutPct === 0) {
    names.add(defaultVariantName);
    return names;
  }
  const treatment = soleNonDefault(configuration, defaultVariantName, variants);
  if (rolloutPct === 100) {
    names.add(treatment ?? defaultVariantName);
    return names;
  }
  names.add(defaultVariantName);
  if (treatment) names.add(treatment);
  return names;
}

function addRuleVariants(
  names: Set<string>,
  rule: HydratedFlagConfiguration["targetingRules"][number],
  byId: ReadonlyMap<string, string>,
  defaultVariantName: string,
): void {
  const ruleVariant = byId.get(rule.variantId);
  if (!ruleVariant) {
    throw new Error(
      `flag-removal-serving: Targeting Rule ${rule.id} names unknown Variant ${rule.variantId}`,
    );
  }
  const rulePct = rule.percentageRollout?.percentage ?? null;
  if (rulePct === null || rulePct === 100) {
    names.add(ruleVariant);
    return;
  }
  if (rulePct === 0) {
    names.add(defaultVariantName);
    return;
  }
  names.add(ruleVariant);
  names.add(defaultVariantName);
}

function soleNonDefault(
  configuration: HydratedFlagConfiguration,
  defaultVariantName: string,
  variants: readonly Variant[],
): string | null {
  const scope =
    configuration.availableVariantNames.length > 0
      ? configuration.availableVariantNames
      : variants.map((variant) => variant.name);
  const candidates = scope.filter((name) => name !== defaultVariantName);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function isFractional(percentage: number | null): boolean {
  return percentage !== null && percentage > 0 && percentage < 100;
}

function blockerLabel(blocker: FlagRemovalServingBlocker): string {
  switch (blocker) {
    case "live_experiment":
      return "a live Experiment controls assignment";
    case "fractional_rollout":
      return "a fractional Percentage Rollout serves more than one Variant";
    case "multi_variant_targeting":
      return "Targeting Rules can serve more than one Variant";
    default: {
      const _exhaustive: never = blocker;
      return _exhaustive;
    }
  }
}
