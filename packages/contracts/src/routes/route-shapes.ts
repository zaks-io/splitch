import { z } from "@hono/zod-openapi";
import { ConditionSchema, TargetingRuleSchema } from "../leaf-schemas-flag.js";
import { EnvironmentPolicySchema, UserRoleSchema } from "../leaf-schemas-runtime.js";

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
});

export const PatchFlagConfigRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    availableVariantNames: z.array(z.string()).optional(),
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
    originAllowlist: z.array(z.string()).nullable().optional(),
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
