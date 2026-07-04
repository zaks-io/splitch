// biome-ignore lint/performance/noBarrelFile: package public-API entry for contract-backed stats shapes and local CI adapters.
export {
  ActivationRowSchema,
  ArmResultSchema,
  DecisionFamilyMemberSchema,
  DimensionClassSchema,
  DimensionInputSchema,
  DimensionResultSchema,
  DedupeExposureRowSchema,
  GuardrailResultSchema,
  PerEntityMetricRowSchema,
  PrePeriodRowSchema,
  StatsInputSchema,
  StatsOutputSchema,
} from "@splitch/contracts";
export {
  computeSequentialCI,
  SEQUENTIAL_CI_SOURCE,
  SequentialCI,
} from "./sequential-ci";
export {
  computeFixedHorizonCI,
  FIXED_HORIZON_CI_SOURCE,
  FixedHorizonCI,
} from "./fixed-horizon-ci";
export { analyzeStats, StatsEngine } from "./stats-engine";
export { applyGuardrailBoundChecks } from "./guardrail-bound-check";
export { applyDecisionFamilyCorrection } from "./decision-family-fdr";
export { estimateMetricArm, estimateMetricComparison } from "./variance-estimators";
export { checkSrmHealth, SRM_MISMATCH_P_VALUE } from "./srm-checker";
export type {
  ActivationRow,
  ArmResult,
  DecisionFamilyMember,
  DimensionClass,
  DimensionInput,
  DimensionResult,
  DedupeExposureRow,
  GuardrailResult,
  HealthMetrics,
  PerEntityMetricRow,
  PrePeriodRow,
  SrmResult,
  StatsInput,
  StatsOutput,
  WinsorizeCap,
} from "@splitch/contracts";
export type {
  CIAdapter,
  CIError,
  CIParams,
  CIResult,
  CISource,
  CIStatus,
  CIWarning,
  SequentialCIOptions,
} from "./sequential-ci";
export type { StatsEngineOptions } from "./stats-engine";
export type {
  DecisionFamilyArmResult,
  DecisionFamilyCorrectionInput,
  DecisionFamilyCorrectionOutput,
  DecisionFamilyCorrectionSummary,
} from "./decision-family-fdr";
export type { GuardrailBoundCheckInput, GuardrailThreshold } from "./guardrail-bound-check";
export type {
  CupedCovariateRow,
  CupedCovariateSource,
  MetricArmEstimate,
  MetricArmEstimateInput,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
  MetricVarianceStatus,
} from "./variance-estimator-types";
export type { SrmCheckerInput, SrmCheckerOutput } from "./srm-checker";
