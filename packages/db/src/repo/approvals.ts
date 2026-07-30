import { and, desc, eq, exists, sql } from "drizzle-orm";
import { approvalRequests, approvalReviews } from "../schema/index";
import type { ApprovalDisposition, ApprovalFailure } from "./approval-types";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { assertMintedScope } from "./scope";

type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

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

    listRequests(scope: TenantScope) {
      assertMintedScope(scope);
      return db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.appId, scope.appId))
        .orderBy(desc(approvalRequests.proposedAt), desc(approvalRequests.id));
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
      const results = await db.batch(dispositionQueries(db, disposition));
      return results[1].length === 1;
    },

    async recordFailure(scope: TenantScope, failure: ApprovalFailure): Promise<boolean> {
      assertMintedScope(scope);
      const rows = await db
        .insert(approvalReviews)
        .select(
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
        )
        .returning({ id: approvalReviews.id });
      return rows.length === 1;
    },
  };
}

function dispositionQueries(db: Db, disposition: ApprovalDisposition) {
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
            eq(approvalRequests.appId, disposition.appId),
            eq(approvalRequests.id, disposition.requestId),
            eq(approvalRequests.status, "pending"),
          ),
        ),
    )
    .returning({ id: approvalReviews.id });
  const update = db
    .update(approvalRequests)
    .set({ status: disposition.outcome, resolvedAt: disposition.reviewedAt })
    .where(
      and(
        eq(approvalRequests.appId, disposition.appId),
        eq(approvalRequests.id, disposition.requestId),
        eq(approvalRequests.status, "pending"),
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(approvalReviews)
            .where(eq(approvalReviews.id, disposition.reviewId)),
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
