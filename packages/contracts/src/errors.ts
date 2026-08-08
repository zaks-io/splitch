import { z } from "zod";
import { ApprovalRequestIdSchema, ApprovalReviewIdSchema } from "./approval-identifiers";
import { CanonicalJsonSha256Schema } from "./canonical-hash";
import { type ErrorCode, ErrorCodeSchema, errorCodes } from "./error-code";
import { conflictErrorMembers } from "./error-members-conflict";
import { ApprovalPolicyLevelSchema } from "./leaf-schemas-runtime";
import { ResourceDeleteBlockerSchema } from "./resource-delete-tree";

/**
 * Canonical error contract. One base shape, discriminated on `code`, parsed by
 * every surface (Worker, hc client, CLI, MCP tool). See
 * docs/spec/contracts/error-responses.md — that document is the source of truth;
 * this file is its executable form.
 */

export type { ErrorCode };
export { ErrorCodeSchema, errorCodes };

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
  "REVIEW_APPROVAL_REQUEST",
  "REFRESH_AND_REPROPOSE",
  "RETRY_REVIEW",
  "CHOOSE_DIFFERENT_SLUG",
  "CHOOSE_DIFFERENT_KEY",
  "READ_PER_ENVIRONMENT",
] as const;

export const RecommendedActionSchema = z.enum(recommendedActions);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Environment-Policy change types (ADR-0029). Approval errors carry these so
 * the caller can render the immutable Policy context without guessing.
 */
export const policyChangeTypes = [
  "variant_availability",
  "targeting_rollout_value",
  "enabled_state",
  "start_experiment_run",
] as const;

export const PolicyChangeTypeSchema = z.enum(policyChangeTypes);
export type PolicyChangeType = z.infer<typeof PolicyChangeTypeSchema>;

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonScalarArraySchema = z.array(JsonScalarSchema);
const FlatJsonObjectSchema = z.record(
  z.string(),
  z.union([JsonScalarSchema, JsonScalarArraySchema]),
);

export const ErrorDetailsSchema = z.record(
  z.string(),
  z.union([
    JsonScalarSchema,
    JsonScalarArraySchema,
    FlatJsonObjectSchema,
    z.array(FlatJsonObjectSchema),
  ]),
);

const ApprovalPolicyContextDetailsSchema = z
  .object({
    environmentId: z.string(),
    changeTypes: z.array(PolicyChangeTypeSchema).min(1),
    level: ApprovalPolicyLevelSchema,
  })
  .strict();

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
  member("EXPOSURE_TICKET_INVALID", z.object({ exposureId: z.string() })),
  member("EXPOSURE_TICKET_EXPIRED", z.object({ exposureId: z.string(), issuedAt: z.string() })),

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
      resourceType: z.enum(["app", "environment", "flag", "variant", "organization"]),
      resourceId: z.string(),
      /**
       * First blocker group's CLI child type (back-compat summary). Prefer
       * `blockers` for the full tree with child IDs and remove commands.
       */
      childType: z.string(),
      childCount: z.number(),
      attemptedOp: z.string(),
      /**
       * Every current blocker group, each child named by ID and by the CLI
       * command that removes it. Absent only on legacy flag/variant emptiness
       * guards that still report a single count (those paths have no cascade
       * tree yet).
       */
      blockers: z.array(ResourceDeleteBlockerSchema).min(1).optional(),
    }),
  ),

  ...conflictErrorMembers,

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
  member("APPROVAL_REQUEST_NOT_FOUND", EmptyDetails),

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
    "APPROVAL_REVIEW_FORBIDDEN",
    z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      action: z.enum(["approve_and_apply", "decline"]),
      reason: z.enum(["SELF_REVIEW_NOT_ALLOWED", "ROLE_NOT_ALLOWED"]),
    }),
  ),
  member(
    "APPROVAL_REVIEW_REQUIRED",
    z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      status: z.literal("pending"),
      policyContexts: z.array(ApprovalPolicyContextDetailsSchema).min(1),
      recommendedAction: z.literal("REVIEW_APPROVAL_REQUEST"),
    }),
  ),
  member(
    "APPROVAL_REQUEST_STALE",
    z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      targetVersion: CanonicalJsonSha256Schema,
      currentTargetVersion: CanonicalJsonSha256Schema,
      recommendedAction: z.literal("REFRESH_AND_REPROPOSE"),
    }),
  ),
  member(
    "APPROVAL_REQUEST_RESOLVED",
    z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      status: z.enum(["applied", "declined", "stale"]),
      reviewId: ApprovalReviewIdSchema.nullable(),
    }),
  ),
  member(
    "APPROVAL_APPLICATION_FAILED",
    z.object({
      approvalRequestId: ApprovalRequestIdSchema,
      reviewId: ApprovalReviewIdSchema,
      applicationError: z.object({
        code: ErrorCodeSchema,
        details: ErrorDetailsSchema,
      }),
      recommendedAction: z.literal("RETRY_REVIEW"),
    }),
  ),
  member(
    "IDEMPOTENCY_KEY_CONFLICT",
    z.object({
      scope: z.enum(["approval_request", "review"]),
      idempotencyKey: z.string().min(1),
    }),
  ),
  member("EVENT_ID_CONFLICT", z.object({ eventId: z.string() })),

  member(
    "MULTIPLE_VARIANT_CONFLICT",
    z.object({
      experimentId: z.string(),
      runId: z.string(),
      idType: z.string(),
      targetingKeyHash: z.string(),
    }),
  ),
  member(
    "ATTENTION_FANOUT_LIMIT_EXCEEDED",
    z.object({
      appId: z.string(),
      limit: z.number().int(),
      environments: z.number().int(),
      // null when the Environment count alone was over budget, so no plan ran.
      runningExperiments: z.number().int().nullable(),
      recommendedAction: z.literal("READ_PER_ENVIRONMENT"),
    }),
  ),

  member("RATE_LIMITED", z.object({ retryAfterMs: z.number() })),
  member("SERVICE_UNAVAILABLE", z.object({ retryAfterMs: z.number() })),
  member(
    "PRIVACY_JOB_FAILED",
    z.object({ requestId: z.string(), failedStores: z.array(z.string()) }),
  ),
  // Optional `fault` lets a 5xx name the broken seam without inventing a
  // recommendedAction token. `{}` remains valid for call sites that only have a
  // message (see flag-definition-errors).
  member("INTERNAL_SERVER_ERROR", z.object({ fault: z.string().optional() }).strict()),
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
