import { z } from "@hono/zod-openapi";
import { ApiKeyScopeSchema } from "../api-key-scopes";
import { StoredClientKeyRateLimitRpsSchema } from "../client-key-rate-limit";
import { OriginAllowlistSchema } from "../client-origin";
import { PercentageRolloutSchema, TargetingRuleSchema } from "../leaf-schemas-flag";
import { EnvironmentPolicySchema, UserRoleSchema } from "../leaf-schemas-runtime";
import {
  IdempotencyKeySchema,
  PersistedDescriptionSchema,
  PersistedIdentifierSchema,
  PersistedNameSchema,
  persistedArray,
} from "../persisted-field-limits";
import { SlugSchema } from "../slug";
import { TargetingRuleInputSchema, WriteConditionSchema } from "../write-persisted-schemas";
import {
  ApprovalRequestSchema,
  InlineApproveAndApplyReviewSchema,
} from "./route-shapes-approval-request";

// biome-ignore lint/performance/noBarrelFile: route consumers keep one stable domain import while this file stays below the repository size limit
export {
  ApiKeyParams,
  AppMemberParams,
  AppParams,
  ApprovalRequestParams,
  CanonicalEnvironmentSelectorQuerySchema,
  EnvFlagKeyParams,
  EnvFlagParams,
  EnvParams,
  ExperimentParams,
  FlagGetQuerySchema,
  FlagListQuerySchema,
  PrincipalFlagListQuerySchema,
  FlagParams,
  FlagVariantParams,
  MetricParams,
  OrgAppsParams,
  OrgMemberParams,
  OrgParams,
  PrivacyRequestParams,
  PromoteParams,
  RunEndParams,
  RunParams,
  SegmentParams,
} from "./route-shapes-params";

/**
 * Route-local request/response shapes that have NO dedicated resource envelope
 * (members, environments, flag-config, promotion, privacy, audit), composed
 * from existing leaves — never redefining a domain leaf. Each is kept tiny and
 * single-purpose so the per-domain route files stay declarative.
 */

// ---------------------------------------------------------------------------
// Environment Policy (ADR-0029) — per-change-type allow/confirm map, inline on
// environments_get / environments_update (no separate policy endpoint).
// ---------------------------------------------------------------------------

export const CreateEnvironmentRequestSchema = z
  .object({
    key: SlugSchema,
    name: PersistedNameSchema.optional(),
    policy: EnvironmentPolicySchema.optional(),
  })
  .strict();

export const PatchEnvironmentRequestSchema = z
  .object({
    name: PersistedNameSchema.optional(),
    policy: EnvironmentPolicySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Organization membership (no dedicated envelope).
// ---------------------------------------------------------------------------

export const AddMemberRequestSchema = z
  .object({
    userId: PersistedIdentifierSchema,
    role: UserRoleSchema,
  })
  .strict();

export const UpdateMemberRequestSchema = z.object({ role: UserRoleSchema }).strict();

// ---------------------------------------------------------------------------
// App membership (`app_memberships`) — a SEPARATE grant from Organization
// membership. Same request shapes, different axis: an Org admin is not an App
// admin (organization-and-membership.md).
// ---------------------------------------------------------------------------

export const AddAppMemberRequestSchema = z
  .object({ userId: PersistedIdentifierSchema, role: UserRoleSchema })
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
    availableVariantNames: persistedArray(PersistedNameSchema).optional(),
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
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();

export const TARGETING_RULE_ID_DUPLICATE_MESSAGE = "Targeting Rule id is already used in this list";

/**
 * Duplicate `id`s inside one submitted Targeting Rule list. Paths are relative
 * to the request body object so the route input wrapper can prefix `body`.
 */
export function targetingRuleDuplicateIdIssues(
  rules: ReadonlyArray<{ id: string }>,
): Array<{ path: Array<string | number>; message: string }> {
  const seen = new Set<string>();
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  for (const [index, rule] of rules.entries()) {
    if (seen.has(rule.id)) {
      issues.push({
        path: ["targetingRules", index, "id"],
        message: TARGETING_RULE_ID_DUPLICATE_MESSAGE,
      });
      continue;
    }
    seen.add(rule.id);
  }
  return issues;
}

const TargetingRulesListSchema = persistedArray(TargetingRuleInputSchema).superRefine(
  (rules, ctx) => {
    for (const issue of targetingRuleDuplicateIdIssues(rules)) {
      ctx.addIssue({
        code: "custom",
        // Paths from the helper are relative to the request body; this refine
        // sits on the array, so drop the `targetingRules` prefix.
        path: issue.path.slice(1),
        message: issue.message,
      });
    }
  },
);

export const ReplaceTargetingRulesRequestSchema = z
  .object({
    targetingRules: TargetingRulesListSchema,
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();

/**
 * Write responses keep get's resource fields at the same paths and put
 * side-channel data (`approvalRequest`, and `diff` on promote) alongside —
 * never wrap the resource in `config` (SPL-451).
 */
export const FlagConfigMutationResponseSchema = FlagConfigResponseSchema.extend({
  approvalRequest: ApprovalRequestSchema.nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Promotion (ADR-0028) — explicit ticked field-groups; absence = leave untouched.
// ---------------------------------------------------------------------------

export const PromoteRequestSchema = z
  .object({
    fromEnvironmentId: z.string(),
    select: z
      .object({
        availability: persistedArray(PersistedNameSchema).optional(),
        targeting: z.literal(true).optional(),
        rollout: z.literal(true).optional(),
        enabled: z.literal(true).optional(),
      })
      .strict(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();

export const PromoteResponseSchema = FlagConfigResponseSchema.extend({
  diff: z.object({ before: FlagConfigResponseSchema, after: FlagConfigResponseSchema }),
  approvalRequest: ApprovalRequestSchema.nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Segments (no create/patch envelope; compose from the Condition leaf).
// ---------------------------------------------------------------------------

export const CreateSegmentRequestSchema = z
  .object({
    name: PersistedNameSchema,
    description: PersistedDescriptionSchema.optional(),
    conditions: persistedArray(WriteConditionSchema).min(1),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateSegmentRequest = z.infer<typeof CreateSegmentRequestSchema>;

export const PatchSegmentRequestSchema = z
  .object({
    name: PersistedNameSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
    conditions: persistedArray(WriteConditionSchema).min(1).optional(),
    review: InlineApproveAndApplyReviewSchema.optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();
export type PatchSegmentRequest = z.infer<typeof PatchSegmentRequestSchema>;

// ---------------------------------------------------------------------------
// SDK credentials — client-key patch + api-key create/revoke bodies.
// ---------------------------------------------------------------------------

export const PatchClientKeyRequestSchema = z
  .object({
    originAllowlist: OriginAllowlistSchema.nullable().optional(),
    rateLimitRps: StoredClientKeyRateLimitRpsSchema.optional(),
  })
  .strict();

export const CreateApiKeyRequestSchema = z
  .object({
    scopes: persistedArray(ApiKeyScopeSchema),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();

export const RevokeApiKeyRequestSchema = z.object({}).strict();

export const ClientKeyRotateResponseSchema = z.object({
  newKey: z.object({ keyId: z.string(), keyMaterial: z.string() }),
  revokedKeyId: z.string(),
});

export const ApiKeyRevokeResponseSchema = z.object({
  keyId: z.string(),
  revokedAt: z.string(),
});
