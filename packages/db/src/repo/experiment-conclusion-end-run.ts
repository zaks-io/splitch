import type { experimentConclusions } from "../schema/index";
import type { EnvScope } from "./scope";

type ConclusionInsert = Omit<typeof experimentConclusions.$inferInsert, "appId">;

/** First statement of the conclusion batch: end the Run under all preconditions. */
export function endRunningRunStatement(
  d1: D1Database,
  scope: EnvScope,
  conclusion: ConclusionInsert,
  expectedLiveRunId: string,
  expectedTargetConfigVersion: number,
) {
  const targetGuard = `EXISTS (
    SELECT 1 FROM flag_configs
    WHERE app_id = ? AND environment_id = ? AND flag_id = ? AND version = ?
  )`;
  const actorGuard = `EXISTS (
    SELECT 1 FROM app_memberships
    WHERE app_id = ? AND user_id = ? AND role IN ('owner', 'admin')
  )`;
  // Tenant-scoped: concurrent Results can INSERT an alarm after the Conclude
  // pre-read and before this batch; refuse the winner promotion.
  const alarmAbsenceGuard = `NOT EXISTS (
    SELECT 1 FROM run_srm_alarms
    WHERE app_id = ? AND environment_id = ? AND run_id = ?
  )`;
  return d1
    .prepare(
      `UPDATE runs SET status = 'ended', ended_at = ?, end_reason = ?
       WHERE app_id = ? AND environment_id = ? AND experiment_id = ? AND id = ?
         AND status = 'running' AND ${targetGuard}
         AND ${actorGuard}
         AND ${alarmAbsenceGuard}
         AND EXISTS (
           SELECT 1 FROM experiments WHERE app_id = ? AND environment_id = ?
             AND id = ? AND live_run_id = ?
         ) RETURNING id`,
    )
    .bind(
      conclusion.concludedAt,
      conclusion.reason ?? null,
      scope.appId,
      scope.environmentId,
      conclusion.experimentId,
      conclusion.runId,
      scope.appId,
      conclusion.targetEnvironmentId,
      conclusion.targetFlagId,
      expectedTargetConfigVersion,
      scope.appId,
      conclusion.concludedBy,
      scope.appId,
      scope.environmentId,
      conclusion.runId,
      scope.appId,
      scope.environmentId,
      conclusion.experimentId,
      expectedLiveRunId,
    );
}
