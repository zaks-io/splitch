import {
  StatsInputSchema,
  StatsOutputSchema,
  type ArmResult,
  type DecisionFamilyMember,
  type StatsEngine as StatsEngineContract,
  type StatsInput,
  type StatsOutput,
} from "@splitch/contracts";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import {
  analyzeDimensionResults,
  dimensionResultsWithCorrectedArms,
  type DimensionArmResult,
} from "./dimension-slicing";
import { analysisExposureRows } from "./exposure-denominator";
import { applyGuardrailBoundChecks } from "./guardrail-bound-check";
import { analyzeMetricArmResults, defaultArmResultAdapters } from "./metric-arm-results";
import type { CIAdapter } from "./sequential-ci";
import { checkSrmHealth } from "./srm-checker";

export interface StatsEngineOptions {
  readonly sequentialCI?: CIAdapter;
  readonly fixedHorizonCI?: CIAdapter;
}

type CorrectableArmResult = ArmResult &
  Partial<Pick<DecisionFamilyMember, "dimension_id" | "dimension_value">>;

export const StatsEngine = {
  analyze: analyzeStats,
} satisfies StatsEngineContract;

export async function analyzeStats(
  rawInput: StatsInput,
  options: StatsEngineOptions = {},
): Promise<StatsOutput> {
  const input = StatsInputSchema.parse(rawInput);
  validateLockedRunInput(input);

  const { srm, health } = checkSrmHealth({
    run_id: input.run_id,
    allocation: input.allocation,
    exposures: input.exposures,
    activation_rows: input.activation_rows,
  });
  const adapters = defaultArmResultAdapters(options);
  const analysisExposures = analysisExposureRows({
    run_id: input.run_id,
    exposures: input.exposures,
    activation_rows: input.activation_rows,
  });
  const armResults = analyzeMetricArmResults(input, analysisExposures, adapters);
  const dimensionResults = analyzeDimensionResults(input, analysisExposures, adapters);
  const corrected = applyDecisionFamilyCorrection({
    arm_results: [...armResults, ...dimensionResults.flatMap((dimension) => dimension.arm_results)],
    decision_family: input.decision_family,
    confidence_level: input.confidence_level,
    control_variant: input.control_variant,
  } satisfies {
    arm_results: CorrectableArmResult[];
    decision_family: readonly DecisionFamilyMember[];
    confidence_level: number;
    control_variant: string;
  });
  const correctedArmResults = corrected.arm_results.slice(0, armResults.length) as ArmResult[];
  const correctedDimensionResults = dimensionResultsWithCorrectedArms(
    dimensionResults,
    corrected.arm_results.slice(armResults.length) as DimensionArmResult[],
  );
  const guardrailResults = applyGuardrailBoundChecks({
    arm_results: correctedArmResults,
    guardrails: input.guardrail_decisions,
  });

  return StatsOutputSchema.parse({
    arm_results: correctedArmResults,
    srm,
    guardrail_results: guardrailResults,
    health,
    ...(correctedDimensionResults.length > 0
      ? { dimension_results: correctedDimensionResults }
      : {}),
  });
}

function validateLockedRunInput(input: StatsInput): void {
  if (input.horizon === "fixed" && input.sample_size_locked === undefined) {
    throw new Error("fixed horizon requires sample_size_locked from the locked Run input.");
  }
  if (input.horizon === "fixed" && input.target_n !== undefined) {
    throw new Error("target_n is only valid when the locked Run horizon is sequential.");
  }
  if (input.horizon === "sequential" && input.sample_size_locked !== undefined) {
    throw new Error("sample_size_locked is only valid when the locked Run horizon is fixed.");
  }
}
