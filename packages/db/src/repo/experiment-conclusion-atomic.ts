import type { approvalRequests, experimentConclusions } from "../schema/index";
import type { EnvScope } from "./scope";

type ConclusionInsert = Omit<typeof experimentConclusions.$inferInsert, "appId">;
type ApprovalInsert = Omit<typeof approvalRequests.$inferInsert, "appId">;

export interface CommitConclusionInput {
  conclusion: ConclusionInsert;
  approval: ApprovalInsert;
  expectedLiveRunId: string;
  expectedTargetConfigVersion: number;
}

export interface CreateReplacementPromotionInput {
  conclusionId: string;
  previousApprovalRequestId: string;
  ordinal: number;
  approval: ApprovalInsert;
  targetEnvironmentId: string;
  targetFlagId: string;
  expectedTargetConfigVersion: number;
  previousTargetVersion: string;
  currentTargetVersion: string;
  createdAt: string;
}

export function conclusionStatements(
  d1: D1Database,
  scope: EnvScope,
  input: CommitConclusionInput,
) {
  const c = input.conclusion;
  const targetGuard = `EXISTS (
    SELECT 1 FROM flag_configs
    WHERE app_id = ? AND environment_id = ? AND flag_id = ? AND version = ?
  )`;
  const targetParams = [
    scope.appId,
    c.targetEnvironmentId,
    c.targetFlagId,
    input.expectedTargetConfigVersion,
  ];
  const actorGuard = `EXISTS (
    SELECT 1 FROM app_memberships
    WHERE app_id = ? AND user_id = ? AND role IN ('owner', 'admin')
  )`;
  return [
    d1
      .prepare(
        `UPDATE runs SET status = 'ended', ended_at = ?, end_reason = ?
         WHERE app_id = ? AND environment_id = ? AND experiment_id = ? AND id = ?
           AND status = 'running' AND ${targetGuard}
           AND ${actorGuard}
           AND EXISTS (
             SELECT 1 FROM experiments WHERE app_id = ? AND environment_id = ?
               AND id = ? AND live_run_id = ?
           ) RETURNING id`,
      )
      .bind(
        c.concludedAt,
        c.reason ?? null,
        scope.appId,
        scope.environmentId,
        c.experimentId,
        c.runId,
        ...targetParams,
        scope.appId,
        c.concludedBy,
        scope.appId,
        scope.environmentId,
        c.experimentId,
        input.expectedLiveRunId,
      ),
    d1
      .prepare(
        `UPDATE experiments SET status = 'draft', live_run_id = NULL, updated_at = ?, updated_by = ?
         WHERE changes() = 1
           AND app_id = ? AND environment_id = ? AND id = ? AND live_run_id = ?
           AND ${targetGuard}
           AND EXISTS (
             SELECT 1 FROM runs WHERE app_id = ? AND environment_id = ? AND id = ?
               AND experiment_id = ? AND status = 'ended' AND ended_at = ?
           ) RETURNING id`,
      )
      .bind(
        c.concludedAt,
        c.concludedBy,
        scope.appId,
        scope.environmentId,
        c.experimentId,
        input.expectedLiveRunId,
        ...targetParams,
        scope.appId,
        scope.environmentId,
        c.runId,
        c.experimentId,
        c.concludedAt,
      ),
    conclusionInsertStatement(d1, scope, c),
    approvalInsertStatement(
      d1,
      scope.appId,
      input.approval,
      "EXISTS (SELECT 1 FROM experiment_conclusions WHERE app_id = ? AND id = ?)",
      [scope.appId, c.id],
    ),
    d1
      .prepare(
        `INSERT INTO conclusion_approval_requests
         (app_id, conclusion_id, approval_request_id, ordinal, created_at)
         SELECT ?, ?, ?, 1, ? WHERE changes() = 1 AND EXISTS (
           SELECT 1 FROM approval_requests WHERE app_id = ? AND id = ?
         ) RETURNING approval_request_id`,
      )
      .bind(scope.appId, c.id, input.approval.id, c.concludedAt, scope.appId, input.approval.id),
    atomicAssertion(d1, input.approval.id, c.id, 1),
  ];
}

export function replacementStatements(
  d1: D1Database,
  appId: string,
  input: CreateReplacementPromotionInput,
) {
  const guard = replacementGuard(appId, input);
  return [
    d1
      .prepare(
        `UPDATE approval_requests
         SET status = 'stale', resolved_at = COALESCE(resolved_at, ?)
         WHERE app_id = ? AND id = ? AND status IN ('pending', 'stale')
           AND ${guard.derivedStaleSql}`,
      )
      .bind(input.createdAt, appId, input.previousApprovalRequestId, ...guard.derivedStaleParams),
    approvalInsertStatement(d1, appId, input.approval, guard.sql, guard.params),
    d1
      .prepare(
        `INSERT INTO conclusion_approval_requests
         (app_id, conclusion_id, approval_request_id, ordinal, created_at)
         SELECT ?, ?, ?, ?, ? WHERE changes() = 1 AND EXISTS (
           SELECT 1 FROM approval_requests WHERE app_id = ? AND id = ?
         ) RETURNING approval_request_id`,
      )
      .bind(
        appId,
        input.conclusionId,
        input.approval.id,
        input.ordinal,
        input.createdAt,
        appId,
        input.approval.id,
      ),
    atomicAssertion(d1, input.approval.id, input.conclusionId, input.ordinal),
  ];
}

