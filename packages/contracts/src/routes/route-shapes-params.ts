import { z } from "@hono/zod-openapi";
import { ApprovalRequestIdSchema } from "../approval-identifiers";

const AppSelectorSchema = z
  .string()
  .describe("Canonical App ID (app_...) or human-readable App slug.");
const EnvironmentSelectorSchema = z
  .string()
  .describe("Canonical Environment ID (env_...) or human-readable Environment key.");
const FlagSelectorSchema = z
  .string()
  .describe("Canonical Flag ID (flag_...) or human-readable Flag key.");

export const OrgParams = z.object({ orgId: z.string() });
export const OrgMemberParams = z.object({ orgId: z.string(), userId: z.string() });
export const AppParams = z.object({ appId: AppSelectorSchema });
const EnvironmentSelectorsQuerySchema = z
  .string()
  .min(1)
  .regex(/^[^,]+(?:,[^,]+)*$/, "envs must be a comma-separated list of Environment selectors");
export const FlagListQuerySchema = z
  .object({
    environmentId: z.string().min(1).optional(),
    include: z
      .literal("config")
      .optional()
      .describe(
        "Include complete per-Environment Flag Configurations; CLI and MCP reads use this by default.",
      ),
    envs: EnvironmentSelectorsQuerySchema.optional().describe(
      "Comma-separated Environment IDs or keys to hydrate; omission hydrates every Environment in the App.",
    ),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.envs && query.include !== "config") {
      ctx.addIssue({ code: "custom", path: ["envs"], message: "envs requires include=config" });
    }
    if (query.environmentId && query.include === "config") {
      ctx.addIssue({
        code: "custom",
        path: ["environmentId"],
        message: "environmentId cannot be combined with include=config; use envs",
      });
    }
  });
export const AppMemberParams = z.object({ appId: AppSelectorSchema, userId: z.string() });
export const OrgAppsParams = z.object({ orgId: z.string() });
export const EnvParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
});
export const FlagParams = z.object({ appId: AppSelectorSchema, flagId: FlagSelectorSchema });

/**
 * Flag path segments accept canonical IDs or keys. The resolver treats a
 * canonical-looking value as an ID unless `by=key` explicitly selects the key
 * collision, then hands one canonical ID to the handler (SPL-236/SPL-524).
 */
export const FlagGetQuerySchema = z
  .object({
    by: z.enum(["id", "key"]).optional(),
    include: z
      .literal("config")
      .optional()
      .describe(
        "Include complete per-Environment Flag Configurations; CLI and MCP reads use this by default.",
      ),
    envs: EnvironmentSelectorsQuerySchema.optional().describe(
      "Comma-separated Environment IDs or keys to hydrate; omission hydrates every Environment in the App.",
    ),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.envs && query.include !== "config") {
      ctx.addIssue({ code: "custom", path: ["envs"], message: "envs requires include=config" });
    }
  });

export const CanonicalEnvironmentSelectorQuerySchema = z
  .object({
    by: z
      .literal("id")
      .optional()
      .describe("Force a canonical Environment ID when a legacy key has the same value."),
  })
  .strict();

export const FlagVariantParams = z.object({
  appId: AppSelectorSchema,
  flagId: FlagSelectorSchema,
  variantName: z.string(),
});
export const EnvFlagParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  flagId: FlagSelectorSchema,
});
export const EnvFlagKeyParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  flagKey: z.string(),
});
export const SegmentParams = z.object({ appId: AppSelectorSchema, segmentId: z.string() });
export const MetricParams = z.object({ appId: AppSelectorSchema, metricId: z.string() });
export const ExperimentParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  experimentId: z.string(),
});
export const RunParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  experimentId: z.string(),
  runId: z.string(),
});
export const RunEndParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  runId: z.string(),
});
export const ApiKeyParams = z.object({
  appId: AppSelectorSchema,
  environmentId: EnvironmentSelectorSchema,
  keyId: z.string(),
});
export const PromoteParams = z.object({
  appId: AppSelectorSchema,
  targetEnvironmentId: EnvironmentSelectorSchema,
  flagId: FlagSelectorSchema,
});
export const ApprovalRequestParams = z.object({
  appId: AppSelectorSchema,
  id: ApprovalRequestIdSchema,
});
export const PrivacyRequestParams = z.object({ requestId: z.string() });
