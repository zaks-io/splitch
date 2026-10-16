import { sql } from "drizzle-orm";
import { approvalRequests, apps, controlPlaneAuditEvents } from "../schema/index";
import type { ApprovalCommit, ApprovalDisposition, ApprovalFailure } from "./approval-types";
import { auditMetadata } from "./audit-event-write";
import type { Db } from "./client";
import type { TenantScope } from "./scope";

type Review = ApprovalCommit | ApprovalDisposition | ApprovalFailure;

/** Runs immediately after this attempt's Review/Request write, never after a replay read. */
export function approvalReviewAudit(db: Db, scope: TenantScope, review: Review, outcome: string) {
  const resultingVersion =
    "resultingTargetVersion" in review ? review.resultingTargetVersion : null;
  const runId =
    "resultingResourceType" in review && review.resultingResourceType === "experiment_run"
      ? review.resultingResourceId
      : null;
  return db.insert(controlPlaneAuditEvents).select(
    db
      .select({
        seq: sql<number>`NULL`.as("seq"),
        eventId: sql<string>`${crypto.randomUUID()}`.as("event_id"),
        appId: approvalRequests.appId,
        environmentId: sql<
          string | null
        >`json_extract(${approvalRequests.policyContexts}, '$[0].environmentId')`.as(
          "environment_id",
        ),
        organizationId: apps.organizationId,
        actorRef: sql<string>`${review.reviewedBy}`.as("actor_ref"),
        actorVia: sql<string>`${review.reviewedVia}`.as("actor_via"),
        action: sql<string>`'approval_request_reviews_create'`.as("action"),
        resourceType: sql<string>`'approval_request'`.as("resource_type"),
        resourceId: approvalRequests.id,
        targetVersion: approvalRequests.targetVersion,
        outcome: sql<string>`${outcome}`.as("outcome"),
        requestId: sql<string | null>`${review.audit?.requestId ?? null}`.as("request_id"),
        approvalRequestId: approvalRequests.id,
        runId: sql<
          string | null
        >`COALESCE(${runId}, (SELECT conclusion.run_id FROM conclusion_approval_requests link
      JOIN experiment_conclusions conclusion ON conclusion.app_id = link.app_id AND conclusion.id = link.conclusion_id
      WHERE link.app_id = ${approvalRequests.appId} AND link.approval_request_id = ${approvalRequests.id} LIMIT 1))`.as(
          "run_id",
        ),
        changesJson: sql<string>`${auditMetadata({
          reviewId: review.reviewId,
          reviewAction: "action" in review ? review.action : "approve_and_apply",
          resultingTargetVersion: resultingVersion,
          errorCode: "errorCode" in review ? review.errorCode : null,
        })}`.as("changes_json"),
        changedAt: sql<string>`${review.reviewedAt}`.as("changed_at"),
        forwardedAt: sql<string | null>`NULL`.as("forwarded_at"),
      })
      .from(approvalRequests)
      .innerJoin(apps, sql`${apps.id} = ${approvalRequests.appId}`)
      .where(
        sql`${approvalRequests.appId} = ${scope.appId} AND ${approvalRequests.id} = ${review.requestId} AND changes() = 1`,
      ),
  );
}
