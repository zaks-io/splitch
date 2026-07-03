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
export { estimateMetricArm, estimateMetricComparison } from "./variance-estimators.js";
export type {
  ActivationRow,
  ArmResult,
  DecisionFamilyMember,
  DedupeExposureRow,
  GuardrailResult,
  PerEntityMetricRow,
  PrePeriodRow,
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
  MetricArmEstimate,
  MetricArmEstimateInput,
  MetricComparisonEstimate,
  MetricComparisonEstimateInput,
  MetricVarianceStatus,
} from "./variance-estimator-types.js";
