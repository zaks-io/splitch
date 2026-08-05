import { z } from "@hono/zod-openapi";
import { ApprovalRequestIdSchema } from "./approval-identifiers";

/**
 * Shared delete-tree shapes for App (and later Organization) teardown.
 *
 * `--dry-run` returns the full blocker tree with child IDs and the CLI command
 * that removes each child. `--force` walks that tree in dependency order and
 * either finishes or stops once with pending Approval Request IDs — it never
 * auto-resolves Reviews (safer default; SPL-326).
 *
 * Kept in contracts so MCP, CLI, Control Panel, and Workers share one vocabulary
 * and `organizations_delete` can adopt the same query/response shape later.
 */

/**
 * Query/MCP boolean: URL query strings are always text, while MCP/CLI flat
 * inputs send real booleans. Accept both; reject everything else loudly.
 */
export const QueryBooleanSchema = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((value) => value === true || value === "true");

export const ResourceDeleteModeQuerySchema = z
  .object({
    dryRun: QueryBooleanSchema.optional(),
    force: QueryBooleanSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.dryRun === true && query.force === true) {
      context.addIssue({
        code: "custom",
        path: ["force"],
        message: "dryRun and force are mutually exclusive",
      });
    }
  });

export type ResourceDeleteModeQuery = z.infer<typeof ResourceDeleteModeQuerySchema>;

/**
 * CLI resource group vocabulary for blockers (not storage table names).
 * `flag_configs` → `flag-config`; agents must not translate storage names.
 */
export const ResourceDeleteChildTypeSchema = z.enum([
  "experiments",
  "flag-config",
  "flag-targeting-rules",
  "flags",
  "segments",
  "metrics",
  "entity-privacy",
  "privacy-requests",
  "apps",
  "environments",
]);

export type ResourceDeleteChildType = z.infer<typeof ResourceDeleteChildTypeSchema>;

export const ResourceDeleteChildSchema = z
  .object({
    id: z.string().min(1),
    /** Exact CLI invocation that removes this child (or the force path that cascades it). */
    removeCommand: z.string().min(1),
  })
  .strict();

export type ResourceDeleteChild = z.infer<typeof ResourceDeleteChildSchema>;

export const ResourceDeleteBlockerSchema = z
  .object({
    resourceType: z.enum(["app", "environment", "organization"]),
    resourceId: z.string().min(1),
    childType: ResourceDeleteChildTypeSchema,
    children: z.array(ResourceDeleteChildSchema).min(1),
  })
  .strict();

export type ResourceDeleteBlocker = z.infer<typeof ResourceDeleteBlockerSchema>;

export const ResourceDeleteRemovedSchema = z
  .object({
    childType: ResourceDeleteChildTypeSchema,
    id: z.string().min(1),
  })
  .strict();

export type ResourceDeleteRemoved = z.infer<typeof ResourceDeleteRemovedSchema>;

export const ResourceDeletePendingApprovalSchema = z
  .object({
    approvalRequestId: ApprovalRequestIdSchema,
    operation: z.string().min(1),
    targetId: z.string().min(1),
    reviewCommand: z.string().min(1),
  })
  .strict();

export type ResourceDeletePendingApproval = z.infer<typeof ResourceDeletePendingApprovalSchema>;

/** Plain delete of an empty resource (back-compat). */
export const ResourceDeletedResponseSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

/** `--dry-run`: full blocker tree, nothing removed. */
export const ResourceDeleteDryRunResponseSchema = z
  .object({
    deleted: z.literal(false),
    dryRun: z.literal(true),
    blockers: z.array(ResourceDeleteBlockerSchema),
  })
  .strict();

/** `--force` finished the cascade. */
export const ResourceDeleteForceCompletedResponseSchema = z
  .object({
    deleted: z.literal(true),
    force: z.literal(true),
    removed: z.array(ResourceDeleteRemovedSchema),
  })
  .strict();

/**
 * `--force` stopped because Policy-gated children need Review. Already-removed
 * children stay removed; retry `--force` after reviewing the listed Requests.
 */
export const ResourceDeleteForceBlockedResponseSchema = z
  .object({
    deleted: z.literal(false),
    force: z.literal(true),
    removed: z.array(ResourceDeleteRemovedSchema),
    pendingApprovals: z.array(ResourceDeletePendingApprovalSchema).min(1),
  })
  .strict();

export const ResourceDeleteResponseSchema = z.union([
  ResourceDeletedResponseSchema,
  ResourceDeleteDryRunResponseSchema,
  ResourceDeleteForceCompletedResponseSchema,
  ResourceDeleteForceBlockedResponseSchema,
]);

export type ResourceDeleteResponse = z.infer<typeof ResourceDeleteResponseSchema>;
