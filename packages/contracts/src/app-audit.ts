import { z } from "@hono/zod-openapi";
import { ErrorCodeSchema } from "./errors";
import { UserRoleSchema } from "./leaf-schemas-runtime";
import { AuthDoorSchema } from "./route-contract";
import { ApprovalReviewActionSchema } from "./routes/route-shapes-approvals";
import { listResponse, PaginationQuerySchema } from "./wire-envelopes-core";

const ReferenceSchema = z.string().min(1);

export const AppAuditMetadataSchema = z
  .object({
    changedFields: z.array(ReferenceSchema).optional(),
    reviewId: ReferenceSchema.optional(),
    reviewAction: ApprovalReviewActionSchema.optional(),
    resultingTargetVersion: ReferenceSchema.nullable().optional(),
    errorCode: ErrorCodeSchema.nullable().optional(),
    role: UserRoleSchema.optional(),
    previousRole: UserRoleSchema.optional(),
    revokedKeyId: ReferenceSchema.optional(),
  })
  .strict();

/** The only ordinary-event JSON stored in audit_log.changes. Raw diffs are forbidden. */
export const AppAuditChangesSchema = z
  .object({
    environmentId: ReferenceSchema.nullable(),
    organizationId: ReferenceSchema,
    targetVersion: ReferenceSchema.nullable(),
    outcome: z.enum(["committed", "pending", "applied", "declined", "stale", "failed"]),
    requestId: ReferenceSchema.nullable(),
    approvalRequestId: ReferenceSchema.nullable(),
    runId: ReferenceSchema.nullable(),
    metadata: AppAuditMetadataSchema,
  })
  .strict();

export const AppAuditEventSchema = AppAuditChangesSchema.extend({
  eventId: ReferenceSchema,
  appId: ReferenceSchema,
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), userId: ReferenceSchema }).strict(),
    z.object({ type: z.literal("unattributed"), userId: z.null() }).strict(),
  ]),
  authDoor: z.union([AuthDoorSchema, z.literal("unattributed")]),
  action: z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/),
  resourceType: ReferenceSchema,
  resourceId: ReferenceSchema,
  timestamp: z.string().datetime(),
}).strict();

export const AppAuditListQuerySchema = PaginationQuerySchema.extend({
  environmentId: ReferenceSchema.optional(),
  action: ReferenceSchema.optional(),
  resourceType: ReferenceSchema.optional(),
  resourceId: ReferenceSchema.optional(),
  approvalRequestId: ReferenceSchema.optional(),
  runId: ReferenceSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).strict();

export const AppAuditListResponseSchema = listResponse(AppAuditEventSchema).strict();

export const AppAuditStorageRowSchema = z
  .object({
    audit_id: ReferenceSchema,
    dedup_key: ReferenceSchema,
    app_id: ReferenceSchema,
    user_id: ReferenceSchema.nullable(),
    auth_method: z.union([AuthDoorSchema, z.literal("unattributed")]),
    action: AppAuditEventSchema.shape.action,
    resource_type: ReferenceSchema,
    resource_id: ReferenceSchema,
    changes: z.string(),
    timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
    archive_version: z.null(),
  })
  .strict();
export type AppAuditChanges = z.infer<typeof AppAuditChangesSchema>;
export type AppAuditEvent = z.infer<typeof AppAuditEventSchema>;
export type AppAuditListQuery = z.infer<typeof AppAuditListQuerySchema>;
export type AppAuditListResponse = z.infer<typeof AppAuditListResponseSchema>;
