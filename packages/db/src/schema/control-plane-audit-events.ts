import { isNotNull } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { userRef } from "./columns";

/** Immutable mutation facts, retained until both delivery and the age floor permit pruning. */
export const controlPlaneAuditEvents = sqliteTable(
  "control_plane_audit_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    appId: text("app_id").notNull(),
    environmentId: text("environment_id"),
    organizationId: text("organization_id").notNull(),
    actorRef: userRef("actor_ref"),
    actorVia: text("actor_via"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    targetVersion: text("target_version"),
    outcome: text("outcome").notNull(),
    requestId: text("request_id"),
    approvalRequestId: text("approval_request_id"),
    runId: text("run_id"),
    changesJson: text("changes_json").notNull(),
    changedAt: text("changed_at").notNull(),
    forwardedAt: text("forwarded_at"),
  },
  (table) => [
    index("control_plane_audit_events_pending_idx").on(table.forwardedAt, table.seq),
    index("control_plane_audit_events_app_seq_idx").on(table.appId, table.seq),
    index("control_plane_audit_events_retention_idx")
      .on(table.changedAt)
      .where(isNotNull(table.forwardedAt)),
  ],
);
