import { and, eq, exists, sql } from "drizzle-orm";
import { approvalRequests, approvalReviews } from "../schema/index";
import { currentReviewerCondition } from "./approval-atomic";
import type { ApprovalDisposition, ApprovalFailure } from "./approval-types";
import type { Db } from "./client";
import type { TenantScope } from "./scope";

/**
 * The two Approval write paths that resolve a Request WITHOUT applying its
 * target: the decline / stale-materialization disposition, and the `failed`
 * audit row. Split out of `approvals.ts` so the repository stays readable.
 */

export function failureInsert(db: Db, scope: TenantScope, failure: ApprovalFailure) {
  return db.insert(approvalReviews).select(
    db
      .select({
        id: sql<string>`${failure.reviewId}`.as("id"),
        appId: approvalRequests.appId,
        approvalRequestId: approvalRequests.id,
        action: sql<string>`'approve_and_apply'`.as("action"),
        outcome: sql<string>`'failed'`.as("outcome"),
        reviewedBy: sql<string>`${failure.reviewedBy}`.as("reviewed_by"),
        reviewedVia: sql<string>`${failure.reviewedVia}`.as("reviewed_via"),
        reviewedAt: sql<string>`${failure.reviewedAt}`.as("reviewed_at"),
        reason: sql<string | null>`${failure.reason}`.as("reason"),
        idempotencyKey: sql<string>`${failure.idempotencyKey}`.as("idempotency_key"),
        requestHash: sql<string>`${failure.requestHash}`.as("request_hash"),
        resultingTargetVersion: sql<string | null>`NULL`.as("resulting_target_version"),
        resultingResourceType: sql<string | null>`NULL`.as("resulting_resource_type"),
        resultingResourceId: sql<string | null>`NULL`.as("resulting_resource_id"),
        errorCode: sql<string>`${failure.errorCode}`.as("error_code"),
        errorDetails: sql<string>`${failure.errorDetails}`.as("error_details"),
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.appId, scope.appId),
          eq(approvalRequests.id, failure.requestId),
          eq(approvalRequests.status, "pending"),
        ),
      ),
  );
}

/**
 * Every predicate is keyed off the MINTED scope: the scope is what the caller
 * was authorized for, so a disposition naming a foreign App matches nothing
 * instead of writing outside that scope.
 *
 * `currentReviewerCondition` is the same D1 backstop the apply paths get from
 * `approvalPendingCondition`. Decline and stale-materialization resolve a
 * Request and write an audit row, so they need it for the same reason: the
 * service-layer role check can be bypassed by any future caller of this seam,
 * and a role can be revoked between that check and this write. The service
 * check stays on top of it — it is what produces the contract-declared
 * `ROLE_NOT_ALLOWED` shape, which this layer cannot express.
 */
export function dispositionQueries(db: Db, scope: TenantScope, disposition: ApprovalDisposition) {
  const reviewerIsAllowed = currentReviewerCondition(db, scope, disposition.reviewedBy);
  const insert = db
    .insert(approvalReviews)
    .select(
      db
        .select({
          id: sql<string>`${disposition.reviewId}`.as("id"),
          appId: approvalRequests.appId,
          approvalRequestId: approvalRequests.id,
          action: sql<string>`${disposition.action}`.as("action"),
          outcome: sql<string>`${disposition.outcome}`.as("outcome"),
          reviewedBy: sql<string>`${disposition.reviewedBy}`.as("reviewed_by"),
          reviewedVia: sql<string>`${disposition.reviewedVia}`.as("reviewed_via"),
          reviewedAt: sql<string>`${disposition.reviewedAt}`.as("reviewed_at"),
          reason: sql<string | null>`${disposition.reason}`.as("reason"),
          idempotencyKey: sql<string>`${disposition.idempotencyKey}`.as("idempotency_key"),
          requestHash: sql<string>`${disposition.requestHash}`.as("request_hash"),
          resultingTargetVersion: sql<string | null>`NULL`.as("resulting_target_version"),
          resultingResourceType: sql<string | null>`NULL`.as("resulting_resource_type"),
          resultingResourceId: sql<string | null>`NULL`.as("resulting_resource_id"),
          errorCode: sql<string | null>`NULL`.as("error_code"),
          errorDetails: sql<string | null>`NULL`.as("error_details"),
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.appId, scope.appId),
            eq(approvalRequests.id, disposition.requestId),
            eq(approvalRequests.status, "pending"),
            reviewerIsAllowed,
          ),
        ),
    )
    .returning({ id: approvalReviews.id });
  const update = db
    .update(approvalRequests)
    .set({ status: disposition.outcome, resolvedAt: disposition.reviewedAt })
    .where(
      and(
        eq(approvalRequests.appId, scope.appId),
        eq(approvalRequests.id, disposition.requestId),
        eq(approvalRequests.status, "pending"),
        reviewerIsAllowed,
        // Same three-part identity the applied path guards on: a Review id alone
        // could belong to another App's request.
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(approvalReviews)
            .where(
              and(
                eq(approvalReviews.appId, scope.appId),
                eq(approvalReviews.id, disposition.reviewId),
                eq(approvalReviews.approvalRequestId, disposition.requestId),
              ),
            ),
        ),
      ),
    )
    .returning({ id: approvalRequests.id });
  return [insert, update] as const;
}
