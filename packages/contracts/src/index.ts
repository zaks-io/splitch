// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the contracts surface is intentionally aggregated here
export { errorStatusByCode, httpStatusForError } from "./error-status.js";
export {
  ErrorCodeSchema,
  errorCodes,
  ErrorResponseSchema,
  PolicyChangeTypeSchema,
  policyChangeTypes,
  RecommendedActionSchema,
  recommendedActions,
} from "./errors.js";
export type { ErrorCode, ErrorResponse, PolicyChangeType, RecommendedAction } from "./errors.js";
export {
  AuthKindSchema,
  authKinds,
  defineRoute,
  HttpMethodSchema,
  httpMethods,
  IdempotencyModeSchema,
  idempotencyModes,
  RateLimitClassSchema,
  rateLimitClasses,
  RouteOwnerSchema,
  routeOwners,
} from "./route-contract.js";
export type {
  AuthKind,
  HttpMethod,
  IdempotencyMode,
  RateLimitClass,
  RouteContract,
  RouteOwner,
} from "./route-contract.js";
export { defineApiRoute } from "./openapi-route.js";
export type { ApiRouteContract, ApiRouteRequest, DefineApiRouteInput } from "./openapi-route.js";
export { getRoute, operationIds, routeRegistry } from "./route-registry.js";
export { buildOpenApiDocument } from "./openapi-document.js";
export type { OpenApiDocumentInfo } from "./openapi-document.js";
export { deriveMcpTools, isMcpToolRoute } from "./mcp-tools.js";
export type { McpToolDefinition } from "./mcp-tools.js";
export { DeltaNudgeEntitySchema, deltaNudgeEntities, DeltaNudgeSchema } from "./delta-nudge.js";
export type { DeltaNudge, DeltaNudgeEntity } from "./delta-nudge.js";
export {
  createHealthResponse,
  HealthResponseSchema,
  parsePlatformTarget,
  PlatformTargetSchema,
  platformTargets,
} from "./health-response.js";
export type { HealthResponse, PlatformTarget } from "./health-response.js";

