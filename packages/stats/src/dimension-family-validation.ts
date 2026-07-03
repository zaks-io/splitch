import type { DecisionFamilyMember, DimensionClass, StatsInput } from "@splitch/contracts";

export interface DimensionSpec {
  readonly dimension_id: string;
  readonly class: DimensionClass;
  readonly values: ReadonlySet<string> | null;
}

interface PrimaryDimensionValidationContext {
  readonly lockedMembers: ReadonlySet<string>;
  readonly goalMetricIds: readonly string[];
  readonly treatmentVariants: readonly string[];
}

export function validatePrimaryDimensionSpecs(
  input: StatsInput,
  specs: readonly DimensionSpec[],
): void {
  const context = primaryDimensionValidationContext(input);

  for (const spec of specs) {
    if (spec.class === "primary") {
      validatePrimaryDimensionSpec(spec, context);
    }
  }
}

function primaryDimensionValidationContext(input: StatsInput): PrimaryDimensionValidationContext {
  return {
    lockedMembers: new Set(input.decision_family.map(decisionFamilyKey)),
    goalMetricIds: lockedGoalMetricIds(input.decision_family),
    treatmentVariants: Object.keys(input.allocation)
      .filter((variant) => variant !== input.control_variant)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function validatePrimaryDimensionSpec(
  spec: DimensionSpec,
  context: PrimaryDimensionValidationContext,
): void {
  if (spec.values === null) {
    throw new Error(`Primary Dimension ${spec.dimension_id} requires locked declared values.`);
  }

  for (const value of spec.values) {
    validatePrimaryDimensionValue(spec.dimension_id, value, context);
  }
}

function validatePrimaryDimensionValue(
  dimensionId: string,
  dimensionValue: string,
  context: PrimaryDimensionValidationContext,
): void {
  for (const metricId of context.goalMetricIds) {
    validatePrimaryMetricDimensionValue(metricId, dimensionId, dimensionValue, context);
  }
}

function validatePrimaryMetricDimensionValue(
  metricId: string,
  dimensionId: string,
  dimensionValue: string,
  context: PrimaryDimensionValidationContext,
): void {
  for (const variant of context.treatmentVariants) {
    const member = {
      metric_id: metricId,
      variant,
      dimension_id: dimensionId,
      dimension_value: dimensionValue,
    };
    if (!context.lockedMembers.has(decisionFamilyKey(member))) {
      throw new Error(
        `Primary Dimension ${dimensionId}=${dimensionValue} is missing ${metricId}/${variant} from decision_family.`,
      );
    }
  }
}

function lockedGoalMetricIds(decisionFamily: readonly DecisionFamilyMember[]): string[] {
  const metricIds = new Set<string>();

  for (const member of decisionFamily) {
    if (member.dimension_id !== undefined && member.dimension_id !== null) {
      continue;
    }
    if (member.dimension_value !== undefined && member.dimension_value !== null) {
      continue;
    }
    metricIds.add(member.metric_id);
  }

  return [...metricIds].sort((left, right) => left.localeCompare(right));
}

function decisionFamilyKey(member: DecisionFamilyMember): string {
  return JSON.stringify([
    member.metric_id,
    member.variant,
    member.dimension_id ?? null,
    member.dimension_value ?? null,
  ]);
}
