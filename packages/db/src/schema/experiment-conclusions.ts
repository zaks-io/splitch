import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { approvalRequests } from "./approvals";
import { userRef } from "./columns";
import { runs } from "./experiments";
import { apps, environments } from "./identity";

export const experimentConclusions = sqliteTable(
  "experiment_conclusions",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    experimentId: text("experiment_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    selectedVariant: text("selected_variant").notNull(),
    configHash: text("config_hash").notNull(),
    resultToken: text("result_token").notNull(),
    dataWatermark: text("data_watermark").notNull(),
    resultSnapshot: text("result_snapshot").notNull(),
    decisionFailures: text("decision_failures").notNull(),
    decisionChecks: text("decision_checks").notNull(),
    targetEnvironmentId: text("target_environment_id")
      .notNull()
      .references(() => environments.id),
    targetFlagId: text("target_flag_id").notNull(),
    targetConfigVersion: integer("target_config_version").notNull(),
    proposedFlagConfiguration: text("proposed_flag_configuration").notNull(),
    reason: text("reason"),
    concludedBy: userRef("concluded_by").notNull(),
    concludedVia: text("concluded_via").notNull(),
    concludedAt: text("concluded_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
  },
  (table) => [
    uniqueIndex("experiment_conclusions_run_unique").on(table.runId),
    uniqueIndex("experiment_conclusions_actor_idempotency_unique").on(
      table.appId,
      table.concludedBy,
      table.idempotencyKey,
    ),
  ],
);

export const conclusionApprovalRequests = sqliteTable(
  "conclusion_approval_requests",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    conclusionId: text("conclusion_id")
      .notNull()
      .references(() => experimentConclusions.id),
    approvalRequestId: text("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id),
    ordinal: integer("ordinal").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conclusionId, table.ordinal] }),
    uniqueIndex("conclusion_approval_requests_request_unique").on(table.approvalRequestId),
  ],
);