function conclusionInsertStatement(d1: D1Database, scope: EnvScope, c: ConclusionInsert) {
  return d1
    .prepare(
      `INSERT INTO experiment_conclusions (
        id, app_id, environment_id, experiment_id, run_id, selected_variant, config_hash,
        result_token, data_watermark, result_snapshot, decision_failures, decision_checks,
        target_environment_id, target_flag_id, target_config_version,
        proposed_flag_configuration, reason, concluded_by, concluded_via, concluded_at,
        idempotency_key, request_hash
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1 AND EXISTS (
        SELECT 1 FROM experiments WHERE app_id = ? AND environment_id = ? AND id = ?
          AND live_run_id IS NULL AND updated_at = ?
      ) RETURNING id`,
    )
    .bind(
      c.id,
      scope.appId,
      scope.environmentId,
      c.experimentId,
      c.runId,
      c.selectedVariant,
      c.configHash,
      c.resultToken,
      c.dataWatermark,
      c.resultSnapshot,
      c.decisionFailures,
      c.decisionChecks,
      c.targetEnvironmentId,
      c.targetFlagId,
      c.targetConfigVersion,
      c.proposedFlagConfiguration,
      c.reason ?? null,
      c.concludedBy,
      c.concludedVia,
      c.concludedAt,
      c.idempotencyKey,
      c.requestHash,
      scope.appId,
      scope.environmentId,
      c.experimentId,
      c.concludedAt,
    );
}

function approvalInsertStatement(
  d1: D1Database,
  appId: string,
  approval: ApprovalInsert,
  guardSql: string,
  guardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `INSERT INTO approval_requests (
        id, app_id, operation, target_type, target_id, target_version, policy_contexts,
        policy_guard_contexts, diff,
        status, proposed_by, proposed_via, proposed_at, resolved_at, resulting_target_version,
        resulting_resource_type, resulting_resource_id, idempotency_key, request_hash
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1 AND ${guardSql} RETURNING id`,
    )
    .bind(
      approval.id,
      appId,
      approval.operation,
      approval.targetType,
      approval.targetId,
      approval.targetVersion,
      approval.policyContexts,
      approval.policyGuardContexts ?? null,
      approval.diff,
      approval.status,
      approval.proposedBy,
      approval.proposedVia,
      approval.proposedAt,
      approval.resolvedAt ?? null,
      approval.resultingTargetVersion ?? null,
      approval.resultingResourceType ?? null,
      approval.resultingResourceId ?? null,
      approval.idempotencyKey,
      approval.requestHash,
      ...guardParams,
    );
}

function replacementGuard(appId: string, input: CreateReplacementPromotionInput) {
  const params = [
    input.targetEnvironmentId,
    input.targetFlagId,
    input.expectedTargetConfigVersion,
    appId,
    input.conclusionId,
    input.previousApprovalRequestId,
    input.ordinal - 1,
    input.previousTargetVersion,
    input.currentTargetVersion,
    input.approval.proposedBy,
  ];
  const newerGuard = `NOT EXISTS (
    SELECT 1 FROM conclusion_approval_requests newer
    WHERE newer.app_id = links.app_id AND newer.conclusion_id = links.conclusion_id
      AND newer.ordinal > links.ordinal
  )`;
  const relation = `links.app_id = ? AND links.conclusion_id = ?
    AND links.approval_request_id = ? AND links.ordinal = ?
    AND previous.app_id = links.app_id AND conclusion.app_id = links.app_id
    AND previous.target_version = ? AND previous.target_version <> ?
    AND EXISTS (
      SELECT 1 FROM app_memberships membership
      WHERE membership.app_id = links.app_id AND membership.user_id = ?
        AND membership.role IN ('owner', 'admin')
    )
    AND ${newerGuard}`;
  return {
    sql: `EXISTS (
      SELECT 1 FROM conclusion_approval_requests links
      JOIN approval_requests previous ON previous.id = links.approval_request_id
      JOIN experiment_conclusions conclusion ON conclusion.id = links.conclusion_id
      JOIN flag_configs target ON target.app_id = links.app_id
        AND target.environment_id = ? AND target.flag_id = ? AND target.version = ?
      WHERE ${relation} AND previous.status = 'stale'
    )`,
    params,
    derivedStaleSql: `EXISTS (
      SELECT 1 FROM conclusion_approval_requests links
      JOIN approval_requests previous ON previous.id = links.approval_request_id
      JOIN experiment_conclusions conclusion ON conclusion.id = links.conclusion_id
      JOIN flag_configs target ON target.app_id = links.app_id
        AND target.environment_id = ? AND target.flag_id = ? AND target.version = ?
      WHERE ${relation}
    )`,
    derivedStaleParams: params,
  };
}

function atomicAssertion(
  d1: D1Database,
  approvalRequestId: string,
  conclusionId: string,
  ordinal: number,
) {
  return d1
    .prepare(
      `SELECT CASE WHEN changes() = 1 AND EXISTS (
        SELECT 1 FROM conclusion_approval_requests
        WHERE conclusion_id = ? AND ordinal = ? AND approval_request_id = ?
      ) THEN 1 ELSE json('') END AS committed`,
    )
    .bind(conclusionId, ordinal, approvalRequestId);
}
