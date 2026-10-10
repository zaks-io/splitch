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
export type {
  AnalysisVersionPolicy,
  GuardrailBoundProcedure,
  SrmProcedure,
} from "./analysis-version-policy";
export { applyGuardrailBoundChecks } from "./guardrail-bound-check";
export { evaluateOneSidedGuardrail } from "./guardrail-one-sided";
export {
  normalMixtureOneSidedBoundary,
  normalMixtureOneSidedScale,
  rhoSquaredForOneSidedTargetN,
} from "./normal-mixture-one-sided";
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
  classifyMdeExclusionFutility,
  FUTILITY_VERDICTS,
} from "./futility-verdict";
export { classifySrmRootCause } from "./srm-root-cause";
export {
  SRM_ROOT_CAUSE_BRANCHES,
  SRM_ROOT_CAUSE_FUTURE_BRANCHES,
  SRM_ROOT_CAUSE_NEXT_CHECK,
} from "./srm-root-cause-types";
export {
  classifySrmRootCauseFromStats,
  srmRootCauseInputFromStats,
} from "./srm-root-cause-from-stats";
export { computeCohortEffect } from "./cohort-effect";
export { fixedHorizonAbsoluteInterval } from "./cohort-effect-estimate";
export { exposureDayBucket } from "./cohort-effect-buckets";
export { classifyCohortNovelty } from "./cohort-effect-novelty";
export {
  COHORT_EFFECT_BUCKET_IDS,
  COHORT_EFFECT_MIN_ARM_N,
  COHORT_EFFECT_NOVELTY_ALPHA,
} from "./cohort-effect-types";
export type { CohortEffectComputeInput } from "./cohort-effect-types";
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
  FutilityClassification,
  FutilityVerdict,
  FutilityVerdictInput,
} from "./futility-verdict";
export type {
  SrmRootCauseBranch,
  SrmRootCauseClassification,
  SrmRootCauseInput,
} from "./srm-root-cause-types";

export { produceExperimentResults } from "./results-producer";
export type {
  ExperimentResultsRunContext,
  ProduceExperimentResultsInput,
} from "./results-producer";
export { computeShipRecommendation } from "./ship-recommendation-compute";
export type { ShipRecommendationResult } from "./ship-recommendation-compute";
export {
  evaluateExperimentDecisionGate,
  experimentSrmDiagnostics,
  overlayPersistedSrmAlarms,
  srmTierFor,
} from "./decision-gate";
export {
  earliestDecisionWatermark,
  observedEvidenceDays,
  plannedDurationCheck,
} from "./decision-gate-duration";
export type { PlannedDurationEvidence } from "./decision-gate-duration";
export {
  activatedSrmCheck,
  activationBalanceCheck,
  controlIdentityCheck,
  decisionValidCheck,
  engineStatusCheck,
  exposureSrmCheck,
  srmIsFiring,
  underpoweredCheck,
} from "./decision-gate-checks";
export { decisionValidMembers, lockedFamilyMembers, named } from "./decision-gate-family";
export { reasonsFromChecks, statisticalReadiness } from "./results-readiness";
