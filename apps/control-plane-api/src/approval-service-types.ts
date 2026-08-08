import type { ApprovalRequest, ErrorCode } from "@splitch/contracts";
import type { ApprovalCommit, ApprovalTargetState, Repository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import type { ConfigStoreAccess } from "./config-store-do";

export interface ApprovalServiceDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
  applyOther?: (request: ApprovalRequest, commit: ApprovalCommit) => Promise<ApplicationOutcome>;
}

/**
 * `notApplied` is not a failure: the guarded write selected zero rows because
 * the Approval Request stopped being applicable mid-flight (resolved by a
 * concurrent Review, target moved, reviewer role revoked). It carries no error
 * because the reconciliation in `approval-review-application.ts` re-reads the
 * stored state and decides between `applied`, `stale`, and a recorded failure —
 * recording a failure here would bury a legitimate race as a 500.
 */
export type ApplicationOutcome =
  | { ok: true }
  | { ok: false; notApplied: true }
  /**
   * The proposal can never be applied AS PROPOSED, no matter how often it is
   * reviewed: the world it was written against has moved on in a way the target
   * version cannot express. The Request is resolved terminally rather than
   * recorded as a retryable failure, because a Request that only becomes
   * approvable again once some other condition lifts is a delayed write nobody
   * re-authorized (ADR-0036). The carried error is surfaced verbatim so the
   * reviewer learns WHAT refused it, not just that something did.
   */
  | { ok: false; unapplicable: UnapplicableProposal }
  | {
      ok: false;
      targetState: ApplicationTargetState;
      error: { code: ErrorCode; details: Record<string, unknown> };
    };

/**
 * What a failed application left behind in the target state. It travels with
 * the failure because the message the operator reads is a claim about their
 * data: "rolled back" is how they learn there is nothing to clean up, and
 * saying it after a durable write is a lie. `applied` is the Segment
 * republication shape — the mutation landed, a later step did not — and it is
 * the same fact `SegmentRepublishFailure.segmentApplied` already records.
 *
 * There is no default and no inference. A call site that cannot observe which
 * of the two happened says `unknown` out loud and sends the operator back to
 * the stored Approval Request (ADR-0036).
 *
 * One declaration, aliased from the persistence seam: the value is written to
 * `approval_reviews.target_state` and read back by the replay, so a second copy
 * of the union would let the two sides drift apart silently.
 */
export type ApplicationTargetState = ApprovalTargetState;

export interface UnapplicableProposal {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export type ApprovalResult =
  | { ok: true; approvalRequest: ApprovalRequest }
  | { ok: false; response: Response };

export type ApprovalRequestRow = NonNullable<
  Awaited<ReturnType<Repository["approvals"]["getRequest"]>>
>;

export type ApprovalReviewRow = NonNullable<
  Awaited<ReturnType<Repository["approvals"]["latestReview"]>>
>;

export interface ReviewApprovalInput {
  appId: string;
  approvalRequestId: string;
  action: "approve_and_apply" | "decline";
  reason: string | null;
  idempotencyKey: string;
  principal: Principal;
  requestId: string;
}
