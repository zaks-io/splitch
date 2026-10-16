import { and, eq } from "drizzle-orm";
import { approvalRequests } from "../schema/index";
import { type AuditContext, auditInsert } from "./audit-event-write";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";

type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

export function makeCreateApprovalRequest(db: Db) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the insert/race winner paths enforce one exact idempotency decision
  return async function createRequest(
    scope: TenantScope,
    input: Omit<ApprovalRequestInsert, "appId">,
    audit?: AuditContext,
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
      const query = db
        .insert(approvalRequests)
        .values({ ...input, appId: scope.appId })
        .returning();
      const rows = audit
        ? (
            await db.batch([
              query,
              auditInsert(db, scope, {
                ...audit,
                action: input.operation,
                resourceType: "approval_request",
                resourceId: input.id,
                environmentId:
                  (JSON.parse(input.policyContexts) as Array<{ environmentId: string }>)[0]
                    ?.environmentId ?? null,
                targetVersion: input.targetVersion,
                outcome: "pending",
                approvalRequestId: input.id,
              }),
            ])
          )[0]
        : await query;
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
  };
}

export function requestByActorKey(
  db: Db,
  scope: TenantScope,
  proposedBy: string,
  idempotencyKey: string,
) {
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
