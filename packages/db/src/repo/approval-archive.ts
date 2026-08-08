import { assertMintedScope, type TenantScope } from "./scope";

export interface ApprovalArchiveCheckpoint {
  requestId: string;
  archiveVersion: number;
  contentChecksum: string;
  rowCount: number;
  proposedAt: string;
  resolvedAt: string;
  archivedAt: string;
}

export async function finalizeApprovalArchive(
  d1: D1Database,
  scope: TenantScope,
  checkpoint: ApprovalArchiveCheckpoint,
  expectedStatus: "applied" | "declined" | "stale",
): Promise<void> {
  assertMintedScope(scope);
  const reviewCount = checkpoint.rowCount - 1;
  if (reviewCount < 0) throw new Error("Approval archive row count cannot be below one");
  const checkpointGuard = [
    scope.appId,
    checkpoint.requestId,
    checkpoint.archiveVersion,
    checkpoint.contentChecksum,
    checkpoint.rowCount,
  ] as const;
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO approval_request_archive_checkpoints (
           approval_request_id, app_id, archive_version, content_checksum,
           row_count, proposed_at, resolved_at, archived_at
         )
         SELECT id, app_id, ?, ?, ?, proposed_at, resolved_at, ?
         FROM approval_requests
         WHERE app_id = ? AND id = ? AND status = ? AND resolved_at = ?
           AND (SELECT COUNT(*) FROM approval_reviews
                WHERE app_id = ? AND approval_request_id = ?) = ?
         ON CONFLICT(approval_request_id, archive_version) DO NOTHING`,
      )
      .bind(
        checkpoint.archiveVersion,
        checkpoint.contentChecksum,
        checkpoint.rowCount,
        checkpoint.archivedAt,
        scope.appId,
        checkpoint.requestId,
        expectedStatus,
        checkpoint.resolvedAt,
        scope.appId,
        checkpoint.requestId,
        reviewCount,
      ),
    d1
      .prepare(
        `DELETE FROM approval_reviews
         WHERE app_id = ? AND approval_request_id = ?
           AND EXISTS (
             SELECT 1 FROM approval_request_archive_checkpoints
             WHERE app_id = ? AND approval_request_id = ?
               AND archive_version = ? AND content_checksum = ? AND row_count = ?
           )`,
      )
      .bind(scope.appId, checkpoint.requestId, ...checkpointGuard),
    d1
      .prepare(
        `DELETE FROM approval_requests
         WHERE app_id = ? AND id = ? AND status = ? AND resolved_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM approval_reviews
             WHERE app_id = ? AND approval_request_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM approval_request_archive_checkpoints
             WHERE app_id = ? AND approval_request_id = ?
               AND archive_version = ? AND content_checksum = ? AND row_count = ?
           )
         RETURNING id`,
      )
      .bind(
        scope.appId,
        checkpoint.requestId,
        expectedStatus,
        checkpoint.resolvedAt,
        scope.appId,
        checkpoint.requestId,
        ...checkpointGuard,
      ),
  ]);
  if ((results[2]?.results ?? []).length !== 1) {
    throw new Error(`Approval Request ${checkpoint.requestId} archive finalization failed`);
  }
}
