import { z } from "@hono/zod-openapi";
import { OriginAllowlistSchema } from "../client-origin";
import {
  ConditionSchema,
  PercentageRolloutSchema,
  TargetingRuleSchema,
} from "../leaf-schemas-flag";
import { PolicyChangeTypeSchema } from "../errors";
import { EnvironmentPolicySchema, UserRoleSchema } from "../leaf-schemas-runtime";
import { AuthDoorSchema } from "../route-contract";

/**
 * Path-param and route-local request/response shapes that have NO dedicated
 * resource envelope (members, environments, flag-config, promotion, privacy,
 * audit), composed from existing leaves — never redefining a domain leaf. Each
 * is kept tiny and single-purpose so the per-domain route files stay declarative.
 *
 * Param schemas carry `.openapi()` examples so the generated document and MCP
 * tool inputs read well; the runtime guard only cares that the value is a string.
 */

// ---------------------------------------------------------------------------
// Reusable path params (camelCase to match the Hono `:appId` co-scope params
// the worker-runtime guard reads — see worker-runtime/steps/scopes.ts).
// ---------------------------------------------------------------------------

export const OrgParams = z.object({ orgId: z.string() });
export const OrgMemberParams = z.object({ orgId: z.string(), userId: z.string() });
export const AppParams = z.object({ appId: z.string() });
export const OrgAppsParams = z.object({ orgId: z.string() });
export const EnvParams = z.object({ appId: z.string(), environmentId: z.string() });
export const FlagParams = z.object({ appId: z.string(), flagId: z.string() });
export const FlagVariantParams = z.object({
  appId: z.string(),
  flagId: z.string(),
  variantName: z.string(),
});
export const EnvFlagParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  flagId: z.string(),
});
export const SegmentParams = z.object({ appId: z.string(), segmentId: z.string() });
export const MetricParams = z.object({ appId: z.string(), metricId: z.string() });
export const ExperimentParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  experimentId: z.string(),
});
export const RunParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  experimentId: z.string(),
  runId: z.string(),
});
export const RunEndParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  runId: z.string(),
});
export const ApiKeyParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  keyId: z.string(),
});
export const PromoteParams = z.object({
  appId: z.string(),
  targetEnvironmentId: z.string(),
  flagId: z.string(),
});
export const PrivacyRequestParams = z.object({ requestId: z.string() });

// ---------------------------------------------------------------------------
// Approval Request + Review.
//
// Final-state schemas for the AFK implementation slice. Every Policy-controlled
// mutation must compose these shapes. Inline Review is only the short form of
// the same approve-and-apply action used by the Review endpoint.
// ---------------------------------------------------------------------------

export const approvalRequestStatuses = ["pending", "applied", "declined", "stale"] as const;
export const ApprovalRequestStatusSchema = z.enum(approvalRequestStatuses);

export const approvalReviewActions = ["approve_and_apply", "decline"] as const;
export const ApprovalReviewActionSchema = z.enum(approvalReviewActions);

export const approvalReviewOutcomes = ["applied", "declined", "stale", "failed"] as const;
export const ApprovalReviewOutcomeSchema = z.enum(approvalReviewOutcomes);

export const approvalTargetTypes = [
  "flag_configuration",
  "flag_variant",
  "experiment_draft",
] as const;
export const ApprovalTargetTypeSchema = z.enum(approvalTargetTypes);

export const approvalAppliedResourceTypes = [
  "flag_configuration",
  "flag_variant",
  "experiment_run",
] as const;
export const ApprovalAppliedResourceTypeSchema = z.enum(approvalAppliedResourceTypes);

export const approvalOperations = [
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flags_promote",
  "flag_variants_update",
  "experiments_start",
] as const;
export const ApprovalOperationSchema = z.enum(approvalOperations);

export const ApprovalActorSchema = z
  .object({
    userId: z.string(),
    authDoor: AuthDoorSchema,
  })
  .strict();

export const ApprovalPolicyContextSchema = z
  .object({
    environmentId: z.string(),
    changeTypes: z.array(PolicyChangeTypeSchema).min(1),
    level: z.enum(["allow", "confirm", "approve"]),
  })
  .strict();

export const ApprovalTargetSchema = z
  .object({
    type: ApprovalTargetTypeSchema,
    id: z.string(),
    version: z.string(),
  })
  .strict();

