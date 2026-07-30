import { describe, expect, it } from "vitest";
import { ApprovalRequestIdSchema, ApprovalReviewIdSchema } from "./approval-identifiers";
import {
  ApprovalDiffSchema,
  ApprovalRequestSchema,
  ApprovalReviewSchema,
  InlineApproveAndApplyReviewSchema,
  ReviewApprovalRequestSchema,
} from "./routes/route-shapes";

const actor = { userId: "user_1", authDoor: "id_jag" };
const approvalRequestId = "apr_01J00000000000000000000000";
const secondApprovalRequestId = "apr_01J00000000000000000000001";
const approvalReviewId = "rev_01J00000000000000000000000";
const secondApprovalReviewId = "rev_01J00000000000000000000001";
const targetVersion = `sha256:${"a".repeat(64)}`;
const resultingTargetVersion = `sha256:${"b".repeat(64)}`;

describe("Approval Request and Review contract", () => {
  it("parses a durable pending proposal with an immutable target diff", () => {
    const request = ApprovalRequestSchema.parse({
      id: approvalRequestId,
      appId: "app_1",
      policyContexts: [
        {
          environmentId: "env_prod",
          changeTypes: ["targeting_rollout_value"],
          level: "confirm",
        },
      ],
      operation: "flag_config_update",
      target: {
        type: "flag_configuration",
        id: "fc_1",
        version: targetVersion,
      },
      diff: {
        current: { rollout: { percentage: 10 } },
        proposed: { rollout: { percentage: 25 } },
        entries: [
          {
            path: "/rollout/percentage",
            operation: "replace",
            current: 10,
            proposed: 25,
          },
        ],
      },
      status: "pending",
      proposer: actor,
      proposedAt: "2026-07-29T12:00:00.000Z",
      resolvedAt: null,
      applicationResult: null,
      latestReview: null,
    });

    expect(request.status).toBe("pending");
    expect(request.target.version).toBe(targetVersion);
  });

  it("records a failed Review without an application result", () => {
    const review = ApprovalReviewSchema.parse({
      id: approvalReviewId,
      approvalRequestId,
      action: "approve_and_apply",
      outcome: "failed",
      actor,
      reviewedAt: "2026-07-29T12:01:00.000Z",
      reason: null,
      idempotencyKey: "review-1",
      resultingTargetVersion: null,
      error: {
        code: "VARIANT_NOT_AVAILABLE",
        details: { missingVariants: ["checkout-v2"] },
      },
    });

    expect(review.outcome).toBe("failed");
    expect(review.resultingTargetVersion).toBeNull();
  });

  it("requires an applied Review and typed application result for an applied request", () => {
    const reviewedAt = "2026-07-29T12:01:00.000Z";
    const request = ApprovalRequestSchema.parse({
      id: secondApprovalRequestId,
      appId: "app_1",
      policyContexts: [
        {
          environmentId: "env_prod",
          changeTypes: ["start_experiment_run"],
          level: "confirm",
        },
      ],
      operation: "experiments_start",
      target: {
        type: "experiment_draft",
        id: "exp_1",
        version: targetVersion,
      },
      diff: {
        current: { liveRunId: null },
        proposed: { liveRunId: "run_4" },
        entries: [
          {
            path: "/liveRunId",
            operation: "replace",
            current: null,
            proposed: "run_4",
          },
        ],
      },
      status: "applied",
      proposer: actor,
      proposedAt: "2026-07-29T12:00:00.000Z",
      resolvedAt: reviewedAt,
      applicationResult: {
        targetVersion: resultingTargetVersion,
        resourceType: "experiment_run",
        resourceId: "run_4",
        appliedAt: reviewedAt,
      },
      latestReview: {
        id: secondApprovalReviewId,
        approvalRequestId: secondApprovalRequestId,
        action: "approve_and_apply",
        outcome: "applied",
        actor,
        reviewedAt,
        reason: "Ship the reviewed draft",
        idempotencyKey: "review-2",
        resultingTargetVersion,
        error: null,
      },
    });

    expect(request.applicationResult?.resourceType).toBe("experiment_run");
  });
});

