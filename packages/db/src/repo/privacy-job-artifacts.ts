export interface StagePrivacyExportArtifactInput {
  requestId: string;
  artifactKey: string;
  artifactExpiresAt: string;
  updatedAt: string;
  claimToken: string;
}

export async function stagePrivacyExportArtifact(
  d1: D1Database,
  input: StagePrivacyExportArtifactInput,
): Promise<void> {
  const result = await d1
    .prepare(
      `UPDATE privacy_jobs SET artifact_key = ?, artifact_sha256 = NULL,
         artifact_expires_at = ?, updated_at = ?
       WHERE request_id = ? AND status = 'running' AND claim_token = ?`,
    )
    .bind(
      input.artifactKey,
      input.artifactExpiresAt,
      input.updatedAt,
      input.requestId,
      input.claimToken,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error("stagePrivacyExportArtifact: lease was lost");
}
