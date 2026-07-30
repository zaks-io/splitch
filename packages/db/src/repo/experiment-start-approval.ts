import type { ApprovalCommit } from "./approval-types";
import type { EnvScope } from "./scope";

/**
 * The Approval half of `startRun`: the guard fragment that makes the whole
 * start batch conditional on the Approval Request still being applicable, and
 * the two statements that record the Review and resolve the Request.
 *
 * Every App predicate here binds the MINTED scope's App, never a field off the
 * caller-supplied commit (ADR-0018).
 */

type PolicyContext = ApprovalCommit["policyContexts"][number];

/**
 * Appended to the draft guard so an approved start also requires: the Request is
 * still pending, the reviewer still holds a reviewing role, and each Environment
 * still carries the policy level the Request was raised under.
 */
export function approvalGuardSql(approval: ApprovalCommit): string {
  return `AND EXISTS (
    SELECT 1 FROM approval_requests
    WHERE app_id = ? AND id = ? AND status = 'pending'
  )
  AND EXISTS (
    SELECT 1 FROM app_memberships
    WHERE app_id = ? AND user_id = ? AND role IN ('owner', 'admin')
  )
  ${approval.policyContexts.map(policyGuardSql).join("\n  ")}`;
}

export function approvalGuardParams(appId: string, approval: ApprovalCommit): unknown[] {
  return [
    appId,
    approval.requestId,
    appId,
    approval.reviewedBy,
    ...approval.policyContexts.flatMap((context) => policyGuardParams(appId, context)),
  ];
}

function policyGuardSql(context: PolicyContext): string {
  return `AND EXISTS (
    SELECT 1 FROM environments
    WHERE app_id = ? AND id = ?
      ${context.changeTypes.map((changeType) => `AND json_extract(policy, '${policyPath(changeType)}') = ?`).join("\n      ")}
  )`;
}

function policyGuardParams(appId: string, context: PolicyContext): unknown[] {
  return [appId, context.environmentId, ...context.changeTypes.flatMap(() => [context.level])];
}

function policyPath(changeType: PolicyContext["changeTypes"][number]) {
  switch (changeType) {
    case "variant_availability":
      return "$.variantAvailability";
    case "targeting_rollout_value":
      return "$.targetingRolloutValue";
    case "enabled_state":
      return "$.enabledState";
    case "start_experiment_run":
      return "$.startExperimentRun";
  }
}

/**
 * The Review insert is bound to the Run it authorized (`started_at = ?`) and
 * RETURNs its id, so the caller can see from the batch result alone whether the
 * Review landed alongside the Run.
 */
export function approvalAppliedStatements(
  d1: D1Database,
  scope: EnvScope,
  approval: ApprovalCommit,
  runId: string,
): D1PreparedStatement[] {
  const review = d1
    .prepare(
      `
      INSERT INTO approval_reviews (
        id, app_id, approval_request_id, action, outcome,
        reviewed_by, reviewed_via, reviewed_at, reason,
        idempotency_key, request_hash, resulting_target_version,
        resulting_resource_type, resulting_resource_id, error_code, error_details
      )
      SELECT
        ?, app_id, id, 'approve_and_apply', 'applied',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
      FROM approval_requests
      WHERE app_id = ? AND id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE app_id = ? AND id = ? AND status = 'running' AND started_at = ?
        )
      RETURNING id
    `,
    )
    .bind(
      approval.reviewId,
      approval.reviewedBy,
      approval.reviewedVia,
      approval.reviewedAt,
      approval.reason,
      approval.idempotencyKey,
      approval.requestHash,
      approval.resultingTargetVersion,
      approval.resultingResourceType,
      approval.resultingResourceId,
      scope.appId,
      approval.requestId,
      scope.appId,
      runId,
      approval.reviewedAt,
    );
  const request = d1
    .prepare(
      `
      UPDATE approval_requests
      SET status = 'applied',
          resolved_at = ?,
          resulting_target_version = ?,
          resulting_resource_type = ?,
          resulting_resource_id = ?
      WHERE app_id = ? AND id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM approval_reviews
          WHERE app_id = ? AND id = ? AND approval_request_id = ?
        )
    `,
    )
    .bind(
      approval.reviewedAt,
      approval.resultingTargetVersion,
      approval.resultingResourceType,
      approval.resultingResourceId,
      scope.appId,
      approval.requestId,
      scope.appId,
      approval.reviewId,
      approval.requestId,
    );
  return [review, request];
}
