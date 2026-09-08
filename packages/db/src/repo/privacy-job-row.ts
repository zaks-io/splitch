export type PrivacyJobStatus = "queued" | "running" | "completed" | "failed";

export interface PrivacyJobRow {
  readonly jobId: string;
  readonly requestId: string;
  readonly kind: "export" | "delete";
  readonly status: PrivacyJobStatus;
  readonly storeStatusJson: string;
  readonly deleteBeforeTs: string | null;
  readonly identityVersion: string;
  readonly idType: string | null;
  readonly entityFamilyHash: string | null;
  readonly leaseExpiresAt: string | null;
  readonly artifactKey: string | null;
  readonly artifactSha256: string | null;
  readonly artifactExpiresAt: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrivacyJobDbRow {
  readonly job_id: string;
  readonly request_id: string;
  readonly kind: string;
  readonly status: string;
  readonly store_status_json: string;
  readonly delete_before_ts: string | null;
  readonly identity_version: string;
  readonly id_type: string | null;
  readonly entity_family_hash: string | null;
  readonly lease_expires_at: string | null;
  readonly artifact_key: string | null;
  readonly artifact_sha256: string | null;
  readonly artifact_expires_at: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function privacyJobRow(row: PrivacyJobDbRow): PrivacyJobRow {
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
    idType: row.id_type,
    entityFamilyHash: row.entity_family_hash,
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
