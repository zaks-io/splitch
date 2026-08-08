import { and, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import { appMemberships, approvalRequests, approvalReviews, environments } from "../schema/index";
import type { ApprovalCommit, ApprovalPolicyContextGuard } from "./approval-types";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { assertMintedScope } from "./scope";

/**
 * Every App predicate below binds `scope.appId`, never a field off the commit.
 * The scope is a minted, frozen value object the caller had to obtain from
 * `appScope`/`envScope` after authorization; commit fields are just data the
 * caller assembled. Keeping the tenant predicate on the scope makes App
 * isolation a LOCAL invariant of this seam (ADR-0018) instead of a property of
 * whoever happened to construct the commit.
 */

/**
 * The Approval Request is still pending, belongs to this App, and its reviewer
 * and policy preconditions still hold at write time.
 *
 * This is an EXISTS over `approval_requests` alone and it is UNCORRELATED to the
 * row a statement is writing: it proves the Approval Request is the caller's, never
 * that the target row is. Every statement that rides on it still has to carry its
 * own `app_id` predicate on its own target table.
 */
export function approvalPendingCondition(db: Db, scope: TenantScope, commit: ApprovalCommit) {
  assertMintedScope(scope);
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.appId, scope.appId),
          eq(approvalRequests.id, commit.requestId),
          eq(approvalRequests.status, "pending"),
          currentReviewerCondition(db, scope, commit.reviewedBy),
          ...commit.policyContexts.map((context) => currentPolicyCondition(db, scope, context)),
        ),
      ),
  );
}

/**
 * The reviewer still holds a role that may review, checked in D1 at write time.
 * The service layer checks the same thing first so the caller gets the declared
 * `ROLE_NOT_ALLOWED` contract shape; this is the backstop underneath it, because
 * the data-access seam is the security boundary (ADR-0018) and a role can be
 * revoked between the service check and the write.
 */
export function currentReviewerCondition(db: Db, scope: TenantScope, reviewedBy: string) {
  assertMintedScope(scope);
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(appMemberships)
      .where(
        and(
          eq(appMemberships.appId, scope.appId),
          eq(appMemberships.userId, reviewedBy),
          inArray(appMemberships.role, ["owner", "admin"]),
        ),
      ),
  );
}

function currentPolicyCondition(db: Db, scope: TenantScope, context: ApprovalPolicyContextGuard) {
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(environments)
      .where(
        and(
          eq(environments.appId, scope.appId),
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
 * True once this Review attempt's own row exists. Statements that must ride
 * along with a committed Review — secondary target writes appended after it in
 * the same batch — guard on this instead of on a value probe: the Review id is
 * unique per attempt, so a concurrent Review of a *different* request against
 * the same target can never satisfy it.
 */
export function reviewRecorded(db: Db, scope: TenantScope, commit: ApprovalCommit) {
  assertMintedScope(scope);
  return exists(
    db
      .select({ one: sql<number>`1` })
      .from(approvalReviews)
      .where(
        and(
          eq(approvalReviews.appId, scope.appId),
          eq(approvalReviews.id, commit.reviewId),
          eq(approvalReviews.approvalRequestId, commit.requestId),
        ),
      ),
  );
}

/**
 * Append immediately after the canonical target mutation in a D1 batch.
 * SQLite changes() binds the Review to the preceding guarded mutation: if the
 * target or pending-request guard lost a race, no successful Review is written.
 *
 * `changes() = 1` is the only evidence that stays unambiguous under
 * concurrency, so it is the default and every caller should keep it. A value
 * probe ("the row now reads version N+1 stamped at T") can be satisfied by a
 * *different* pending request's commit landing in the same millisecond, which
 * would record an applied Review for a mutation that actually no-op'd.
 */
export function appliedReviewQueries(
  db: Db,
  scope: TenantScope,
  commit: ApprovalCommit,
  mutationEvidence: SQL = sql`changes() = 1`,
) {
  return [
    appliedReviewInsert(db, scope, commit, mutationEvidence),
    appliedRequestUpdate(db, scope, commit),
  ] as const;
}

export function appliedReviewInsert(
  db: Db,
  scope: TenantScope,
  commit: ApprovalCommit,
  mutationEvidence: SQL = sql`changes() = 1`,
) {
  assertMintedScope(scope);
  return (
    db
      .insert(approvalReviews)
      .select(
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
            resultingResourceId: sql<string>`${commit.resultingResourceId}`.as(
              "resulting_resource_id",
            ),
            errorCode: sql<string | null>`NULL`.as("error_code"),
            errorDetails: sql<string | null>`NULL`.as("error_details"),
            targetState: sql<string | null>`NULL`.as("target_state"),
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.appId, scope.appId),
              eq(approvalRequests.id, commit.requestId),
              eq(approvalRequests.status, "pending"),
              mutationEvidence,
            ),
          ),
      )
      // The insert is conditional: an empty result is the per-statement signal
      // that the guard filtered every row and no Review row was recorded.
      .returning({ id: approvalReviews.id })
  );
}

/**
 * Did THIS Review attempt's row land? Every Approval-guarded write batch is a
 * conditional insert: when the guard loses (request no longer pending, reviewer
 * role revoked, Policy level changed, version CAS lost), the target mutation and
 * the Review insert both select zero rows and the batch still succeeds. Callers
 * ask here instead of returning the re-read row as if it had been written, so a
 * lost guard is observable rather than a silent no-op (ADR-0036).
 */
export async function approvalReviewLanded(
  db: Db,
  scope: TenantScope,
  commit: ApprovalCommit,
): Promise<boolean> {
  assertMintedScope(scope);
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(approvalReviews)
    .where(
      and(
        eq(approvalReviews.appId, scope.appId),
        eq(approvalReviews.id, commit.reviewId),
        eq(approvalReviews.approvalRequestId, commit.requestId),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export function appliedRequestUpdate(db: Db, scope: TenantScope, commit: ApprovalCommit) {
  assertMintedScope(scope);
  return db
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
        eq(approvalRequests.appId, scope.appId),
        eq(approvalRequests.id, commit.requestId),
        eq(approvalRequests.status, "pending"),
        reviewRecorded(db, scope, commit),
      ),
    )
    .returning({ id: approvalRequests.id });
}
