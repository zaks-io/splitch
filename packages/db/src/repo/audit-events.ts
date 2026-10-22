import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { controlPlaneAuditEvents } from "../schema/control-plane-audit-events";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";

export type AuditEventRow = typeof controlPlaneAuditEvents.$inferSelect;

export function buildPendingAuditEventsPredicate(scope?: TenantScope) {
  if (scope) assertMintedScope(scope);
  return and(
    isNull(controlPlaneAuditEvents.forwardedAt),
    scope ? eq(controlPlaneAuditEvents.appId, scope.appId) : undefined,
  );
}

export function makeAuditEventRepo(db: Db, d1: D1Database) {
  return {
    // System delivery sweep; a returned row carries the App scope for acknowledgment.
    listPending(limit: number, scope?: TenantScope): Promise<AuditEventRow[]> {
      if (scope) assertMintedScope(scope);
      return db
        .select()
        .from(controlPlaneAuditEvents)
        .where(buildPendingAuditEventsPredicate(scope))
        .orderBy(asc(controlPlaneAuditEvents.seq))
        .limit(limit);
    },
    async markForwarded(scope: TenantScope, eventIds: string[], forwardedAt: string) {
      assertMintedScope(scope);
      if (eventIds.length === 0) return;
      await db
        .update(controlPlaneAuditEvents)
        .set({ forwardedAt })
        .where(
          and(
            eq(controlPlaneAuditEvents.appId, scope.appId),
            inArray(controlPlaneAuditEvents.eventId, eventIds),
            isNull(controlPlaneAuditEvents.forwardedAt),
          ),
        );
    },
    async pruneBefore(input: { changedBefore: string; limit: number }): Promise<number> {
      const result = await d1
        .prepare(`DELETE FROM control_plane_audit_events WHERE seq IN (
        SELECT seq FROM control_plane_audit_events
        WHERE changed_at < ? AND forwarded_at IS NOT NULL ORDER BY seq LIMIT ?
      ) RETURNING seq`)
        .bind(input.changedBefore, input.limit)
        .all();
      return result.results.length;
    },
    list(scope: TenantScope): Promise<AuditEventRow[]> {
      assertMintedScope(scope);
      return db
        .select()
        .from(controlPlaneAuditEvents)
        .where(eq(controlPlaneAuditEvents.appId, scope.appId))
        .orderBy(asc(controlPlaneAuditEvents.seq));
    },
  };
}
