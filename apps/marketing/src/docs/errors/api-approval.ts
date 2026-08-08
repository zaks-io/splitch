import type { ErrorDoc } from "./types";

export const approvalErrorDocs = {
  APPROVAL_REVIEW_REQUIRED: {
    cause:
      "The Environment Policy gates this change at `confirm`, and the call carried no inline `review`. A durable Approval Request now exists and is pending.",
    fix: 'Review the request in `details.approvalRequestId`. Do not resend the mutation in parallel: that opens a second request for the same change. To apply in one call next time, send `review: { action: "approve_and_apply" }` with the mutation. `details.policyContexts` names which Environment and change types triggered the gate.',
    details:
      '{ approvalRequestId: string, status: "pending", policyContexts: Array<{ environmentId: string, changeTypes: PolicyChangeType[], level: ApprovalPolicyLevel }>, recommendedAction: "REVIEW_APPROVAL_REQUEST" }',
    recommendedAction: "REVIEW_APPROVAL_REQUEST",
    related: ["APPROVAL_REVIEW_FORBIDDEN", "APPROVAL_REQUEST_STALE", "IDEMPOTENCY_KEY_CONFLICT"],
  },
  APPROVAL_REQUEST_STALE: {
    cause:
      "The target changed after the request was proposed, so approving it would apply a diff computed against state that no longer exists. The request is terminal.",
    fix: "Read the current state and create a new request from it. `details.targetVersion` is what the request was built against and `details.currentTargetVersion` is what is live now. Stale is not retryable: there is nothing to re-approve.",
    details:
      '{ approvalRequestId: string, targetVersion: string, currentTargetVersion: string, recommendedAction: "REFRESH_AND_REPROPOSE" }',
    recommendedAction: "REFRESH_AND_REPROPOSE",
    related: ["APPROVAL_REQUEST_RESOLVED", "APPROVAL_REVIEW_REQUIRED"],
  },
  APPROVAL_REQUEST_RESOLVED: {
    cause: "A different Review already resolved this request.",
    fix: "Read `details.status` for the outcome: `applied` means the change is live and nothing further is needed, `declined` means it was rejected, `stale` means the target moved. `details.reviewId` names the Review that resolved it, or is `null` when the system resolved it without one.",
    details:
      '{ approvalRequestId: string, status: "applied" | "declined" | "stale", reviewId: string | null }',
    related: ["APPROVAL_REQUEST_STALE", "APPROVAL_REQUEST_NOT_FOUND"],
  },
  APPROVAL_APPLICATION_FAILED: {
    cause:
      "The Review was authorized but applying the change did not complete. The request remains pending; inspect `details.applicationError` before retrying with a new Review idempotency key.",
    fix: "Read `details.applicationError` and the response message to determine whether the target was rolled back, changed before a later failure, or left in an unknown state. Fix the underlying failure, re-read the target when its state is unknown, then retry the Review with a new idempotency key.",
    details:
      '{ approvalRequestId: string, reviewId: string, applicationError: { code: ErrorCode, details: object }, recommendedAction: "RETRY_REVIEW" }',
    recommendedAction: "RETRY_REVIEW",
    related: ["IDEMPOTENCY_KEY_CONFLICT", "APPROVAL_REVIEW_REQUIRED", "INTERNAL_SERVER_ERROR"],
  },
  IDEMPOTENCY_KEY_CONFLICT: {
    cause:
      "The same idempotency key was reused with a different canonical payload. Honoring it would let one key stand for two different changes.",
    fix: "Use a fresh key for the new payload, or resend the original payload unchanged to get the original result. `details.scope` says whether the key was scoped to an `approval_request`, a `review`, or a `conclusion`.",
    details: '{ scope: "approval_request" | "review" | "conclusion", idempotencyKey: string }',
    related: ["APPROVAL_APPLICATION_FAILED", "APPROVAL_REVIEW_REQUIRED"],
  },
} satisfies Record<string, ErrorDoc>;
