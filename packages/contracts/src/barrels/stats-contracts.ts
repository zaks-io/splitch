// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

// What the stats engine is handed and what it returns. Grouped because they are
// read together: the analysis knobs frozen on the input (variance config,
// guardrail bounds) are what the result's techniques and guardrail rows report
// back against.
export type {
  ActivationRow,
  CupedCovariateRow,
  CupedCovariateSource,
  DedupeExposureRow,
  DimensionInput,
  GuardrailDecision,
  MetricVarianceConfig,
  PerEntityMetricRow,
  PrePeriodRow,
  StatsInput,
} from "../stats-input-contract";
export {
  ActivationRowSchema,
  CupedCovariateRowSchema,
  CupedCovariateSourceSchema,
  DecisionFamilyMemberSchema,
  DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT,
  DEFAULT_WINSORIZE,
  DEFAULT_WINSORIZE_PCT,
  DedupeExposureRowSchema,
  DimensionInputSchema,
  GuardrailDecisionSchema,
  MetricVarianceConfigSchema,
  PerEntityMetricRowSchema,
  PrePeriodRowSchema,
  StatsInputSchema,
} from "../stats-input-contract";
export type {
  AnalysisResultsEnvelope,
  ArmResult,
  CupedAttributeSource,
  CupedMethod,
  DimensionClass,
  DimensionResult,
  GuardrailResult,
  HealthMetrics,
  SrmResult,
  StatsEngine,
  StatsOutput,
  StatsResultStatus,
  VarianceTechniques,
  WinsorizeCap,
} from "../stats-result-contract";
export {
  AnalysisResultsEnvelopeSchema,
  ArmResultSchema,
  CupedAttributeSourceSchema,
  CupedMethodSchema,
  cupedAttributeSources,
  cupedMethods,
  DimensionClassSchema,
  DimensionResultSchema,
  dimensionClasses,
  GuardrailResultSchema,
  HealthMetricsSchema,
  SrmResultSchema,
  StatsOutputSchema,
  StatsResultStatusSchema,
  statsResultStatuses,
  VarianceTechniquesSchema,
  WinsorizeCapSchema,
} from "../stats-result-contract";
