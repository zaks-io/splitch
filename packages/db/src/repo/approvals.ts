import { and, desc, eq, exists, inArray, sql } from "drizzle-orm";
import { approvalRequests, approvalReviews } from "../schema/index";
import { currentReviewerCondition } from "./approval-atomic";
import type { ApprovalDisposition, ApprovalFailure } from "./approval-types";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { assertMintedScope } from "./scope";

type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

export interface ApprovalPageFilters {
  /** Persisted `status` values the page may contain. */
  storedStatus?: readonly string[];
  targetType?: string;
}

function pageFilters(
  filters: ApprovalPageFilters & { after?: { proposedAt: string; id: string } },
) {
  const conditions = [];
  if (filters.storedStatus) {
    conditions.push(inArray(approvalRequests.status, [...filters.storedStatus]));
  }
  if (filters.targetType) conditions.push(eq(approvalRequests.targetType, filters.targetType));
  // Keyset continuation on the (proposed_at desc, id desc) ordering. Unlike an
  // offset into a post-filtered array it stays valid when rows around the
  // cursor change status between pages.
  if (filters.after) {
    conditions.push(
      sql`(${approvalRequests.proposedAt}, ${approvalRequests.id}) < (${filters.after.proposedAt}, ${filters.after.id})`,
    );
  }
  return conditions;
}

export function makeApprovalRepo(db: Db) {
  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the insert/race winner paths enforce one exact idempotency decision
    async createRequest(
      scope: TenantScope,
      input: Omit<ApprovalRequestInsert, "appId">,
    ): Promise<
      | { ok: true; request: typeof approvalRequests.$inferSelect; replay: boolean }
      | { ok: false; reason: "idempotency_conflict" }
    > {
      assertMintedScope(scope);
      const existing = await requestByActorKey(db, scope, input.proposedBy, input.idempotencyKey);
      if (existing) {
        return existing.requestHash === input.requestHash
          ? { ok: true, request: existing, replay: true }
          : { ok: false, reason: "idempotency_conflict" };
      }

      try {
        const rows = await db
          .insert(approvalRequests)
          .values({ ...input, appId: scope.appId })
          .returning();
        const request = rows[0];
        if (!request) throw new Error("createRequest: no Approval Request returned");
        return { ok: true, request, replay: false };
      } catch (cause) {
        const winner = await requestByActorKey(db, scope, input.proposedBy, input.idempotencyKey);
        if (!winner) throw cause;
        return winner.requestHash === input.requestHash
          ? { ok: true, request: winner, replay: true }
          : { ok: false, reason: "idempotency_conflict" };
      }
    },

    getRequest(scope: TenantScope, requestId: string) {
      assertMintedScope(scope);
      return db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.appId, scope.appId), eq(approvalRequests.id, requestId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    getRequestByActorKey(scope: TenantScope, proposedBy: string, idempotencyKey: string) {
      assertMintedScope(scope);
      return requestByActorKey(db, scope, proposedBy, idempotencyKey);
    },

    /**
     * One page of Approval Requests, filtered and bounded in SQL. Reading every
     * request in the App and slicing in the Worker costs ~1+3N subrequests, so
     * list breaks permanently once an App accumulates a few hundred lifetime
     * requests and there is no API-side recovery from that.
     *
     * `storedStatus` filters the persisted column only. Effective staleness is
     * recomputed per row on read and cannot be pushed down, so the caller
     * filters that after projecting the page.
     */
    listRequestPage(
      scope: TenantScope,
      page: ApprovalPageFilters & { limit: number; after?: { proposedAt: string; id: string } },
    ) {
      assertMintedScope(scope);
      return db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.appId, scope.appId), ...pageFilters(page)))
        .orderBy(desc(approvalRequests.proposedAt), desc(approvalRequests.id))
        .limit(page.limit);
    },

    async countRequests(scope: TenantScope, filters: ApprovalPageFilters): Promise<number> {
      assertMintedScope(scope);
      const rows = await db
        .select({ total: sql<number>`count(*)` })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.appId, scope.appId), ...pageFilters(filters)));
      return rows[0]?.total ?? 0;
    },

    latestReview(scope: TenantScope, requestId: string) {
      assertMintedScope(scope);
      return db
        .select()
        .from(approvalReviews)
        .where(
          and(
            eq(approvalReviews.appId, scope.appId),
            eq(approvalReviews.approvalRequestId, requestId),
          ),
        )
        .orderBy(desc(approvalReviews.reviewedAt), desc(approvalReviews.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    reviewByActorKey(
      scope: TenantScope,
      requestId: string,
      reviewedBy: string,
      idempotencyKey: string,
    ) {
      assertMintedScope(scope);
      return db
        .select()
        .from(approvalReviews)
        .where(
          and(
            eq(approvalReviews.appId, scope.appId),
            eq(approvalReviews.approvalRequestId, requestId),
            eq(approvalReviews.reviewedBy, reviewedBy),
            eq(approvalReviews.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    async resolveWithoutApplication(
      scope: TenantScope,
      disposition: ApprovalDisposition,
    ): Promise<boolean> {
      assertMintedScope(scope);
      const results = await db.batch(dispositionQueries(db, scope, disposition));
      return results[1].length === 1;
    },

    async recordFailure(scope: TenantScope, failure: ApprovalFailure): Promise<boolean> {
      assertMintedScope(scope);
      const rows = await failureInsert(db, scope, failure).returning({ id: approvalReviews.id });
      return rows.length === 1;
    },
  };
}

function failureInsert(db: Db, scope: TenantScope, failure: ApprovalFailure) {
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
function dispositionQueries(db: Db, scope: TenantScope, disposition: ApprovalDisposition) {
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

function requestByActorKey(db: Db, scope: TenantScope, proposedBy: string, idempotencyKey: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.appId, scope.appId),
        eq(approvalRequests.proposedBy, proposedBy),
        eq(approvalRequests.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
