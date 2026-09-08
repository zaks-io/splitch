import type { privacyRequests } from "../schema/index";

export type PrivacyJobStatus = "queued" | "running" | "completed" | "failed";

export interface PrivacyJobRow {
  readonly jobId: string;
  readonly requestId: string;
  readonly kind: "export" | "delete";
  readonly status: PrivacyJobStatus;
  readonly storeStatusJson: string;
  readonly deleteBeforeTs: string | null;
  readonly identityVersion: string;
  readonly leaseExpiresAt: string | null;
  readonly artifactKey: string | null;
  readonly artifactSha256: string | null;
  readonly artifactExpiresAt: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
           identity_version, lease_expires_at, artifact_key, artifact_sha256,
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
    ): Promise<PrivacyJobRow | null> {
      const row = await d1
        .prepare(
          `UPDATE privacy_jobs
           SET status = 'running', lease_expires_at = ?, error_code = NULL, updated_at = ?
           WHERE request_id = ? AND status != 'completed'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           RETURNING job_id, request_id, kind, status, store_status_json, delete_before_ts,
             identity_version, lease_expires_at, artifact_key, artifact_sha256,
             artifact_expires_at, error_code, created_at, updated_at`,
        )
        .bind(leaseExpiresAt, now, requestId, now)
        .first<PrivacyJobDbRow>();
      return row ? privacyJobRow(row) : null;
    },
    async updatePrivacyJob(input: {
      requestId: string;
      status: PrivacyJobStatus;
      storeStatusJson: string;
      updatedAt: string;
      errorCode?: string | null;
    }): Promise<PrivacyJobRow> {
      await updatePrivacyJob(d1, input);
      const job = await getPrivacyJobByRequestId(input.requestId);
      if (!job) throw new Error("updatePrivacyJob: updated job disappeared");
      return job;
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
           identity_version, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO NOTHING`,
      )
      .bind(
        input.jobId,
        input.requestId,
        input.requestType,
        input.storeStatusJson,
        input.deleteBeforeTs,
        input.identityVersion,
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
  },
): Promise<void> {
  const completedAt = input.status === "completed" ? input.updatedAt : null;
  const [jobResult] = await d1.batch([
    d1
      .prepare(
        `UPDATE privacy_jobs
         SET status = ?, store_status_json = ?,
           lease_expires_at = CASE WHEN ? = 'running' THEN lease_expires_at ELSE NULL END,
           error_code = ?, updated_at = ? WHERE request_id = ?`,
      )
      .bind(
        input.status,
        input.storeStatusJson,
        input.status,
        input.errorCode ?? null,
        input.updatedAt,
        input.requestId,
      ),
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

interface PrivacyJobDbRow {
  readonly job_id: string;
  readonly request_id: string;
  readonly kind: string;
  readonly status: string;
  readonly store_status_json: string;
  readonly delete_before_ts: string | null;
  readonly identity_version: string;
  readonly lease_expires_at: string | null;
  readonly artifact_key: string | null;
  readonly artifact_sha256: string | null;
  readonly artifact_expires_at: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function privacyJobRow(row: PrivacyJobDbRow): PrivacyJobRow {
  if ((row.kind !== "export" && row.kind !== "delete") || !isPrivacyJobStatus(row.status)) {
    throw new Error("privacy job row has an invalid kind or status");
  }
  return {
    jobId: row.job_id,
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    storeStatusJson: row.store_status_json,
    deleteBeforeTs: row.delete_before_ts,
    identityVersion: row.identity_version,
    leaseExpiresAt: row.lease_expires_at,
    artifactKey: row.artifact_key,
    artifactSha256: row.artifact_sha256,
    artifactExpiresAt: row.artifact_expires_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isPrivacyJobStatus(value: string): value is PrivacyJobStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed";
}
