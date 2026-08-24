import { z } from "@hono/zod-openapi";
import { ApiKeyScopeSchema } from "../api-key-scopes";
import { ApprovalRequestIdSchema } from "../approval-identifiers";
import { OriginAllowlistSchema } from "../client-origin";
import {
  ConditionSchema,
  PercentageRolloutSchema,
  TargetingRuleSchema,
} from "../leaf-schemas-flag";
import { EnvironmentPolicySchema, UserRoleSchema } from "../leaf-schemas-runtime";
import {
  ApprovalRequestSchema,
  InlineApproveAndApplyReviewSchema,
} from "./route-shapes-approval-request";

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
export const FlagListQuerySchema = z
  .object({
    environmentId: z.string().optional(),
  })
  .strict();
export const AppMemberParams = z.object({ appId: z.string(), userId: z.string() });
export const OrgAppsParams = z.object({ orgId: z.string() });
export const EnvParams = z.object({ appId: z.string(), environmentId: z.string() });
export const FlagParams = z.object({ appId: z.string(), flagId: z.string() });
/**
 * `flags_get` path segment is always a selector string; `by` says how to resolve
 * it. Default `id` keeps the canonical-id lookup exact. `key` is the explicit
 * keyed read the Panel uses past the catalog list ceiling (SPL-236) — never
 * overload one segment with both meanings.
 */
export const FlagGetQuerySchema = z
  .object({
    by: z.enum(["id", "key"]).optional(),
  })
  .strict();
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
/**
 * Data-plane resolution addresses a Flag by key, not by id: the edge reads a
 * KV entry keyed by `flagKey` and never sees the Flag definition table. Naming
 * the segment `flagKey` keeps the route, the CLI usage line, and the handler
 * saying the same thing — `flags test-eval <flag-id>` used to accept only a key
 * and report a passed id as FLAG_NOT_FOUND.
 */
export const EnvFlagKeyParams = z.object({
  appId: z.string(),
  environmentId: z.string(),
  flagKey: z.string(),
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
export const ApprovalRequestParams = z.object({
  appId: z.string(),
  id: ApprovalRequestIdSchema,
});
export const PrivacyRequestParams = z.object({ requestId: z.string() });

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
// App membership (`app_memberships`) — a SEPARATE grant from Organization
// membership. Same request shapes, different axis: an Org admin is not an App
// admin (organization-and-membership.md).
// ---------------------------------------------------------------------------

export const AddAppMemberRequestSchema = z
  .object({ userId: z.string(), role: UserRoleSchema })
  .strict();

export const UpdateAppMemberRequestSchema = z.object({ role: UserRoleSchema }).strict();

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
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const ReplaceTargetingRulesRequestSchema = z
  .object({
    targetingRules: z.array(TargetingRuleSchema),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const FlagConfigMutationResponseSchema = z
  .object({
    config: FlagConfigResponseSchema,
    approvalRequest: ApprovalRequestSchema.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Promotion (ADR-0028) — explicit ticked field-groups; absence = leave untouched.
// ---------------------------------------------------------------------------

export const PromoteRequestSchema = z
  .object({
    fromEnvironmentId: z.string(),
    select: z
      .object({
        availability: z.array(z.string()).optional(),
        targeting: z.literal(true).optional(),
        rollout: z.literal(true).optional(),
        enabled: z.literal(true).optional(),
      })
      .strict(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();

export const PromoteResponseSchema = z.object({
  config: FlagConfigResponseSchema,
  diff: z.object({ before: FlagConfigResponseSchema, after: FlagConfigResponseSchema }),
  approvalRequest: ApprovalRequestSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Segments (no create/patch envelope; compose from the Condition leaf).
// ---------------------------------------------------------------------------

export const CreateSegmentRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  conditions: z.array(ConditionSchema).min(1),
  idempotency_key: z.string().optional(),
});
export type CreateSegmentRequest = z.infer<typeof CreateSegmentRequestSchema>;

export const PatchSegmentRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    conditions: z.array(ConditionSchema).min(1).optional(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();
export type PatchSegmentRequest = z.infer<typeof PatchSegmentRequestSchema>;

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
  scopes: z.array(ApiKeyScopeSchema),
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
