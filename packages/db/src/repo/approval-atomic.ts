import { and, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import { appMemberships, approvalRequests, approvalReviews, environments } from "../schema/index";
import type { ApprovalCommit, ApprovalPolicyContextGuard } from "./approval-types";
import type { Db } from "./client";

export function approvalPendingCondition(db: Db, commit: ApprovalCommit) {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.appId, commit.appId),
          eq(approvalRequests.id, commit.requestId),
          eq(approvalRequests.status, "pending"),
          currentReviewerCondition(db, commit),
          ...commit.policyContexts.map((context) => currentPolicyCondition(db, commit, context)),
        ),
      ),
  );
}

function currentReviewerCondition(db: Db, commit: ApprovalCommit) {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(appMemberships)
      .where(
        and(
          eq(appMemberships.appId, commit.appId),
          eq(appMemberships.userId, commit.reviewedBy),
          inArray(appMemberships.role, ["owner", "admin"]),
        ),
      ),
  );
}

function currentPolicyCondition(
  db: Db,
  commit: ApprovalCommit,
  context: ApprovalPolicyContextGuard,
) {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(environments)
      .where(
        and(
          eq(environments.appId, commit.appId),
          eq(environments.id, context.environmentId),
          ...context.changeTypes.map((changeType) =>
            policyLevelCondition(changeType, context.level),
          ),
        ),
      ),
  );
}

function policyLevelCondition(
  changeType: ApprovalPolicyContextGuard["changeTypes"][number],
  level: ApprovalPolicyContextGuard["level"],
) {
  switch (changeType) {
    case "variant_availability":
      return sql`json_extract(${environments.policy}, '$.variantAvailability') = ${level}`;
    case "targeting_rollout_value":
      return sql`json_extract(${environments.policy}, '$.targetingRolloutValue') = ${level}`;
    case "enabled_state":
      return sql`json_extract(${environments.policy}, '$.enabledState') = ${level}`;
    case "start_experiment_run":
      return sql`json_extract(${environments.policy}, '$.startExperimentRun') = ${level}`;
  }
}

/**
 * Append immediately after the canonical target mutation in a D1 batch.
 * SQLite changes() binds the Review to the preceding guarded mutation: if the
 * target or pending-request guard lost a race, no successful Review is written.
 */
export function appliedReviewQueries(
  db: Db,
  commit: ApprovalCommit,
  mutationEvidence: SQL = sql`changes() = 1`,
) {
  const reviewInsert = db.insert(approvalReviews).select(
    db
      .select({
        id: sql<string>`${commit.reviewId}`.as("id"),
        appId: approvalRequests.appId,
        approvalRequestId: approvalRequests.id,
        action: sql<string>`'approve_and_apply'`.as("action"),
        outcome: sql<string>`'applied'`.as("outcome"),
        reviewedBy: sql<string>`${commit.reviewedBy}`.as("reviewed_by"),
        reviewedVia: sql<string>`${commit.reviewedVia}`.as("reviewed_via"),
        reviewedAt: sql<string>`${commit.reviewedAt}`.as("reviewed_at"),
        reason: sql<string | null>`${commit.reason}`.as("reason"),
        idempotencyKey: sql<string>`${commit.idempotencyKey}`.as("idempotency_key"),
        requestHash: sql<string>`${commit.requestHash}`.as("request_hash"),
        resultingTargetVersion: sql<string>`${commit.resultingTargetVersion}`.as(
          "resulting_target_version",
        ),
        resultingResourceType: sql<string>`${commit.resultingResourceType}`.as(
          "resulting_resource_type",
        ),
        resultingResourceId: sql<string>`${commit.resultingResourceId}`.as("resulting_resource_id"),
        errorCode: sql<string | null>`NULL`.as("error_code"),
        errorDetails: sql<string | null>`NULL`.as("error_details"),
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.appId, commit.appId),
          eq(approvalRequests.id, commit.requestId),
          eq(approvalRequests.status, "pending"),
          mutationEvidence,
        ),
      ),
  );
  const requestUpdate = db
    .update(approvalRequests)
    .set({
      status: "applied",
      resolvedAt: commit.reviewedAt,
      resultingTargetVersion: commit.resultingTargetVersion,
      resultingResourceType: commit.resultingResourceType,
      resultingResourceId: commit.resultingResourceId,
    })
    .where(
      and(
        eq(approvalRequests.appId, commit.appId),
        eq(approvalRequests.id, commit.requestId),
        eq(approvalRequests.status, "pending"),
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(approvalReviews)
            .where(
              and(
                eq(approvalReviews.appId, commit.appId),
                eq(approvalReviews.id, commit.reviewId),
                eq(approvalReviews.approvalRequestId, commit.requestId),
              ),
            ),
        ),
      ),
    )
    .returning({ id: approvalRequests.id });
  return [reviewInsert, requestUpdate] as const;
}
