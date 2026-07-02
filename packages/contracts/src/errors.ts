import { z } from "zod";

/**
 * Canonical error contract. One base shape, discriminated on `code`, parsed by
 * every surface (Worker, hc client, CLI, MCP tool). See
 * docs/spec/contracts/error-responses.md — that document is the source of truth;
 * this file is its executable form.
 */

export const errorCodes = [
  // Validation
  "VALIDATION_ERROR",
  "ALLOCATION_INVALID",
  "ACTIVATION_TIMESTAMP_INVALID",
  "INVALID_PAGINATION",
  "INVALID_SORT",

  // Run / Experiment invariants
  "RUN_FROZEN",
  "DECISION_LOCKED",
  "TARGETING_KEY_MISMATCH",
  "RUN_NOT_RUNNING",
  "EXPERIMENT_RUNNING",
  "EXPERIMENT_NO_DRAFT",
  "VARIANT_NOT_AVAILABLE",
  "RESOURCE_NOT_EMPTY",

  // Not found
  "EXPERIMENT_NOT_FOUND",
  "RUN_NOT_FOUND",
  "FLAG_NOT_FOUND",
  "VARIANT_NOT_FOUND",
  "METRIC_NOT_FOUND",
  "APP_NOT_FOUND",
  "ORGANIZATION_NOT_FOUND",
  "USER_NOT_FOUND",
  "CREDENTIAL_NOT_FOUND",
  "SEGMENT_NOT_FOUND",
  "PRIVACY_JOB_NOT_FOUND",

  // Auth / authz
  "UNAUTHORIZED",
  "CREDENTIAL_REVOKED",
  "INSUFFICIENT_SCOPES",
  "FORBIDDEN",
  "ORIGIN_NOT_ALLOWED",
  "APP_MISMATCH",
  "LAST_OWNER_REQUIRED",
  "LAST_ENVIRONMENT_REQUIRED",
  "PRIVACY_CONFIRMATION_REQUIRED",
  "CONFIRMATION_REQUIRED",

  // Analysis-state signals
  "MULTIPLE_VARIANT_CONFLICT",

  // System
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "PRIVACY_JOB_FAILED",
  "INTERNAL_SERVER_ERROR",
] as const;

export const ErrorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Machine-stable recovery guidance carried in `details` on operational 409s. An
 * agent branches on the token, never on prose. Stable across message wording and
 * localization.
 */
export const recommendedActions = [
  "CREATE_NEW_RUN",
  "END_RUNNING_RUN_FIRST",
  "START_A_RUN",
  "EDIT_DRAFT_THEN_START",
  "ADD_VARIANT_TO_ENV",
  "RETRY_AFTER",
  "RETRY_WITH_CONFIRMATION",
] as const;

export const RecommendedActionSchema = z.enum(recommendedActions);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Environment-Policy change types (ADR-0029). Names which gate tripped a
 * CONFIRMATION_REQUIRED so the caller need not re-read the Policy.
 */
export const policyChangeTypes = [
  "variant_availability",
  "targeting_rollout_value",
  "enabled_state",
  "start_experiment_run",
] as const;

export const PolicyChangeTypeSchema = z.enum(policyChangeTypes);
export type PolicyChangeType = z.infer<typeof PolicyChangeTypeSchema>;

const EmptyDetails = z.object({}).strict();

const ValidationIssue = z.object({
  path: z.array(z.string()),
  message: z.string(),
});

/**
 * One member per ErrorCode. `details` is always present; codes with no structured
 * detail carry `{}`. Members are assembled into a discriminated union below so
 * TypeScript narrows `details` from `code` with no cast.
 */
