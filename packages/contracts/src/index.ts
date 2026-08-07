// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the contracts surface is intentionally aggregated here
export { accessTokenRevocationKey, accessTokenRevocationTtl } from "./access-token-revocation";
export type { ApprovalRequestId, ApprovalReviewId } from "./approval-identifiers";
export { ApprovalRequestIdSchema, ApprovalReviewIdSchema } from "./approval-identifiers";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the grouped CLI/MCP parity-skin API
export * from "./barrels/parity-skins";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the grouped route registry API
export * from "./barrels/route-registry";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the grouped stats input/result API
export * from "./barrels/stats-contracts";
// biome-ignore lint/performance/noReExportAll: curated wire envelopes live in barrels/wire-envelopes.ts
export * from "./barrels/wire-envelopes";
export { type CanonicalJsonSha256, CanonicalJsonSha256Schema } from "./canonical-hash";
export {
  ClientOriginSchema,
  NormalizedOriginAllowlistSchema,
  normalizeClientOrigins,
  OriginAllowlistSchema,
} from "./client-origin";
export { CONTROL_PANEL_DELEGATION_HEADER, PANEL_API_KEY_SCOPES } from "./control-panel-binding";
export type { DeltaNudge, DeltaNudgeEntity } from "./delta-nudge";
export { DeltaNudgeEntitySchema, DeltaNudgeSchema, deltaNudgeEntities } from "./delta-nudge";
export { errorStatusByCode, httpStatusForError } from "./error-status";
export type { ErrorCode, ErrorResponse, PolicyChangeType, RecommendedAction } from "./errors";
export {
  ErrorCodeSchema,
  ErrorDetailsSchema,
  ErrorResponseSchema,
  errorCodes,
  PolicyChangeTypeSchema,
  policyChangeTypes,
  RecommendedActionSchema,
  recommendedActions,
} from "./errors";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the grouped rigor API
export * from "./experiment-rigor";
export type { HealthResponse, PlatformTarget } from "./health-response";
export {
  createHealthResponse,
  FullCommitShaSchema,
  HealthResponseSchema,
  PlatformTargetSchema,
  parsePlatformTarget,
  platformTargets,
} from "./health-response";
export type {
  Experiment,
  ExperimentStatus,
  Metric,
  MetricKind,
  MetricRef,
  Run,
  RunStatus,
} from "./leaf-schemas-experiment";
export {
  ExperimentSchema,
  ExperimentStatusSchema,
  experimentStatuses,
  MetricKindSchema,
  MetricRefSchema,
  MetricSchema,
  metricKinds,
  RunSchema,
  RunStatusSchema,
  runStatuses,
} from "./leaf-schemas-experiment";
export type {
  Condition,
  ConditionOperator,
  Flag,
  PercentageRollout,
  Segment,
  TargetingRule,
  Variant,
} from "./leaf-schemas-flag";
export {
  ConditionOperatorSchema,
  ConditionSchema,
  conditionOperators,
  FlagSchema,
  PercentageRolloutSchema,
  SegmentSchema,
  TargetingRuleSchema,
  VariantSchema,
} from "./leaf-schemas-flag";
export type {
  APIKey,
  App,
  ApprovalPolicyLevel,
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
} from "./leaf-schemas-runtime";
export {
  APIKeySchema,
  ApprovalPolicyLevelSchema,
  AppSchema,
  approvalPolicyLevels,
  ClientKeySchema,
  EnvironmentPolicyLevelSchema,
  EnvironmentPolicySchema,
  EnvironmentSchema,
  EvaluationContextSchema,
  ExposureEventSchema,
  ExposureTypeSchema,
  environmentPolicyLevels,
  exposureTypes,
  OrganizationSchema,
  OrgPlanSchema,
  orgPlans,
  ResolutionDetailsSchema,
  ResolutionReasonSchema,
  reservedEnvironmentPolicyLevels,
  resolutionReasons,
  UserRoleSchema,
  UserSchema,
  userRoles,
  VariantValueSchema,
} from "./leaf-schemas-runtime";
export type {
  LiveUpdateAuthorizationContext,
  LiveUpdateConnectionContext,
  ServerAuthenticatedLiveUpdateContext,
} from "./live-update-connection";
export {
  authorizesLiveUpdateConnection,
  LiveUpdateConnectionContextSchema,
  parseLiveUpdateConnectionContext,
  ServerAuthenticatedLiveUpdateContextSchema,
} from "./live-update-connection";
export type { McpDelegationActor, McpDelegationReplayGuard } from "./mcp-delegation";
export {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  parseMcpDelegation,
} from "./mcp-delegation";
export type {
  McpToolOperationId,
  MembershipAxis,
  MembershipRole,
  RouteMembershipGate,
} from "./mcp-tool-membership-gates";
export {
  getRouteMembershipGate,
  membershipAxes,
  membershipGatePatterns,
  membershipRoles,
  scopeSatisfiesMembershipGate,
} from "./mcp-tool-membership-gates";
export { buildOpenApiDocument, type OpenApiDocumentInfo } from "./openapi-document";
export type { ApiRouteContract, ApiRouteRequest, DefineApiRouteInput } from "./openapi-route";
export { defineApiRoute } from "./openapi-route";
export { type ControlPlaneRpcApp, controlPlaneRpcApp } from "./openapi-rpc";
export {
  deriveOrganizationSlug,
  isReservedOrganizationSlug,
  OrganizationSlugSchema,
  RESERVED_ORGANIZATION_SLUGS,
} from "./organization-slug";
export type {
  AppOverviewResponse,
  OverviewDecisionExperiment,
  OverviewDecisionReason,
  OverviewExperiments,
  OverviewExperimentsUnavailableReason,
  OverviewFailingExperiment,
  OverviewFailureReason,
  OverviewFlagConfigChange,
} from "./panel-overview-contract";
export {
  AppOverviewResponseSchema,
  OverviewDecisionExperimentSchema,
  OverviewDecisionReasonSchema,
  OverviewExperimentsSchema,
  OverviewExperimentsUnavailableReasonSchema,
  OverviewFailingExperimentSchema,
  OverviewFailureReasonSchema,
  OverviewFlagConfigChangeSchema,
  overviewDecisionReasons,
  overviewExperimentsUnavailableReasons,
  overviewFailureReasons,
} from "./panel-overview-contract";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the shared delete-tree contract
export * from "./resource-delete-tree";
// biome-ignore lint/performance/noReExportAll: package entry point intentionally exposes the grouped resource envelope API
export * from "./resource-envelopes";
export {
  type ApprovalApplicationResult,
  ApprovalApplicationResultSchema,
  type ApprovalRequest,
  type ApprovalRequestListQuery,
  ApprovalRequestListQuerySchema,
  ApprovalRequestSchema,
  type ApprovalReview,
  type ApprovalReviewError,
  ApprovalReviewErrorSchema,
  ApprovalReviewSchema,
  InlineApproveAndApplyReviewSchema,
  type ReviewApprovalRequest,
  ReviewApprovalRequestSchema,
} from "./routes/route-shapes-approval-request";
export {
  type ApprovalActor,
  ApprovalActorSchema,
  type ApprovalAppliedResourceType,
  ApprovalAppliedResourceTypeSchema,
  type ApprovalDiff,
  type ApprovalDiffEntry,
  ApprovalDiffEntrySchema,
  ApprovalDiffSchema,
  type ApprovalOperation,
  ApprovalOperationSchema,
  type ApprovalPolicyContext,
  ApprovalPolicyContextSchema,
  type ApprovalRequestStatus,
  ApprovalRequestStatusSchema,
  type ApprovalReviewAction,
  ApprovalReviewActionSchema,
  type ApprovalReviewOutcome,
  ApprovalReviewOutcomeSchema,
  type ApprovalTarget,
  ApprovalTargetSchema,
  type ApprovalTargetType,
  ApprovalTargetTypeSchema,
  type ApprovalTargetVersion,
  ApprovalTargetVersionSchema,
  approvalAppliedResourceTypes,
  approvalOperations,
  approvalRequestStatuses,
  approvalReviewActions,
  approvalReviewOutcomes,
  approvalTargetTypes,
} from "./routes/route-shapes-approvals";
export { deriveSlug, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN, SlugSchema } from "./slug";
// `./experiment-rigor` exports a different DecisionFamilyMember; naming this one
// explicitly keeps the stats-input shape as the package's, as it was before the
// stats exports moved into a sub-barrel.
export type { DecisionFamilyMember } from "./stats-input-contract";
export {
  apiKeyCacheKey,
  assignmentKey,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  memberProfileCacheKey,
  runConfigKey,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "./storage-keys-kv";
export type {
  AssignmentStoreEntry,
  AssignmentStoreValue,
  CredentialCacheKV,
  CredentialKind,
  ExperimentConfigKV,
  FlagConfigKV,
  LiveRunKV,
  MemberProfileCache,
  RunConfigKV,
} from "./storage-schemas-kv";
export {
  AssignmentStoreEntrySchema,
  AssignmentStoreValueSchema,
  CredentialCacheKVSchema,
  CredentialCacheKVSchemaV1,
  CredentialKindSchema,
  CURRENT_KV_SCHEMA_VERSION,
  credentialKinds,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  kvEnvelope,
  LiveRunKVSchema,
  MemberProfileCacheSchema,
  RunConfigKVSchema,
  rememberMemberProfile,
} from "./storage-schemas-kv";
