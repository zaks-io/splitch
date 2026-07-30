import { z } from "@hono/zod-openapi";
import { ApprovalRequestIdSchema, ApprovalReviewIdSchema } from "../approval-identifiers";
import { ErrorCodeSchema, ErrorDetailsSchema } from "../errors";
import { PaginationQuerySchema } from "../wire-envelopes-core";
import {
  ApprovalActorSchema,
  ApprovalAppliedResourceTypeSchema,
  ApprovalDiffSchema,
  ApprovalOperationSchema,
  ApprovalPolicyContextSchema,
  ApprovalRequestStatusSchema,
  ApprovalReviewActionSchema,
  ApprovalReviewOutcomeSchema,
  ApprovalTargetSchema,
  ApprovalTargetTypeSchema,
  ApprovalTargetVersionSchema,
} from "./route-shapes-approvals";

/**
 * The Approval Request and Review envelopes themselves, split out of
 * `route-shapes-approvals.ts` (which holds the enums and leaves they compose)
 * only to keep both files readable.
 */

export const InlineApproveAndApplyReviewSchema = z
  .object({ action: z.literal("approve_and_apply") })
  .strict();

export const ApprovalApplicationResultSchema = z
  .object({
    targetVersion: ApprovalTargetVersionSchema,
    resourceType: ApprovalAppliedResourceTypeSchema,
    resourceId: z.string(),
    appliedAt: z.string(),
  })
  .strict();

export const ApprovalReviewErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    details: ErrorDetailsSchema,
  })
  .strict();

export const ApprovalReviewSchema = z
  .object({
    id: ApprovalReviewIdSchema,
    approvalRequestId: ApprovalRequestIdSchema,
    action: ApprovalReviewActionSchema,
    outcome: ApprovalReviewOutcomeSchema,
    actor: ApprovalActorSchema,
    reviewedAt: z.string(),
    reason: z.string().nullable(),
    idempotencyKey: z.string().min(1),
    resultingTargetVersion: ApprovalTargetVersionSchema.nullable(),
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
    id: ApprovalRequestIdSchema,
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
    const isEffectiveStale = request.status === "stale" && request.resolvedAt === null;
    if ((request.resolvedAt === null) !== (isPending || isEffectiveStale)) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "resolvedAt is null only while pending or stale-on-read",
      });
    }
  })
  .superRefine((request, context) => {
    const isUnmaterialized = request.status === "pending" || request.resolvedAt === null;
    if (isUnmaterialized) {
      if (request.latestReview !== null && request.latestReview.outcome !== "failed") {
        context.addIssue({
          code: "custom",
          path: ["latestReview"],
          message: "an unresolved Approval Request can only expose a failed latest Review",
        });
      }
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

export const ApprovalRequestListQuerySchema = PaginationQuerySchema.extend({
  status: ApprovalRequestStatusSchema.optional(),
  target_kind: ApprovalTargetTypeSchema.optional(),
});

export type ApprovalApplicationResult = z.infer<typeof ApprovalApplicationResultSchema>;
export type ApprovalReviewError = z.infer<typeof ApprovalReviewErrorSchema>;
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ReviewApprovalRequest = z.infer<typeof ReviewApprovalRequestSchema>;
export type ApprovalRequestListQuery = z.infer<typeof ApprovalRequestListQuerySchema>;