const errorMembers = [
  member("VALIDATION_ERROR", z.object({ issues: z.array(ValidationIssue) })),
  member(
    "ALLOCATION_INVALID",
    z.object({
      expected: z.literal(100),
      got: z.number(),
      variantAllocations: z.record(z.string(), z.number()),
    }),
  ),
  member(
    "ACTIVATION_TIMESTAMP_INVALID",
    z.object({
      activationTs: z.string(),
      firstExposureTs: z.string(),
      message: z.literal("activation must occur after first exposure"),
    }),
  ),
  member(
    "INVALID_PAGINATION",
    z.object({ field: z.enum(["cursor", "limit"]), reason: z.string() }),
  ),
  member("INVALID_SORT", z.object({ field: z.string(), allowedFields: z.array(z.string()) })),

  member(
    "RUN_FROZEN",
    z.object({
      frozenFields: z.array(z.string()),
      currentRunId: z.string(),
      attemptedChange: z.string(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "DECISION_LOCKED",
    z.object({
      lockedFields: z.array(z.string()),
      currentRunId: z.string(),
      attemptedChange: z.string(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "TARGETING_KEY_MISMATCH",
    z.object({
      currentTargetingKey: z.string(),
      attemptedTargetingKey: z.string(),
      experimentId: z.string(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "RUN_NOT_RUNNING",
    z.object({
      runId: z.string(),
      currentState: z.enum(["draft", "ended"]),
      attemptedOp: z.string(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "EXPERIMENT_RUNNING",
    z.object({
      experimentId: z.string(),
      runningRunId: z.string(),
      attemptedOp: z.string(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "EXPERIMENT_NO_DRAFT",
    z.object({
      experimentId: z.string(),
      currentRunId: z.string().nullable(),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "VARIANT_NOT_AVAILABLE",
    z.object({
      flagId: z.string(),
      environmentId: z.string(),
      missingVariants: z.array(z.string()),
      recommendedAction: RecommendedActionSchema,
    }),
  ),
  member(
    "RESOURCE_NOT_EMPTY",
    z.object({
      resourceType: z.enum(["app", "environment"]),
      resourceId: z.string(),
      childType: z.string(),
      childCount: z.number(),
      attemptedOp: z.string(),
    }),
  ),

  member("EXPERIMENT_NOT_FOUND", EmptyDetails),
  member("RUN_NOT_FOUND", EmptyDetails),
  member("FLAG_NOT_FOUND", EmptyDetails),
  member("VARIANT_NOT_FOUND", EmptyDetails),
  member("METRIC_NOT_FOUND", EmptyDetails),
  member("APP_NOT_FOUND", EmptyDetails),
  member("ORGANIZATION_NOT_FOUND", EmptyDetails),
  member("USER_NOT_FOUND", EmptyDetails),
  member("CREDENTIAL_NOT_FOUND", EmptyDetails),
  member("SEGMENT_NOT_FOUND", EmptyDetails),
  member("PRIVACY_JOB_NOT_FOUND", EmptyDetails),

  member("UNAUTHORIZED", EmptyDetails),
  member("CREDENTIAL_REVOKED", EmptyDetails),
  member(
    "INSUFFICIENT_SCOPES",
    z.object({ requiredScopes: z.array(z.string()), heldScopes: z.array(z.string()) }),
  ),
  member("FORBIDDEN", EmptyDetails),
  member("ORIGIN_NOT_ALLOWED", z.object({ origin: z.string(), hint: z.string() })),
  member("APP_MISMATCH", EmptyDetails),
  member("LAST_OWNER_REQUIRED", z.object({ orgId: z.string() })),
  member("LAST_ENVIRONMENT_REQUIRED", z.object({ appId: z.string() })),
  member(
    "PRIVACY_CONFIRMATION_REQUIRED",
    z.object({ confirmationRequired: z.literal(true), confirmationExpiresAt: z.string() }),
  ),
  member(
    "CONFIRMATION_REQUIRED",
    z.object({
      gate: PolicyChangeTypeSchema,
      environmentId: z.string(),
      attemptedOp: z.string(),
      recommendedAction: z.literal("RETRY_WITH_CONFIRMATION"),
    }),
  ),

  member(
    "MULTIPLE_VARIANT_CONFLICT",
    z.object({
      experimentId: z.string(),
      runId: z.string(),
      idType: z.string(),
      targetingKeyHash: z.string(),
    }),
  ),

  member("RATE_LIMITED", z.object({ retryAfterMs: z.number() })),
  member("SERVICE_UNAVAILABLE", z.object({ retryAfterMs: z.number() })),
  member(
    "PRIVACY_JOB_FAILED",
    z.object({ requestId: z.string(), failedStores: z.array(z.string()) }),
  ),
  member("INTERNAL_SERVER_ERROR", EmptyDetails),
] as const;

export const ErrorResponseSchema = z.discriminatedUnion("code", errorMembers);
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}
