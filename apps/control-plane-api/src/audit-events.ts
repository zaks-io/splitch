import { canonicalJson } from "@splitch/contracts";
import { type AuditEventRow, appScope, type Repository, type TenantScope } from "@splitch/db";
import { appendAuditLogRows } from "./approval-archive-tinybird";
import type { ControlPlaneApiEnv } from "./env";

const FORWARD_BATCH = 50;

export function auditLogEvent(row: AuditEventRow) {
  return {
    audit_id: row.eventId,
    dedup_key: row.eventId,
    app_id: row.appId,
    user_id: row.actorRef ?? "unattributed",
    auth_method: row.actorVia ?? "unattributed",
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    changes: canonicalJson({
      environmentId: row.environmentId,
      organizationId: row.organizationId,
      targetVersion: row.targetVersion,
      outcome: row.outcome,
      requestId: row.requestId,
      approvalRequestId: row.approvalRequestId,
      runId: row.runId,
      metadata: JSON.parse(row.changesJson),
    }),
    timestamp: row.changedAt,
  };
}

/** A failed or lost acknowledgment leaves every row eligible for the next minute cron. */
export async function forwardAuditEvents(input: {
  repo: Repository;
  env: ControlPlaneApiEnv;
  scope?: TenantScope;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): Promise<number> {
  const rows = await input.repo.auditEvents.listPending(FORWARD_BATCH, input.scope);
  if (rows.length === 0) return 0;
  await appendAuditLogRows(input.env, rows.map(auditLogEvent), input.fetchFn);
  const byApp = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byApp.get(row.appId) ?? [];
    ids.push(row.eventId);
    byApp.set(row.appId, ids);
  }
  const forwardedAt = (input.now?.() ?? new Date()).toISOString();
  for (const [appId, eventIds] of byApp) {
    await input.repo.auditEvents.markForwarded(appScope(appId), eventIds, forwardedAt);
  }
  return rows.length;
}
