import { primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { apps, organizations } from "./identity";

/**
 * Privacy-domain D1 tables: the bounded privacy-request ledger and the Entity
 * deletion tombstone ledger. These store hashes and IDs only, never raw
 * Targeting Keys or email.
 * Source of truth: docs/spec/contracts/storage-schemas-d1-privacy.md.
 */

export const privacyRequests = sqliteTable(
  "privacy_requests",
  {
    requestId: text("request_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    appId: text("app_id").references(() => apps.id),
    requestType: text("request_type").notNull(),
    subjectType: text("subject_type").notNull(),
    // WorkOS user ID, Org/App ID, or JSON array of targeting_key_hash values.
    subjectRef: text("subject_ref").notNull(),
    subjectRefRedactedAt: text("subject_ref_redacted_at"),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull(),
    receivedAt: text("received_at").notNull(),
    ackDueAt: text("ack_due_at").notNull(),
    responseDueAt: text("response_due_at").notNull(),
    completedAt: text("completed_at"),
    denialReason: text("denial_reason"),
    /** Legacy export payload. New jobs keep raw artifacts in private object storage. */
    resultJson: text("result_json"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
  },
  (t) => [
    uniqueIndex("privacy_requests_entity_idempotency_unique").on(
      t.appId,
      t.requestedBy,
      t.requestType,
      t.idempotencyKey,
    ),
  ],
);

export const privacyJobs = sqliteTable("privacy_jobs", {
  jobId: text("job_id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .unique()
    .references(() => privacyRequests.requestId),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  storeStatusJson: text("store_status_json").notNull(),
  deleteBeforeTs: text("delete_before_ts"),
  identityVersion: text("identity_version").notNull(),
  leaseExpiresAt: text("lease_expires_at"),
  artifactKey: text("artifact_key"),
  artifactSha256: text("artifact_sha256"),
  artifactExpiresAt: text("artifact_expires_at"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Entity deletion tombstones for immediate analysis exclusion + async physical
 * purge. The Analysis Worker excludes rows where `server_ts <= delete_before_ts`.
 */
export const entityDeletions = sqliteTable(
  "entity_deletions",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    idType: text("id_type").notNull(),
    targetingKeyHash: text("targeting_key_hash").notNull(),
    deleteBeforeTs: text("delete_before_ts").notNull(),
    requestedAt: text("requested_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.idType, t.targetingKeyHash, t.deleteBeforeTs] })],
);
