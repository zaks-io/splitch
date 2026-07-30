import { and, eq } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import type { ApprovalCommit } from "./approval-types";
import {
  approvalAppliedStatements,
  approvalGuardParams,
  approvalGuardSql,
} from "./experiment-start-approval";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

type ExperimentRow = typeof experiments.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type RunInsert = typeof runs.$inferInsert;

type StartRunExpectedDraft = Pick<
  ExperimentRow,
  "draftAllocation" | "draftSalt" | "draftTargetingRules" | "draftSegmentIds" | "liveRunId"
> & { defaultVariantId: string };

export type StartRunInput = {
  experimentId: string;
  flagId: string;
  expectedDraft: StartRunExpectedDraft;
  run: Omit<
    RunInsert,
    "appId" | "environmentId" | "experimentId" | "runNumber" | "status" | "controlVariantId"
  >;
  endedAt: string;
  updatedAt: string;
  updatedBy?: string | null;
  approval?: ApprovalCommit;
};

export type StartRunResult =
  | { ok: true; run: RunRow; previous: RunRow | null }
  | { ok: false; reason: "experiment_not_found" | "stale_draft" };

export function makeStartRun(
  d1: D1Database,
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
) {
  return async function startRun(scope: EnvScope, input: StartRunInput): Promise<StartRunResult> {
    assertMintedScope(scope);
    assertControlInFrozenVariantSet(input.expectedDraft.defaultVariantId, input.run.variantSet);
    const state = await loadStartState(experimentsTable, runsTable, scope, input);
    if (!state.ok) return state;

    const committed = await runStartBatch(d1, scope, input);
    if (!committed) return { ok: false, reason: "stale_draft" };

    const run = await runsTable.findOne(scope, eq(runs.id, input.run.id));
    if (!run) throw new Error("startRun: committed Run could not be reloaded");
    const previous = state.previous
      ? await runsTable.findOne(scope, eq(runs.id, state.previous.id))
      : null;
    return { ok: true, run, previous: previous ?? state.previous };
  };
}

function assertControlInFrozenVariantSet(controlVariantId: string, variantSetJson: string): void {
  let variantSet: unknown;
  try {
    variantSet = JSON.parse(variantSetJson);
  } catch {
    throw new Error("startRun: frozen Variant set is not valid JSON");
  }
  if (
    !Array.isArray(variantSet) ||
    !variantSet.some(
      (variant) =>
        typeof variant === "object" &&
        variant !== null &&
        "id" in variant &&
        variant.id === controlVariantId,
    )
  ) {
    throw new Error(
      `startRun: Control Variant ${controlVariantId} is absent from the frozen Variant set`,
    );
  }
}

async function loadStartState(
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
  scope: EnvScope,
  input: StartRunInput,
): Promise<
  | { ok: true; previous: RunRow | null }
  | { ok: false; reason: "experiment_not_found" | "stale_draft" }
> {
  const current = await experimentsTable.findOne(scope, eq(experiments.id, input.experimentId));
  if (!current) return { ok: false, reason: "experiment_not_found" };
  if (!hasExpectedDraft(current, input.expectedDraft)) {
    return { ok: false, reason: "stale_draft" };
  }

  const runningRows = await runsTable.findMany(
    scope,
    and(eq(runs.experimentId, input.experimentId), eq(runs.status, "running")),
  );
  if (runningRows.length > 1) {
    throw new Error("startRun: multiple running Runs for one Experiment");
  }
  return { ok: true, previous: runningRows[0] ?? null };
}

async function runStartBatch(
  d1: D1Database,
  scope: EnvScope,
  input: StartRunInput,
): Promise<boolean> {
  const guardParams = startGuardParams(scope, input);
  const batch = await d1.batch([
    endCurrentRunStatement(d1, scope, input, guardParams),
    insertRunStatement(d1, scope, input, guardParams),
    updateExperimentStartedStatement(d1, input, guardParams),
    ...(input.approval ? approvalAppliedStatements(d1, scope, input.approval, input.run.id) : []),
  ]);
  const inserted = batch[1]?.results ?? [];
  const updated = batch[2]?.results ?? [];
  if (inserted.length === 0 && updated.length === 0) return false;
  if (inserted.length !== 1 || updated.length !== 1) {
    throw new Error("startRun: guarded D1 batch produced an inconsistent result");
  }
  // The Approval statements are appended to this same batch but were never
  // inspected, so a Run could start while its Approval Request stayed pending
  // and the caller was still told `ok`. This is the `approvalReviewLanded`
  // equivalent every other Approval write path already has; here the Review
  // insert RETURNs its id, so the evidence is in the batch result itself.
  if (input.approval && (batch[3]?.results ?? []).length !== 1) {
    throw new Error("startRun: the Run started but its Approval Review did not land");
  }
  return true;
}

function endCurrentRunStatement(
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

function insertRunStatement(
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
        targeting_rules,
        confidence_level, decision_family, guardrail_decisions, config_hash,
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
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM experiments WHERE ${startGuardSql(input.approval)})
      RETURNING id
    `,
    )
    .bind(...insertRunParams(scope, input), ...guardParams);
}

function updateExperimentStartedStatement(
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

function hasExpectedDraft(experiment: ExperimentRow, expected: StartRunExpectedDraft): boolean {
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

function startGuardParams(scope: EnvScope, input: StartRunInput): unknown[] {
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
    input.run.confidenceLevel,
    input.run.decisionFamily,
    input.run.guardrailDecisions,
    input.run.configHash,
    input.run.startedAt,
    input.run.startReason ?? null,
    input.run.createdAt,
    input.run.createdBy ?? null,
  ];
}
