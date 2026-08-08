import { z } from "@hono/zod-openapi";
import { CanonicalJsonSha256Schema } from "../canonical-hash";
import { PolicyChangeTypeSchema } from "../errors";
import { ApprovalPolicyLevelSchema } from "../leaf-schemas-runtime";
import { AuthDoorSchema } from "../route-contract";

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
  "flag",
  "flag_configuration",
  "flag_variant",
  "segment",
  "experiment_draft",
] as const;
export const ApprovalTargetTypeSchema = z.enum(approvalTargetTypes);

export const approvalAppliedResourceTypes = [
  "flag",
  "flag_configuration",
  "flag_variant",
  "segment",
  "experiment_run",
] as const;
export const ApprovalAppliedResourceTypeSchema = z.enum(approvalAppliedResourceTypes);

export const approvalOperations = [
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flags_promote",
  "flag_variants_create",
  "flag_variants_update",
  "flag_variants_delete",
  "flags_delete",
  "segments_update",
  "experiments_start",
  "experiment_winner_promote",
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
    level: ApprovalPolicyLevelSchema,
  })
  .strict();

export const ApprovalTargetVersionSchema = CanonicalJsonSha256Schema;

export const ApprovalTargetSchema = z
  .object({
    type: ApprovalTargetTypeSchema,
    id: z.string(),
    version: ApprovalTargetVersionSchema,
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

export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;
export type ApprovalReviewAction = z.infer<typeof ApprovalReviewActionSchema>;
export type ApprovalReviewOutcome = z.infer<typeof ApprovalReviewOutcomeSchema>;
export type ApprovalTargetType = z.infer<typeof ApprovalTargetTypeSchema>;
export type ApprovalAppliedResourceType = z.infer<typeof ApprovalAppliedResourceTypeSchema>;
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;
export type ApprovalActor = z.infer<typeof ApprovalActorSchema>;
export type ApprovalPolicyContext = z.infer<typeof ApprovalPolicyContextSchema>;
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ApprovalTargetVersion = z.infer<typeof ApprovalTargetVersionSchema>;
export type ApprovalDiffEntry = z.infer<typeof ApprovalDiffEntrySchema>;
export type ApprovalDiff = z.infer<typeof ApprovalDiffSchema>;
