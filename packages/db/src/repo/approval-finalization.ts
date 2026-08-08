import { assertMintedScope, type TenantScope } from "./scope";

export interface ApprovalArchiveFinalization {
  requestId: string;
  resolvedAt: string;
  reviewCount: number;
}

export async function finalizeApprovalArchive(
  d1: D1Database,
  scope: TenantScope,
  input: ApprovalArchiveFinalization,
  expectedStatus: "applied" | "declined" | "stale",
): Promise<void> {
  assertMintedScope(scope);
  if (input.reviewCount < 0) throw new Error("Approval archive Review count cannot be negative");
  const results = await d1.batch([
    d1
      .prepare(
        `DELETE FROM approval_reviews
         WHERE app_id = ? AND approval_request_id = ?
           AND EXISTS (
             SELECT 1 FROM approval_requests
             WHERE app_id = ? AND id = ? AND status = ? AND resolved_at = ?
           )
           AND (SELECT COUNT(*) FROM approval_reviews
                WHERE app_id = ? AND approval_request_id = ?) = ?`,
      )
      .bind(
        scope.appId,
        input.requestId,
        scope.appId,
        input.requestId,
        expectedStatus,
        input.resolvedAt,
        scope.appId,
        input.requestId,
        input.reviewCount,
      ),
    d1
      .prepare(
        `DELETE FROM approval_requests
         WHERE app_id = ? AND id = ? AND status = ? AND resolved_at = ?
           AND changes() = ?
           AND NOT EXISTS (
             SELECT 1 FROM approval_reviews
             WHERE app_id = ? AND approval_request_id = ?
           )
         RETURNING id`,
      )
      .bind(
        scope.appId,
        input.requestId,
        expectedStatus,
        input.resolvedAt,
        input.reviewCount,
        scope.appId,
        input.requestId,
      ),
  ]);
  if ((results[1]?.results ?? []).length !== 1) {
    throw new Error(`Approval Request ${input.requestId} archive finalization failed`);
  }
}
