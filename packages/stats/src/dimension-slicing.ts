import type {
  ArmResult,
  DedupeExposureRow,
  DimensionClass,
  DimensionInput,
  DimensionResult,
  StatsInput,
  StatsResultStatus,
} from "@splitch/contracts";
import { validatePrimaryDimensionSpecs } from "./dimension-family-validation.js";
import { analyzeMetricArmResults, type ArmResultAdapters } from "./metric-arm-results.js";

export type DimensionArmResult = ArmResult & {
  readonly dimension_id: string;
  readonly dimension_value: string;
};

export type RawDimensionResult = Omit<DimensionResult, "arm_results"> & {
  readonly arm_results: DimensionArmResult[];
};

interface MutableDimensionSpec {
  readonly dimension_id: string;
  readonly class: DimensionClass;
  values: Set<string> | null;
}

export function analyzeDimensionResults(
  input: StatsInput,
  analysisExposures: readonly DedupeExposureRow[],
  adapters: ArmResultAdapters,
): RawDimensionResult[] {
  const specs = dimensionSpecs(input);
  const results: RawDimensionResult[] = [];

  for (const spec of specs) {
    for (const value of dimensionValues(spec, analysisExposures)) {
      const sliceExposures = analysisExposures.filter(
        (exposure) => exposure.dimension_values?.[spec.dimension_id] === value,
      );
      const armResults = analyzeMetricArmResults(input, sliceExposures, adapters).map((arm) =>
        dimensionArmResult(input, arm, spec.dimension_id, value),
      );

      results.push({
        dimension_id: spec.dimension_id,
        dimension_value: value,
        class: spec.class,
        arm_results: armResults,
        sample_size_n: sampleSizeForSlice(input, sliceExposures),
        low_n_warning: lowNWarning(input, sliceExposures),
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
      });
    }
  }

  return results;
}

export function dimensionResultsWithCorrectedArms(
  rawResults: readonly RawDimensionResult[],
  correctedArms: readonly DimensionArmResult[],
): DimensionResult[] {
  const results: DimensionResult[] = [];
  let offset = 0;

  for (const rawResult of rawResults) {
    const arms = correctedArms
      .slice(offset, offset + rawResult.arm_results.length)
      .map(stripDimensionFields);
    offset += rawResult.arm_results.length;

    results.push({
      ...rawResult,
      arm_results: arms,
      ...dimensionDecisionFlags(rawResult.class, arms),
    });
  }

  if (offset !== correctedArms.length) {
    throw new Error("corrected Dimension arm result count does not match raw Dimension results.");
  }

  return results;
}

function dimensionSpecs(input: StatsInput): MutableDimensionSpec[] {
  const byId = new Map<string, MutableDimensionSpec>();

  for (const member of input.decision_family) {
    if (member.dimension_id === undefined || member.dimension_id === null) {
      continue;
    }
    if (member.dimension_value === undefined || member.dimension_value === null) {
      continue;
    }
    mergeDimensionSpec(byId, {
      dimension_id: member.dimension_id,
      class: "primary",
      values: [member.dimension_value],
    });
  }

  for (const dimension of input.dimensions ?? []) {
    mergeDimensionSpec(byId, dimension);
  }

  const specs = [...byId.values()].sort((left, right) =>
    left.dimension_id.localeCompare(right.dimension_id),
  );
  validatePrimaryDimensionSpecs(input, specs);
  return specs;
}

function mergeDimensionSpec(
  byId: Map<string, MutableDimensionSpec>,
  dimension: DimensionInput,
): void {
  const existing = byId.get(dimension.dimension_id);
  if (existing !== undefined) {
    if (existing.class !== dimension.class) {
      throw new Error(`dimension ${dimension.dimension_id} cannot be both Primary and Secondary.`);
    }
    addDimensionValues(existing, dimension.values);
    return;
  }

  byId.set(dimension.dimension_id, {
    dimension_id: dimension.dimension_id,
    class: dimension.class,
    values: dimension.values === undefined ? null : new Set(dimension.values),
  });
}

function addDimensionValues(
  existing: MutableDimensionSpec,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) {
    return;
  }

  existing.values ??= new Set<string>();
  for (const value of values) {
    existing.values.add(value);
  }
}

function dimensionValues(
  spec: MutableDimensionSpec,
  analysisExposures: readonly DedupeExposureRow[],
): string[] {
  if (spec.values !== null) {
    return [...spec.values];
  }

  const observed = new Set<string>();
  for (const exposure of analysisExposures) {
    const value = exposure.dimension_values?.[spec.dimension_id];
    if (value !== undefined) {
      observed.add(value);
    }
  }

  return [...observed].sort((left, right) => left.localeCompare(right));
}

function dimensionArmResult(
  input: StatsInput,
  arm: ArmResult,
  dimensionId: string,
  dimensionValue: string,
): DimensionArmResult {
  return {
    ...arm,
    status: dimensionArmStatus(input, arm),
    dimension_id: dimensionId,
    dimension_value: dimensionValue,
  };
}

function dimensionArmStatus(input: StatsInput, arm: ArmResult): StatsResultStatus {
  if (
    input.horizon === "fixed" &&
    input.sample_size_locked !== undefined &&
    arm.sample_size_n < input.sample_size_locked
  ) {
    return "insufficient_n";
  }

  return arm.status;
}

function sampleSizeForSlice(input: StatsInput, exposures: readonly DedupeExposureRow[]): number {
  const entities = new Set<string>();
  const variants = new Set(Object.keys(input.allocation));

  for (const exposure of exposures) {
    if (variants.has(exposure.variant)) {
      entities.add(exposure.targeting_key_hash);
    }
  }

  return entities.size;
}

function lowNWarning(input: StatsInput, exposures: readonly DedupeExposureRow[]): boolean {
  return Object.keys(input.allocation).some((variant) => countEntities(exposures, variant) < 100);
}

function countEntities(exposures: readonly DedupeExposureRow[], variant: string): number {
  const entities = new Set<string>();
  for (const exposure of exposures) {
    if (exposure.variant === variant) {
      entities.add(exposure.targeting_key_hash);
    }
  }
  return entities.size;
}

function dimensionDecisionFlags(
  dimensionClass: DimensionClass,
  arms: readonly ArmResult[],
): Pick<DimensionResult, "in_bh_family" | "exploratory" | "decision_valid"> {
  if (dimensionClass === "secondary") {
    return {
      in_bh_family: false,
      exploratory: true,
      decision_valid: false,
    };
  }

  return {
    in_bh_family: arms.some((arm) => arm.in_bh_family),
    exploratory: arms.every((arm) => arm.exploratory),
    decision_valid: arms.some((arm) => arm.decision_valid && !arm.exploratory),
  };
}

function stripDimensionFields(result: DimensionArmResult): ArmResult {
  return {
    variant: result.variant,
    metric_id: result.metric_id,
    sample_size_n: result.sample_size_n,
    point_estimate: result.point_estimate,
    relative_lift_pct: result.relative_lift_pct,
    ci_lower: result.ci_lower,
    ci_upper: result.ci_upper,
    p_value: result.p_value,
    is_significant: result.is_significant,
    in_bh_family: result.in_bh_family,
    exploratory: result.exploratory,
    decision_valid: result.decision_valid,
    status: result.status,
    variance_techniques: result.variance_techniques,
  };
}