describe("Approval Request staleness projections", () => {
  it("renders effective staleness without requiring a materialized Review", () => {
    const request = ApprovalRequestSchema.parse({
      id: approvalRequestId,
      appId: "app_1",
      policyContexts: [
        {
          environmentId: "env_prod",
          changeTypes: ["enabled_state"],
          level: "confirm",
        },
      ],
      operation: "flag_config_update",
      target: { type: "flag_configuration", id: "fc_1", version: targetVersion },
      diff: {
        current: { enabled: false },
        proposed: { enabled: true },
        entries: [{ path: "/enabled", operation: "replace", current: false, proposed: true }],
      },
      status: "stale",
      proposer: actor,
      proposedAt: "2026-07-29T12:00:00.000Z",
      resolvedAt: null,
      applicationResult: null,
      latestReview: null,
    });

    expect(request.status).toBe("stale");
    expect(request.resolvedAt).toBeNull();
  });

  it("accepts materialized staleness after a Review", () => {
    const reviewedAt = "2026-07-29T12:01:00.000Z";
    const request = ApprovalRequestSchema.parse({
      id: approvalRequestId,
      appId: "app_1",
      policyContexts: [
        {
          environmentId: "env_prod",
          changeTypes: ["enabled_state"],
          level: "confirm",
        },
      ],
      operation: "flag_config_update",
      target: { type: "flag_configuration", id: "fc_1", version: targetVersion },
      diff: {
        current: { enabled: false },
        proposed: { enabled: true },
        entries: [{ path: "/enabled", operation: "replace", current: false, proposed: true }],
      },
      status: "stale",
      proposer: actor,
      proposedAt: "2026-07-29T12:00:00.000Z",
      resolvedAt: reviewedAt,
      applicationResult: null,
      latestReview: {
        id: approvalReviewId,
        approvalRequestId,
        action: "approve_and_apply",
        outcome: "stale",
        actor,
        reviewedAt,
        reason: null,
        idempotencyKey: "review-stale",
        resultingTargetVersion: null,
        error: null,
      },
    });

    expect(request.latestReview?.outcome).toBe("stale");
  });
});

describe("Approval Review input and invariants", () => {
  it("keeps inline Confirmation limited to approve-and-apply", () => {
    expect(InlineApproveAndApplyReviewSchema.parse({ action: "approve_and_apply" }).action).toBe(
      "approve_and_apply",
    );
    expect(InlineApproveAndApplyReviewSchema.safeParse({ action: "decline" }).success).toBe(false);
  });

  it("requires Review idempotency for both positive and decline actions", () => {
    expect(
      ReviewApprovalRequestSchema.parse({
        action: "decline",
        reason: "Target is no longer wanted",
        idempotency_key: "decline-1",
      }).action,
    ).toBe("decline");
    expect(ReviewApprovalRequestSchema.safeParse({ action: "approve_and_apply" }).success).toBe(
      false,
    );
  });

  it("rejects impossible Review outcomes and incomplete diff entries", () => {
    expect(
      ApprovalReviewSchema.safeParse({
        id: approvalReviewId,
        approvalRequestId,
        action: "decline",
        outcome: "failed",
        actor,
        reviewedAt: "2026-07-29T12:01:00.000Z",
        reason: null,
        idempotencyKey: "review-invalid",
        resultingTargetVersion: null,
        error: { code: "INTERNAL_SERVER_ERROR", details: {} },
      }).success,
    ).toBe(false);

    expect(
      ApprovalDiffSchema.safeParse({
        current: {},
        proposed: {},
        entries: [{ path: "/value", operation: "replace", current: "old" }],
      }).success,
    ).toBe(false);
  });

  it("enforces prefixed ULID identifiers", () => {
    expect(ApprovalRequestIdSchema.safeParse(approvalRequestId).success).toBe(true);
    expect(ApprovalReviewIdSchema.safeParse(approvalReviewId).success).toBe(true);
    expect(ApprovalRequestIdSchema.safeParse("apr_1").success).toBe(false);
    expect(ApprovalReviewIdSchema.safeParse("rev_1").success).toBe(false);
  });
});
