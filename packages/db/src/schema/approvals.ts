import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apps } from "./identity";

/**
 * Durable Approval Requests and append-only Review attempts.
 *
 * Both tables carry app_id so the repository can enforce the same App boundary
 * as every other control-plane resource. Immutable proposal and Review payloads
 * are stored as canonical JSON plus their RFC 8785 hashes.
 */
export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    operation: text("operation").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetVersion: text("target_version").notNull(),
    policyContexts: text("policy_contexts").notNull(),
    diff: text("diff").notNull(),
    status: text("status").notNull(),
    proposedBy: text("proposed_by").notNull(),
    proposedVia: text("proposed_via").notNull(),
    proposedAt: text("proposed_at").notNull(),
    resolvedAt: text("resolved_at"),
    resultingTargetVersion: text("resulting_target_version"),
    resultingResourceType: text("resulting_resource_type"),
    resultingResourceId: text("resulting_resource_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
  },
  (table) => [
    uniqueIndex("approval_requests_actor_idempotency_unique").on(
      table.appId,
      table.proposedBy,
      table.idempotencyKey,
    ),
    index("approval_requests_app_created_idx").on(table.appId, table.proposedAt, table.id),
    index("approval_requests_app_status_idx").on(table.appId, table.status),
    index("approval_requests_app_target_idx").on(table.appId, table.targetType),
  ],
);

export const approvalReviews = sqliteTable(
  "approval_reviews",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    approvalRequestId: text("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedVia: text("reviewed_via").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resultingTargetVersion: text("resulting_target_version"),
    resultingResourceType: text("resulting_resource_type"),
    resultingResourceId: text("resulting_resource_id"),
    errorCode: text("error_code"),
    errorDetails: text("error_details"),
  },
  (table) => [
    uniqueIndex("approval_reviews_actor_idempotency_unique").on(
      table.approvalRequestId,
      table.reviewedBy,
      table.idempotencyKey,
    ),
    index("approval_reviews_request_created_idx").on(
      table.appId,
      table.approvalRequestId,
      table.reviewedAt,
      table.id,
    ),
  ],
);

/**
 * Durable proof that one terminal Approval Request was verified in Tinybird
 * before its D1 Request and Review rows were removed.
 */
export const approvalRequestArchiveCheckpoints = sqliteTable(
  "approval_request_archive_checkpoints",
  {
    approvalRequestId: text("approval_request_id").notNull(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    archiveVersion: integer("archive_version").notNull(),
    contentChecksum: text("content_checksum").notNull(),
    rowCount: integer("row_count").notNull(),
    proposedAt: text("proposed_at").notNull(),
    resolvedAt: text("resolved_at").notNull(),
    archivedAt: text("archived_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "approval_request_archive_checkpoint_identity_pk",
      columns: [table.approvalRequestId, table.archiveVersion],
    }),
    index("approval_request_archive_checkpoints_app_idx").on(
      table.appId,
      table.proposedAt,
      table.approvalRequestId,
    ),
  ],
);
