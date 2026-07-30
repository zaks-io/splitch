import { describe, expect, it } from "vitest";
import {
  ApprovalDiffSchema,
  ApprovalRequestSchema,
  ApprovalReviewSchema,
  InlineApproveAndApplyReviewSchema,
  ReviewApprovalRequestSchema,
} from "./routes/route-shapes";

const actor = { userId: "user_1", authDoor: "id_jag" };

describe("Approval Request and Review contract", () => {
  it("parses a durable pending proposal with an immutable target diff", () => {
    const request = ApprovalRequestSchema.parse({
      id: "apr_1",
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
        version: "sha256:target-v3",
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
    expect(request.target.version).toBe("sha256:target-v3");
  });

  it("records a failed Review without an application result", () => {
    const review = ApprovalReviewSchema.parse({
      id: "rev_1",
      approvalRequestId: "apr_1",
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
      id: "apr_2",
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
        version: "sha256:draft-and-policy-v4",
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
        targetVersion: "sha256:run-v4",
        resourceType: "experiment_run",
        resourceId: "run_4",
        appliedAt: reviewedAt,
      },
      latestReview: {
        id: "rev_2",
        approvalRequestId: "apr_2",
        action: "approve_and_apply",
        outcome: "applied",
        actor,
        reviewedAt,
        reason: "Ship the reviewed draft",
        idempotencyKey: "review-2",
        resultingTargetVersion: "sha256:run-v4",
        error: null,
      },
    });

    expect(request.applicationResult?.resourceType).toBe("experiment_run");
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
        id: "rev_invalid",
        approvalRequestId: "apr_1",
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
});