export {
  ExperimentSchema,
  ExperimentStatusSchema,
  experimentStatuses,
  MetricKindSchema,
  metricKinds,
  MetricRefSchema,
  MetricSchema,
  RunSchema,
  RunStatusSchema,
  runStatuses,
} from "./leaf-schemas-experiment.js";
export type {
  Experiment,
  ExperimentStatus,
  Metric,
  MetricKind,
  MetricRef,
  Run,
  RunStatus,
} from "./leaf-schemas-experiment.js";
export {
  ActivationRowSchema,
  CupedCovariateRowSchema,
  CupedCovariateSourceSchema,
  DecisionFamilyMemberSchema,
  DedupeExposureRowSchema,
  PerEntityMetricRowSchema,
  PrePeriodRowSchema,
  StatsInputSchema,
} from "./stats-input-contract.js";
export type {
  ActivationRow,
  CupedCovariateRow,
  CupedCovariateSource,
  DecisionFamilyMember,
  DedupeExposureRow,
  PerEntityMetricRow,
  PrePeriodRow,
  StatsInput,
} from "./stats-input-contract.js";
export {
  ArmResultSchema,
  CupedAttributeSourceSchema,
  cupedAttributeSources,
  CupedMethodSchema,
  cupedMethods,
  DimensionClassSchema,
  dimensionClasses,
  DimensionResultSchema,
  GuardrailResultSchema,
  HealthMetricsSchema,
  SrmResultSchema,
  StatsOutputSchema,
  StatsResultStatusSchema,
  statsResultStatuses,
  WinsorizeCapSchema,
  VarianceTechniquesSchema,
} from "./stats-result-contract.js";
export type {
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
  WinsorizeCap,
  VarianceTechniques,
} from "./stats-result-contract.js";
export {
  ConditionOperatorSchema,
  ConditionSchema,
  FlagSchema,
  PercentageRolloutSchema,
  SegmentSchema,
  TargetingRuleSchema,
  VariantSchema,
  conditionOperators,
} from "./leaf-schemas-flag.js";
export type {
  Condition,
  ConditionOperator,
  Flag,
  PercentageRollout,
  Segment,
  TargetingRule,
  Variant,
} from "./leaf-schemas-flag.js";
export {
  APIKeySchema,
  AppSchema,
  ClientKeySchema,
  EnvironmentPolicyLevelSchema,
  EnvironmentPolicySchema,
  environmentPolicyLevels,
  EnvironmentSchema,
  EvaluationContextSchema,
  ExposureEventSchema,
  ExposureTypeSchema,
  exposureTypes,
  OrganizationSchema,
  OrgPlanSchema,
  orgPlans,
  ResolutionDetailsSchema,
  ResolutionReasonSchema,
  resolutionReasons,
  UserRoleSchema,
  userRoles,
  UserSchema,
  VariantValueSchema,
} from "./leaf-schemas-runtime.js";
export type {
  APIKey,
  App,
  ClientKey,
  Environment,
  EnvironmentPolicy,
  EnvironmentPolicyLevel,
  EvaluationContext,
  ExposureEvent,
  ExposureType,
  Organization,
  OrgPlan,
  ResolutionDetails,
  ResolutionReason,
  User,
  UserRole,
  VariantValue,
} from "./leaf-schemas-runtime.js";
export {
  apiKeyCacheKey,
  assignmentKey,
  clientKeyCacheKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  runConfigKey,
} from "./storage-keys-kv.js";
export {
  AssignmentStoreEntrySchema,
  AssignmentStoreValueSchema,
  CredentialCacheKVSchema,
  CredentialKindSchema,
  credentialKinds,
  CURRENT_KV_SCHEMA_VERSION,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  kvEnvelope,
  LiveRunKVSchema,
  RunConfigKVSchema,
} from "./storage-schemas-kv.js";
export type {
  AssignmentStoreEntry,
  AssignmentStoreValue,
  CredentialCacheKV,
  CredentialKind,
  ExperimentConfigKV,
  FlagConfigKV,
  LiveRunKV,
  RunConfigKV,
} from "./storage-schemas-kv.js";
export {
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PaginationQuerySchema,
  PeekEvaluateResponseSchema,
  paginatedResponse,
  RuleSelectionSchema,
  TestEvaluationReasonSchema,
  TestEvaluationRequestSchema,
  TestEvaluationResponseSchema,
} from "./wire-envelopes-core.js";
export type {
  DataPlaneEvaluateRequest,
  DataPlaneEvaluateResponse,
  PaginationQuery,
  PeekEvaluateResponse,
  RuleSelection,
  TestEvaluationReason,
  TestEvaluationRequest,
  TestEvaluationResponse,
} from "./wire-envelopes-core.js";
export {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
} from "./resource-envelopes-flag.js";
export type {
  CreateFlagRequest,
  CreateVariantRequest,
  FlagResponse,
  PatchFlagRequest,
  PatchVariantRequest,
} from "./resource-envelopes-flag.js";
export {
  CreateExperimentRequestSchema,
  ExperimentResponseSchema,
  PatchExperimentRequestSchema,
  PatchRunRequestSchema,
  RunResponseSchema,
  StartRunRequestSchema,
} from "./resource-envelopes-experiment.js";
export type {
  CreateExperimentRequest,
  ExperimentResponse,
  PatchExperimentRequest,
  PatchRunRequest,
  RunResponse,
  StartRunRequest,
} from "./resource-envelopes-experiment.js";
export {
  AppResponseSchema,
  CreateAppRequestSchema,
  CreateAppResponseSchema,
  CreateCredentialResponseSchema,
  CreateMetricRequestSchema,
  CredentialSchema,
  ListCredentialsResponseSchema,
  MetricResponseSchema,
  OrganizationResponseSchema,
  PatchAppRequestSchema,
  PatchMetricRequestSchema,
  PatchOrganizationRequestSchema,
} from "./resource-envelopes-account.js";
export type {
  AppResponse,
  CreateAppRequest,
  CreateAppResponse,
  CreateCredentialResponse,
  CreateMetricRequest,
  Credential,
  ListCredentialsResponse,
  MetricResponse,
  OrganizationResponse,
  PatchAppRequest,
  PatchMetricRequest,
  PatchOrganizationRequest,
} from "./resource-envelopes-account.js";
