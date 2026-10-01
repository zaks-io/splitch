import type { privacyRequests } from "../schema/index";
import {
  stagePrivacyExportArtifact,
  type StagePrivacyExportArtifactInput,
} from "./privacy-job-artifacts";
import {
  type PrivacyJobDbRow,
  type PrivacyJobRow,
  type PrivacyJobStatus,
  privacyJobRow,
} from "./privacy-job-row";

export type { PrivacyJobRow, PrivacyJobStatus } from "./privacy-job-row";

export interface BeginEntityPrivacyJobInput {
  readonly requestId: string;
  readonly jobId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly requestType: "export" | "delete";
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly receivedAt: string;
  readonly ackDueAt: string;
  readonly responseDueAt: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly storeStatusJson: string;
  readonly deleteBeforeTs: string | null;
  readonly identityVersion: string;
  readonly idType: string;
  readonly entityFamilyHash: string;
}

type PrivacyRequestRow = typeof privacyRequests.$inferSelect;

export function makePrivacyJobRepo(
  d1: D1Database,
  getPrivacyRequestById: (requestId: string) => Promise<PrivacyRequestRow | null>,
) {
  const getPrivacyJobByRequestId = async (requestId: string): Promise<PrivacyJobRow | null> => {
    const row = await d1
      .prepare(
        `SELECT job_id, request_id, kind, status, store_status_json, delete_before_ts,
           identity_version, id_type, entity_family_hash, lease_expires_at, claim_token, artifact_key, artifact_sha256,
           artifact_expires_at, error_code, created_at, updated_at
         FROM privacy_jobs WHERE request_id = ?`,
      )
      .bind(requestId)
      .first<PrivacyJobDbRow>();
    return row ? privacyJobRow(row) : null;
  };

  return {
    async beginEntityPrivacyJob(input: BeginEntityPrivacyJobInput): Promise<{
      request: PrivacyRequestRow;
      job: PrivacyJobRow;
    }> {
      await insertPrivacyJob(d1, input);
      const request = await getPrivacyRequestById(input.requestId);
      const job = await getPrivacyJobByRequestId(input.requestId);
      if (!request || !job) throw new Error("beginEntityPrivacyJob: durable intake is incomplete");
      return { request, job };
    },
    getPrivacyJobByRequestId,
    async claimPrivacyJob(
      requestId: string,
      now: string,
      leaseExpiresAt: string,
      claimToken: string,
    ): Promise<PrivacyJobRow | null> {
      const row = await d1
        .prepare(
          `UPDATE privacy_jobs
           SET status = 'running', lease_expires_at = ?, claim_token = ?, error_code = NULL, updated_at = ?
           WHERE request_id = ? AND status != 'completed'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           RETURNING job_id, request_id, kind, status, store_status_json, delete_before_ts,
             identity_version, id_type, entity_family_hash, lease_expires_at, claim_token, artifact_key, artifact_sha256,
             artifact_expires_at, error_code, created_at, updated_at`,
        )
        .bind(leaseExpiresAt, claimToken, now, requestId, now)
        .first<PrivacyJobDbRow>();
      return row ? privacyJobRow(row) : null;
    },
    async renewPrivacyJobLease(input: {
      requestId: string;
      claimToken: string;
      leaseExpiresAt: string;
      updatedAt: string;
    }): Promise<string | null> {
      const row = await d1
        .prepare(
          `UPDATE privacy_jobs SET lease_expires_at = ?, updated_at = ?
           WHERE request_id = ? AND status = 'running' AND claim_token = ?
           RETURNING lease_expires_at`,
        )
        .bind(input.leaseExpiresAt, input.updatedAt, input.requestId, input.claimToken)
        .first<{ lease_expires_at: string }>();
      return row?.lease_expires_at ?? null;
    },
    async updatePrivacyJob(input: {
      requestId: string;
      status: PrivacyJobStatus;
      storeStatusJson: string;
      updatedAt: string;
      errorCode?: string | null;
      claimToken: string;
    }): Promise<PrivacyJobRow> {
      await updatePrivacyJob(d1, input);
      const job = await getPrivacyJobByRequestId(input.requestId);
      if (!job) throw new Error("updatePrivacyJob: updated job disappeared");
      return job;
    },
    async completePrivacyExport(input: {
      requestId: string;
      storeStatusJson: string;
      artifactKey: string;
      artifactSha256: string;
      artifactExpiresAt: string;
      updatedAt: string;
      claimToken: string;
    }): Promise<PrivacyJobRow> {
      const [jobResult] = await d1.batch([
        d1
          .prepare(
            `UPDATE privacy_jobs SET status = 'completed', store_status_json = ?,
               lease_expires_at = NULL, claim_token = NULL, artifact_key = ?, artifact_sha256 = ?,
               artifact_expires_at = ?, error_code = NULL, updated_at = ?
             WHERE request_id = ? AND status = 'running' AND claim_token = ?`,
          )
          .bind(
            input.storeStatusJson,
            input.artifactKey,
            input.artifactSha256,
            input.artifactExpiresAt,
            input.updatedAt,
            input.requestId,
            input.claimToken,
          ),
        d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END"),
        d1
          .prepare(
            `UPDATE privacy_requests SET status = 'completed', completed_at = ?, result_json = NULL
             WHERE request_id = ?`,
          )
          .bind(input.updatedAt, input.requestId),
      ]);
      if (jobResult?.meta.changes !== 1) throw new Error("completePrivacyExport: job not found");
      const job = await getPrivacyJobByRequestId(input.requestId);
      if (!job) throw new Error("completePrivacyExport: updated job disappeared");
      return job;
    },
    stagePrivacyExportArtifact: (input: StagePrivacyExportArtifactInput) =>
      stagePrivacyExportArtifact(d1, input),
    async listPrivacyJobsForReconciliation(input: {
      now: string;
      updatedBefore: string;
      limit: number;
    }): Promise<PrivacyJobRow[]> {
      const result = await d1
        .prepare(
          `SELECT job_id, request_id, kind, status, store_status_json, delete_before_ts,
             identity_version, id_type, entity_family_hash, lease_expires_at, claim_token, artifact_key,
             artifact_sha256, artifact_expires_at, error_code, created_at, updated_at
           FROM privacy_jobs
           WHERE ((status IN ('queued', 'failed') AND updated_at <= ?)
             OR (status = 'running' AND lease_expires_at <= ?))
           ORDER BY updated_at, job_id LIMIT ?`,
        )
        .bind(input.updatedBefore, input.now, input.limit)
        .all<PrivacyJobDbRow>();
      return result.results.map(privacyJobRow);
    },
    async listExpiredPrivacyArtifacts(now: string, limit: number): Promise<PrivacyJobRow[]> {
      const result = await d1
        .prepare(
          `SELECT job_id, request_id, kind, status, store_status_json, delete_before_ts,
             identity_version, id_type, entity_family_hash, lease_expires_at, claim_token, artifact_key,
             artifact_sha256, artifact_expires_at, error_code, created_at, updated_at
           FROM privacy_jobs
           WHERE artifact_key IS NOT NULL AND artifact_expires_at <= ?
           ORDER BY artifact_expires_at, job_id LIMIT ?`,
        )
        .bind(now, limit)
        .all<PrivacyJobDbRow>();
      return result.results.map(privacyJobRow);
    },
    async clearPrivacyArtifact(requestId: string, artifactKey: string, updatedAt: string) {
      const result = await d1
        .prepare(
          `UPDATE privacy_jobs SET artifact_key = NULL, artifact_sha256 = NULL,
             artifact_expires_at = NULL, updated_at = ?
           WHERE request_id = ? AND artifact_key = ?`,
        )
        .bind(updatedAt, requestId, artifactKey)
        .run();
      if (result.meta.changes !== 1) throw new Error("clearPrivacyArtifact: artifact not found");
    },
  };
}

