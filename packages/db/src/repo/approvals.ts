import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { approvalRequests, approvalReviews } from "../schema/index";
import { type ApprovalArchiveCheckpoint, finalizeApprovalArchive } from "./approval-archive";
import { dispositionQueries, failureInsert } from "./approval-dispositions";
import type { ApprovalDisposition, ApprovalFailure } from "./approval-types";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { assertMintedScope } from "./scope";

type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

export interface ApprovalPageFilters {
  /** Persisted `status` values the page may contain. */
  storedStatus?: readonly string[];
  targetType?: string;
  /**
   * Keep Requests whose stored `policy_contexts` JSON array includes at least
   * one object with this `environmentId`. Narrows within the App; never widens.
   */
  environmentId?: string;
}

function pageFilters(
  filters: ApprovalPageFilters & { after?: { proposedAt: string; id: string } },
) {
  const conditions = [];
  if (filters.storedStatus) {
    conditions.push(inArray(approvalRequests.status, [...filters.storedStatus]));
  }
  if (filters.targetType) conditions.push(eq(approvalRequests.targetType, filters.targetType));
  if (filters.environmentId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(${approvalRequests.policyContexts}) WHERE json_extract(value, '$.environmentId') = ${filters.environmentId})`,
    );
  }
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

function approvalArchiveQueries(db: Db, d1: D1Database) {
  return {
    listReviews(scope: TenantScope, requestId: string) {
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
        .orderBy(asc(approvalReviews.reviewedAt), asc(approvalReviews.id));
    },

    /** System sweep only: each returned row mints its App scope before further access. */
    listArchiveCandidates(resolvedBefore: string, limit: number) {
      return db
        .select()
        .from(approvalRequests)
        .where(
          and(
            inArray(approvalRequests.status, ["applied", "declined", "stale"]),
            isNotNull(approvalRequests.resolvedAt),
            lte(approvalRequests.resolvedAt, resolvedBefore),
          ),
        )
        .orderBy(asc(approvalRequests.resolvedAt), asc(approvalRequests.id))
        .limit(limit);
    },

    finalizeArchive(
      scope: TenantScope,
      checkpoint: ApprovalArchiveCheckpoint,
      expectedStatus: "applied" | "declined" | "stale",
    ) {
      return finalizeApprovalArchive(d1, scope, checkpoint, expectedStatus);
    },
  };
}

export function makeApprovalRepo(db: Db, d1: D1Database) {
  return {
    ...approvalArchiveQueries(db, d1),
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

    /**
     * Writes a `failed` audit row. Unlike the apply and disposition paths this
     * one carries NO reviewer-role condition, because a review that already
     * failed must leave evidence rather than be silently dropped by a role the
     * reviewer lost mid-flight (ADR-0036).
     *
     * That makes one invariant load-bearing: `failure.reviewedBy` MUST be the
     * authenticated reviewer this request was authorized as, never a
     * caller-supplied identity. Nothing in D1 re-checks it here. Attribution of
     * the audit row is only as trustworthy as the caller's principal.
     */
    /**
     * Writes a `failed` audit row. Unlike the apply and disposition paths this
     * one carries NO reviewer-role condition, because a review that already
     * failed must leave evidence rather than be silently dropped by a role the
     * reviewer lost mid-flight (ADR-0036).
     *
     * That makes one invariant load-bearing: `failure.reviewedBy` MUST be the
     * authenticated reviewer this request was authorized as, never a
     * caller-supplied identity. Nothing in D1 re-checks it here. Attribution of
     * the audit row is only as trustworthy as the caller's principal.
     */
    async recordFailure(scope: TenantScope, failure: ApprovalFailure): Promise<boolean> {
      assertMintedScope(scope);
      const rows = await failureInsert(db, scope, failure).returning({ id: approvalReviews.id });
      return rows.length === 1;
    },
  };
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
