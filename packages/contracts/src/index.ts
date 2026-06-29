import { z } from "zod";

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

export const platformTargets = ["local", "pr-ci", "shared-preview", "production"] as const;

export const PlatformTargetSchema = z.enum(platformTargets);
export type PlatformTarget = z.infer<typeof PlatformTargetSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  platformTarget: PlatformTargetSchema,
  service: z.string().min(1),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function parsePlatformTarget(value: string | undefined): PlatformTarget {
  const parsed = PlatformTargetSchema.safeParse(value);
  return parsed.success ? parsed.data : "local";
}

export function createHealthResponse(
  service: string,
  platformTarget: PlatformTarget = "local",
): HealthResponse {
  return HealthResponseSchema.parse({
    ok: true,
    platformTarget,
    service,
  });
}

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