async function insertPrivacyJob(d1: D1Database, input: BeginEntityPrivacyJobInput): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO privacy_requests (
           request_id, org_id, app_id, request_type, subject_type, subject_ref,
           requested_by, status, received_at, ack_due_at, response_due_at,
           idempotency_key, request_hash
         ) VALUES (?, ?, ?, ?, 'entity', ?, ?, 'processing', ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO NOTHING`,
      )
      .bind(
        input.requestId,
        input.orgId,
        input.appId,
        input.requestType,
        input.subjectRef,
        input.requestedBy,
        input.receivedAt,
        input.ackDueAt,
        input.responseDueAt,
        input.idempotencyKey,
        input.requestHash,
      ),
    d1
      .prepare(
        `INSERT INTO privacy_jobs (
           job_id, request_id, kind, status, store_status_json, delete_before_ts,
           identity_version, id_type, entity_family_hash, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO NOTHING`,
      )
      .bind(
        input.jobId,
        input.requestId,
        input.requestType,
        input.storeStatusJson,
        input.deleteBeforeTs,
        input.identityVersion,
        input.idType,
        input.entityFamilyHash,
        input.receivedAt,
        input.receivedAt,
      ),
  ]);
}

async function updatePrivacyJob(
  d1: D1Database,
  input: {
    requestId: string;
    status: PrivacyJobStatus;
    storeStatusJson: string;
    updatedAt: string;
    errorCode?: string | null;
    claimToken: string;
  },
): Promise<void> {
  const completedAt = input.status === "completed" ? input.updatedAt : null;
  const [jobResult] = await d1.batch([
    d1
      .prepare(
        `UPDATE privacy_jobs
         SET status = ?, store_status_json = ?,
           lease_expires_at = CASE WHEN ? = 'running' THEN lease_expires_at ELSE NULL END,
           claim_token = CASE WHEN ? = 'running' THEN claim_token ELSE NULL END,
           error_code = ?, updated_at = ?
         WHERE request_id = ? AND status = 'running' AND claim_token = ?`,
      )
      .bind(
        input.status,
        input.storeStatusJson,
        input.status,
        input.status,
        input.errorCode ?? null,
        input.updatedAt,
        input.requestId,
        input.claimToken,
      ),
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END"),
    d1
      .prepare(`UPDATE privacy_requests SET status = ?, completed_at = ? WHERE request_id = ?`)
      .bind(
        input.status === "completed" ? "completed" : "processing",
        completedAt,
        input.requestId,
      ),
  ]);
  if (jobResult?.meta.changes !== 1) throw new Error("updatePrivacyJob: job not found");
}
