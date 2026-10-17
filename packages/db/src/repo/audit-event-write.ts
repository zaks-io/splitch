import { type SQL, sql } from "drizzle-orm";
import { apps, controlPlaneAuditEvents } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";

export interface AuditContext {
  actorRef: string | null;
  actorVia: string | null;
  requestId: string | null;
  changedAt: string;
}

export interface AuditEventInput extends AuditContext {
  action: string;
  resourceType: string;
  resourceId: string;
  environmentId?: string | null;
  targetVersion?: string | null;
  outcome?: string;
  approvalRequestId?: string | null;
  runId?: string | null;
  metadata?: {
    changedFields?: readonly string[];
    reviewId?: string;
    reviewAction?: string;
    resultingTargetVersion?: string | null;
    errorCode?: string | null;
    role?: string;
    previousRole?: string;
    revokedKeyId?: string;
  };
}

// Copy named fields only. Caller payloads, diffs, credential material and reasons never enter the log.
export function auditMetadata(input: AuditEventInput["metadata"]): string {
  return JSON.stringify({
    changedFields: input?.changedFields,
    reviewId: input?.reviewId,
    reviewAction: input?.reviewAction,
    resultingTargetVersion: input?.resultingTargetVersion,
    errorCode: input?.errorCode,
    role: input?.role,
    previousRole: input?.previousRole,
    revokedKeyId: input?.revokedKeyId,
  });
}

/** Append directly after the guarded mutation. changes() belongs to this same D1 batch. */
export function auditInsert(
  db: Db,
  scope: TenantScope,
  event: AuditEventInput,
  options: { evidence?: SQL; targetVersion?: SQL; resourceId?: SQL } = {},
) {
  assertMintedScope(scope);
  return db.insert(controlPlaneAuditEvents).select(
    db
      .select({
        seq: sql<number>`NULL`.as("seq"),
        eventId: sql<string>`${crypto.randomUUID()}`.as("event_id"),
        appId: apps.id,
        environmentId: sql<string | null>`${event.environmentId ?? null}`.as("environment_id"),
        organizationId: apps.organizationId,
        actorRef: sql<string | null>`${event.actorRef}`.as("actor_ref"),
        actorVia: sql<string | null>`${event.actorVia}`.as("actor_via"),
        action: sql<string>`${event.action}`.as("action"),
        resourceType: sql<string>`${event.resourceType}`.as("resource_type"),
        resourceId: sql<string>`${options.resourceId ?? event.resourceId}`.as("resource_id"),
        targetVersion: sql<
          string | null
        >`${options.targetVersion ?? event.targetVersion ?? null}`.as("target_version"),
        outcome: sql<string>`${event.outcome ?? "committed"}`.as("outcome"),
        requestId: sql<string | null>`${event.requestId}`.as("request_id"),
        approvalRequestId: sql<string | null>`${event.approvalRequestId ?? null}`.as(
          "approval_request_id",
        ),
        runId: sql<string | null>`${event.runId ?? null}`.as("run_id"),
        changesJson: sql<string>`${auditMetadata(event.metadata)}`.as("changes_json"),
        changedAt: sql<string>`${event.changedAt}`.as("changed_at"),
        forwardedAt: sql<string | null>`NULL`.as("forwarded_at"),
      })
      .from(apps)
      .where(sql`${apps.id} = ${scope.appId} AND ${options.evidence ?? sql`changes() = 1`}`),
  );
}

export function auditStatement(
  d1: D1Database,
  scope: TenantScope,
  event: AuditEventInput,
  evidence = "changes() = 1",
  parameters: readonly unknown[] = [],
): D1PreparedStatement {
  assertMintedScope(scope);
  return d1
    .prepare(`INSERT INTO control_plane_audit_events (
    event_id, app_id, environment_id, organization_id, actor_ref, actor_via,
    action, resource_type, resource_id, target_version, outcome, request_id,
    approval_request_id, run_id, changes_json, changed_at
  ) SELECT ?, id, ?, organization_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM apps WHERE id = ? AND (${evidence})`)
    .bind(
      crypto.randomUUID(),
      event.environmentId ?? null,
      event.actorRef,
      event.actorVia,
      event.action,
      event.resourceType,
      event.resourceId,
      event.targetVersion ?? null,
      event.outcome ?? "committed",
      event.requestId,
      event.approvalRequestId ?? null,
      event.runId ?? null,
      auditMetadata(event.metadata),
      event.changedAt,
      scope.appId,
      ...parameters,
    );
}
