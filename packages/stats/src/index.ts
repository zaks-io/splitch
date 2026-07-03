// biome-ignore lint/performance/noBarrelFile: package public-API entry for contract-backed stats shapes and local CI adapters.
export {
  ActivationRowSchema,
  ArmResultSchema,
  DecisionFamilyMemberSchema,
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
} from "./sequential-ci.js";
export { applyGuardrailBoundChecks } from "./guardrail-bound-check.js";
export { applyDecisionFamilyCorrection } from "./decision-family-fdr.js";
export { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";
export { checkSrmHealth, SRM_MISMATCH_P_VALUE } from "./srm-checker.js";
export type {
  ActivationRow,
  ArmResult,
  DecisionFamilyMember,
  DedupeExposureRow,
  GuardrailResult,
  HealthMetrics,
  PerEntityMetricRow,
  PrePeriodRow,
  SrmResult,
  StatsEngine,
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
} from "./sequential-ci.js";
export type {
  DecisionFamilyArmResult,
  DecisionFamilyCorrectionInput,
  DecisionFamilyCorrectionOutput,
  DecisionFamilyCorrectionSummary,
} from "./decision-family-fdr.js";
export type { GuardrailBoundCheckInput, GuardrailThreshold } from "./guardrail-bound-check.js";
export type {
  CupedCovariateRow,
  CupedCovariateSource,
  MetricArmEstimate,
  MetricArmEstimateInput,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
  MetricVarianceStatus,
} from "./variance-estimator-types.js";
export type { SrmCheckerInput, SrmCheckerOutput } from "./srm-checker.js";