export const ApprovalDiffEntrySchema = z
  .discriminatedUnion("operation", [
    z.object({ path: z.string(), operation: z.literal("add"), proposed: z.unknown() }).strict(),
    z.object({ path: z.string(), operation: z.literal("remove"), current: z.unknown() }).strict(),
    z
      .object({
        path: z.string(),
        operation: z.literal("replace"),
        current: z.unknown(),
        proposed: z.unknown(),
      })
      .strict(),
  ])
  .superRefine((entry, context) => {
    const requiredFields =
      entry.operation === "add"
        ? ["proposed"]
        : entry.operation === "remove"
          ? ["current"]
          : ["current", "proposed"];
    for (const field of requiredFields) {
      if (!Object.hasOwn(entry, field)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${entry.operation} diff entry requires ${field}`,
        });
      }
    }
  });

export const ApprovalDiffSchema = z
  .object({
    current: z.record(z.string(), z.unknown()),
    proposed: z.record(z.string(), z.unknown()),
    entries: z.array(ApprovalDiffEntrySchema).min(1),
  })
  .strict()
  .superRefine((diff, context) => {
    for (let index = 1; index < diff.entries.length; index += 1) {
      const previousPath = diff.entries[index - 1]?.path;
      const path = diff.entries[index]?.path;
      if (previousPath !== undefined && path !== undefined && previousPath >= path) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "diff entry paths must be unique and sorted",
        });
      }
    }
  });

export const InlineApproveAndApplyReviewSchema = z
  .object({ action: z.literal("approve_and_apply") })
  .strict();

export const ApprovalApplicationResultSchema = z
  .object({
    targetVersion: z.string(),
    resourceType: ApprovalAppliedResourceTypeSchema,
    resourceId: z.string(),
    appliedAt: z.string(),
  })
  .strict();

export const ApprovalReviewErrorSchema = z
  .object({
    code: z.string(),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ApprovalReviewSchema = z
  .object({
    id: z.string(),
    approvalRequestId: z.string(),
    action: ApprovalReviewActionSchema,
    outcome: ApprovalReviewOutcomeSchema,
    actor: ApprovalActorSchema,
    reviewedAt: z.string(),
    reason: z.string().nullable(),
    idempotencyKey: z.string().min(1),
    resultingTargetVersion: z.string().nullable(),
    error: ApprovalReviewErrorSchema.nullable(),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      (review.action === "decline" && review.outcome !== "declined") ||
      (review.action === "approve_and_apply" && review.outcome === "declined")
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: `${review.action} cannot produce ${review.outcome}`,
      });
    }
  })
  .superRefine((review, context) => {
    const hasResultingVersion = review.resultingTargetVersion !== null;
    if (hasResultingVersion !== (review.outcome === "applied")) {
      context.addIssue({
        code: "custom",
        path: ["resultingTargetVersion"],
        message: "applied Review alone requires resultingTargetVersion",
      });
    }
  })
  .superRefine((review, context) => {
    const hasError = review.error !== null;
    if (hasError !== (review.outcome === "failed")) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "only a failed Review requires an error",
      });
    }
  });

export const ApprovalRequestSchema = z
  .object({
    id: z.string(),
    appId: z.string(),
    policyContexts: z.array(ApprovalPolicyContextSchema).min(1),
    operation: ApprovalOperationSchema,
    target: ApprovalTargetSchema,
    diff: ApprovalDiffSchema,
    status: ApprovalRequestStatusSchema,
    proposer: ApprovalActorSchema,
    proposedAt: z.string(),
    resolvedAt: z.string().nullable(),
    applicationResult: ApprovalApplicationResultSchema.nullable(),
    latestReview: ApprovalReviewSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    const isApplied = request.status === "applied";
    if ((request.applicationResult !== null) !== isApplied) {
      context.addIssue({
        code: "custom",
        path: ["applicationResult"],
        message: "applicationResult is present only for an applied Approval Request",
      });
    }
  })
  .superRefine((request, context) => {
    const isPending = request.status === "pending";
    if ((request.resolvedAt === null) !== isPending) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "resolvedAt is null only while the Approval Request is pending",
      });
    }
  })
  .superRefine((request, context) => {
    if (request.status === "pending") {
      return;
    }
    if (request.latestReview?.outcome !== request.status) {
      context.addIssue({
        code: "custom",
        path: ["latestReview"],
        message: `${request.status} Approval Request requires a matching latest Review`,
      });
    }
  })
  .superRefine((request, context) => {
    if (request.latestReview !== null && request.latestReview.approvalRequestId !== request.id) {
      context.addIssue({
        code: "custom",
        path: ["latestReview", "approvalRequestId"],
        message: "latest Review must belong to this Approval Request",
      });
    }
  })
  .superRefine((request, context) => {
    if (
      request.applicationResult !== null &&
      request.latestReview?.resultingTargetVersion !== request.applicationResult.targetVersion
    ) {
      context.addIssue({
        code: "custom",
        path: ["applicationResult", "targetVersion"],
        message: "application result and latest Review target versions must match",
      });
    }
  });

export const ReviewApprovalRequestSchema = z
  .object({
    action: ApprovalReviewActionSchema,
    reason: z.string().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;
export type ApprovalReviewAction = z.infer<typeof ApprovalReviewActionSchema>;
export type ApprovalReviewOutcome = z.infer<typeof ApprovalReviewOutcomeSchema>;
export type ApprovalTargetType = z.infer<typeof ApprovalTargetTypeSchema>;
export type ApprovalAppliedResourceType = z.infer<typeof ApprovalAppliedResourceTypeSchema>;
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;
export type ApprovalActor = z.infer<typeof ApprovalActorSchema>;
export type ApprovalPolicyContext = z.infer<typeof ApprovalPolicyContextSchema>;
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ApprovalDiffEntry = z.infer<typeof ApprovalDiffEntrySchema>;
export type ApprovalDiff = z.infer<typeof ApprovalDiffSchema>;
export type ApprovalApplicationResult = z.infer<typeof ApprovalApplicationResultSchema>;
export type ApprovalReviewError = z.infer<typeof ApprovalReviewErrorSchema>;
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ReviewApprovalRequest = z.infer<typeof ReviewApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Environment Policy (ADR-0029) — per-change-type allow/confirm map, inline on
// environments_get / environments_update (no separate policy endpoint).
// ---------------------------------------------------------------------------

export const CreateEnvironmentRequestSchema = z.object({
  key: z.string(),
  name: z.string().optional(),
  policy: EnvironmentPolicySchema.optional(),
});

export const PatchEnvironmentRequestSchema = z
  .object({
    name: z.string().optional(),
    policy: EnvironmentPolicySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Organization membership (no dedicated envelope).
// ---------------------------------------------------------------------------

export const AddMemberRequestSchema = z.object({
  userId: z.string(),
  role: UserRoleSchema,
});

export const UpdateMemberRequestSchema = z.object({ role: UserRoleSchema }).strict();

// ---------------------------------------------------------------------------
// Flag Configuration (per-Environment) — config read/patch + targeting replace.
// ---------------------------------------------------------------------------

export const FlagConfigResponseSchema = z.object({
  flagId: z.string(),
  environmentId: z.string(),
  version: z.number().int().min(0),
  enabled: z.boolean(),
  availableVariantNames: z.array(z.string()),
  targetingRules: z.array(TargetingRuleSchema),
  // Baseline rollout for traffic that matches no Targeting Rule; null = none.
  rollout: PercentageRolloutSchema.nullable(),
  // The Experiment controlling this Flag in this Environment, or null when none
  // does. NULLABLE-NOT-ABSENT, mirroring FlagConfigKV.experimentId: a reader must
  // be told "no Experiment controls this" rather than infer it from a missing key.
  // Resolved inside this same read from the Experiment row the snapshot already
  // loaded, so a consumer rendering the lock affordance never issues a second
  // lookup that could disagree with the configuration it is locking.
  experiment: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
});

export const PatchFlagConfigRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    availableVariantNames: z.array(z.string()).optional(),
    // Percentage only, never a salt: the salt is minted server-side on the first
    // write that sets a non-null rollout and is never regenerated, so bucket
    // membership cannot silently reshuffle under a percentage change (ADR-0036).
    // `null` clears the baseline; a later re-establish mints a fresh salt.
    rollout: z
      .object({ percentage: z.number().min(0).max(100) })
      .strict()
      .nullable()
      .optional(),
    // Gated change types require an explicit confirm under the Env Policy.
    confirm: z.boolean().optional(),
  })
  .strict();

export const ReplaceTargetingRulesRequestSchema = z.object({
  targetingRules: z.array(TargetingRuleSchema),
  confirm: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Promotion (ADR-0028) — explicit ticked field-groups; absence = leave untouched.
// ---------------------------------------------------------------------------

export const PromoteRequestSchema = z.object({
  fromEnvironmentId: z.string(),
  select: z
    .object({
      availability: z.array(z.string()).optional(),
      targeting: z.literal(true).optional(),
      rollout: z.literal(true).optional(),
      enabled: z.literal(true).optional(),
    })
    .strict(),
  confirm: z.boolean().optional(),
});

export const PromoteResponseSchema = z.object({
  config: FlagConfigResponseSchema,
  diff: z.object({ before: FlagConfigResponseSchema, after: FlagConfigResponseSchema }),
});

// ---------------------------------------------------------------------------
// Segments (no create/patch envelope; compose from the Condition leaf).
// ---------------------------------------------------------------------------

export const CreateSegmentRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  conditions: z.array(ConditionSchema),
  idempotency_key: z.string().optional(),
});

export const PatchSegmentRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    conditions: z.array(ConditionSchema).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// SDK credentials — client-key patch + api-key create/revoke bodies.
// ---------------------------------------------------------------------------

export const PatchClientKeyRequestSchema = z
  .object({
    originAllowlist: OriginAllowlistSchema.nullable().optional(),
    rateLimitRps: z.number().optional(),
  })
  .strict();

export const CreateApiKeyRequestSchema = z.object({
  scopes: z.array(z.string()),
  idempotency_key: z.string().optional(),
});

export const RevokeApiKeyRequestSchema = z.object({}).strict();

export const ClientKeyRotateResponseSchema = z.object({
  newKey: z.object({ keyId: z.string(), keyMaterial: z.string() }),
  revokedKeyId: z.string(),
});

export const ApiKeyRevokeResponseSchema = z.object({
  keyId: z.string(),
  revokedAt: z.string(),
});
