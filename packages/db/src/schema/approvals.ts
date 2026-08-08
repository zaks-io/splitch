import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    /**
     * What a `failed` attempt left behind in the target: `rolled_back`,
     * `applied`, or `unknown`. Recorded because an exact-key replay has to
     * repeat the first response, and no other column carries it: one
     * `error_code` reaches this table from both sides of a mutation.
     *
     * NULL on every other outcome, which never attempted the target and says so
     * in `outcome`, and on `failed` rows written before this column existed.
     */
    targetState: text("target_state"),
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
