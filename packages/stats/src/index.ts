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
export { computeSequentialCI, SEQUENTIAL_CI_SOURCE, SequentialCI } from "./sequential-ci";
export { computeFixedHorizonCI, FIXED_HORIZON_CI_SOURCE, FixedHorizonCI } from "./fixed-horizon-ci";
export { alwaysValidCriticalScale, alwaysValidInflation } from "./always-valid-inflation";
export { planExperiment } from "./experiment-plan";
export { analyzeStats, StatsEngine } from "./stats-engine";
export { analysisVersionPolicy } from "./analysis-version-policy";
export type { AnalysisVersionPolicy, SrmProcedure } from "./analysis-version-policy";
export { applyGuardrailBoundChecks } from "./guardrail-bound-check";
export { applyDecisionFamilyCorrection } from "./decision-family-fdr";
export {
  FAMILY_CORRECTION_PROCEDURES,
  familyCorrectionAlpha,
  harmonicNumber,
  largestRejectedRank,
  resolveFamilyCorrectionProcedure,
} from "./family-correction";
export { estimateMetricArm, estimateMetricComparison } from "./variance-estimators";
export { checkSrmHealth, SRM_MISMATCH_P_VALUE } from "./srm-checker";
export {
  computeSequentialSrm,
  SEQUENTIAL_SRM_DEFAULT_ALPHA,
  SEQUENTIAL_SRM_DEFAULT_CONCENTRATION,
  SEQUENTIAL_SRM_SOURCE,
} from "./sequential-srm";
export { classifyRopeVerdict, ROPE_VERDICTS } from "./rope-verdict";
export {
  classifySrmRootCause,
  SRM_ROOT_CAUSE_BRANCHES,
  SRM_ROOT_CAUSE_NEXT_CHECK,
  SRM_ROOT_CAUSE_TELEMETRY_GAPS,
} from "./srm-root-cause";
export {
  classifySrmRootCauseFromStats,
  srmRootCauseInputFromStats,
} from "./srm-root-cause-from-stats";
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
export type {
  ExperimentPlanBaselineSource,
  ExperimentPlanInput,
  ExperimentPlanIssue,
  ExperimentPlanMetricKind,
  ExperimentPlanOutcome,
  ExperimentPlanResult,
} from "./experiment-plan";
export type { StatsEngineOptions } from "./stats-engine";
export type {
  DecisionFamilyArmResult,
  DecisionFamilyCorrectionInput,
  DecisionFamilyCorrectionOutput,
  DecisionFamilyCorrectionSummary,
} from "./decision-family-fdr";
export type { FamilyCorrectionProcedure } from "./family-correction";
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
export type {
  SequentialSrmInput,
  SequentialSrmObservations,
  SequentialSrmResult,
} from "./sequential-srm";
export type { RopeScale, RopeVerdict, RopeVerdictInput } from "./rope-verdict";
export type {
  SrmRootCauseBranch,
  SrmRootCauseClassification,
  SrmRootCauseDayBucket,
  SrmRootCauseInput,
  SrmRootCauseSegmentCut,
} from "./srm-root-cause";
