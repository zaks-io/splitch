/**
 * Every SQL statement the Start batch runs, and the parameter lists that bind to
 * them. It sits apart from the batch orchestration because the two fail in
 * different ways: a bug here is a column-order or placeholder-count mismatch that
 * only the statement text and its parameter array together can reveal, and they
 * have to be read side by side to be checked at all.
 */

import type { experiments } from "../schema/index";
import type { ApprovalCommit } from "./approval-types";
import { approvalGuardParams, approvalGuardSql } from "./experiment-start-approval";
// Type-only, so it is erased at compile and no runtime cycle exists.
import type { StartRunExpectedDraft, StartRunInput } from "./experiment-start-run";
import type { EnvScope } from "./scope";

type ExperimentRow = typeof experiments.$inferSelect;

export function endCurrentRunStatement(
  d1: D1Database,
  scope: EnvScope,
  input: StartRunInput,
  guardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `
      UPDATE runs
      SET status = 'ended', ended_at = ?
      WHERE app_id = ? AND environment_id = ? AND experiment_id = ? AND status = 'running'
        AND EXISTS (SELECT 1 FROM experiments WHERE ${startGuardSql(input.approval)})
      RETURNING id
    `,
    )
    .bind(input.endedAt, scope.appId, scope.environmentId, input.experimentId, ...guardParams);
}

export function insertRunStatement(
  d1: D1Database,
  scope: EnvScope,
  input: StartRunInput,
  guardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `
      INSERT INTO runs (
        id, app_id, environment_id, experiment_id, run_number, status,
        targeting_key_field, targeting_key_type, salt, allocation, variant_set, control_variant_id,
        targeting_rules, activation_metric_id,
        confidence_level, horizon, sample_size_locked,
        decision_family, guardrail_decisions, config_hash,
        started_at, start_reason, created_at, created_by
      )
      SELECT
        ?, ?, ?, ?,
        (
          SELECT COALESCE(MAX(run_number), 0) + 1
          FROM runs
          WHERE app_id = ? AND environment_id = ? AND experiment_id = ?
        ),
        'running',
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM experiments WHERE ${startGuardSql(input.approval)})
      RETURNING id
    `,
    )
    .bind(...insertRunParams(scope, input), ...guardParams);
}

export function updateExperimentStartedStatement(
  d1: D1Database,
  input: StartRunInput,
  guardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `
      UPDATE experiments
      SET
        status = 'running',
        live_run_id = ?,
        draft_allocation = NULL,
        draft_salt = NULL,
        draft_targeting_rules = NULL,
        draft_segment_ids = NULL,
        updated_at = ?,
        updated_by = ?
      WHERE ${startGuardSql(input.approval)}
      RETURNING id
    `,
    )
    .bind(input.run.id, input.updatedAt, input.updatedBy ?? null, ...guardParams);
}

export function hasExpectedDraft(
  experiment: ExperimentRow,
  expected: StartRunExpectedDraft,
): boolean {
  return (
    expected.draftAllocation !== null &&
    experiment.draftAllocation === expected.draftAllocation &&
    experiment.draftSalt === expected.draftSalt &&
    experiment.draftTargetingRules === expected.draftTargetingRules &&
    experiment.draftSegmentIds === expected.draftSegmentIds &&
    experiment.defaultVariantId === expected.defaultVariantId &&
    experiment.liveRunId === expected.liveRunId
  );
}

const DRAFT_GUARD_SQL = `
  app_id = ?
  AND environment_id = ?
  AND id = ?
  AND draft_allocation = ?
  AND (draft_salt = ? OR (draft_salt IS NULL AND ? IS NULL))
  AND (draft_targeting_rules = ? OR (draft_targeting_rules IS NULL AND ? IS NULL))
  AND (draft_segment_ids = ? OR (draft_segment_ids IS NULL AND ? IS NULL))
  AND default_variant_id = ?
  AND (live_run_id = ? OR (live_run_id IS NULL AND ? IS NULL))
`;

function startGuardSql(approval?: ApprovalCommit): string {
  return `
  ${DRAFT_GUARD_SQL}
  AND NOT EXISTS (
    SELECT 1
    FROM experiments AS blocker
    WHERE blocker.app_id = ?
      AND blocker.environment_id = ?
      AND blocker.flag_id = ?
      AND blocker.status = 'running'
      AND blocker.id <> ?
  )
  ${approval ? approvalGuardSql(approval) : ""}
`;
}

export function startGuardParams(scope: EnvScope, input: StartRunInput): unknown[] {
  return [
    ...draftGuardParams(scope, input.experimentId, input.expectedDraft),
    scope.appId,
    scope.environmentId,
    input.flagId,
    input.experimentId,
    ...(input.approval ? approvalGuardParams(scope.appId, input.approval) : []),
  ];
}

function draftGuardParams(
  scope: EnvScope,
  experimentId: string,
  expected: StartRunExpectedDraft,
): unknown[] {
  return [
    scope.appId,
    scope.environmentId,
    experimentId,
    expected.draftAllocation,
    expected.draftSalt,
    expected.draftSalt,
    expected.draftTargetingRules,
    expected.draftTargetingRules,
    expected.draftSegmentIds,
    expected.draftSegmentIds,
    expected.defaultVariantId,
    expected.liveRunId,
    expected.liveRunId,
  ];
}

function insertRunParams(scope: EnvScope, input: StartRunInput): unknown[] {
  return [
    input.run.id,
    scope.appId,
    scope.environmentId,
    input.experimentId,
    scope.appId,
    scope.environmentId,
    input.experimentId,
    input.run.targetingKeyField,
    input.run.targetingKeyType,
    input.run.salt,
    input.run.allocation,
    input.run.variantSet,
    input.expectedDraft.defaultVariantId,
    input.run.targetingRules,
    input.run.activationMetricId ?? null,
    input.run.confidenceLevel,
    // The Run is the only home for the horizon decision spec, so the column
    // default can never be the answer: `StartRunInput` requires the caller to
    // state it and it is written through unchanged.
    input.run.horizon,
    input.run.sampleSizeLocked ?? null,
    input.run.decisionFamily,
    input.run.guardrailDecisions,
    input.run.configHash,
    input.run.startedAt,
    input.run.startReason ?? null,
    input.run.createdAt,
    input.run.createdBy ?? null,
  ];
}
