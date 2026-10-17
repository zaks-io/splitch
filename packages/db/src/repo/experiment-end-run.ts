import { eq } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import { type AuditContext, auditStatement } from "./audit-event-write";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

type ExperimentRow = typeof experiments.$inferSelect;
type RunRow = typeof runs.$inferSelect;

export type EndRunInput = {
  audit?: AuditContext;
  experimentId: string;
  runId: string;
  expectedLiveRunId: string;
  endedAt: string;
  endReason?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
};

export type EndRunResult =
  | { ok: true; run: RunRow }
  | { ok: false; reason: "run_not_found" | "not_running" };

export function makeEndRun(
  d1: D1Database,
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
) {
  return async function endRun(scope: EnvScope, input: EndRunInput): Promise<EndRunResult> {
    assertMintedScope(scope);
    const state = await loadEndState(experimentsTable, runsTable, scope, input);
    if (!state.ok) return state;

    const committed = await runEndBatch(d1, scope, input, state.run.configHash);
    if (!committed) return { ok: false, reason: "not_running" };

    const run = await runsTable.findOne(scope, eq(runs.id, input.runId));
    if (!run) throw new Error("endRun: committed Run could not be reloaded");
    return { ok: true, run };
  };
}

async function loadEndState(
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
  scope: EnvScope,
  input: EndRunInput,
): Promise<EndRunResult | { ok: true; run: RunRow; experiment: ExperimentRow }> {
  const run = await runsTable.findOne(scope, eq(runs.id, input.runId));
  if (!run || run.experimentId !== input.experimentId) {
    return { ok: false, reason: "run_not_found" };
  }
  if (run.status !== "running") return { ok: false, reason: "not_running" };

  const experiment = await experimentsTable.findOne(scope, eq(experiments.id, input.experimentId));
  if (!experiment || experiment.liveRunId !== input.expectedLiveRunId) {
    return { ok: false, reason: "not_running" };
  }
  return { ok: true, run, experiment };
}

async function runEndBatch(
  d1: D1Database,
  scope: EnvScope,
  input: EndRunInput,
  configHash: string,
): Promise<boolean> {
  const liveGuardParams = liveExperimentGuardParams(scope, input);
  const runGuardParams = runGuardParamsFor(scope, input);
  const batch = await d1.batch([
    endRunStatement(d1, input, runGuardParams, liveGuardParams),
    clearExperimentLiveRunStatement(d1, input, liveGuardParams, runGuardParams),
    auditStatement(d1, scope, {
      actorRef: input.audit?.actorRef ?? input.updatedBy ?? null,
      actorVia: input.audit?.actorVia ?? null,
      requestId: input.audit?.requestId ?? null,
      changedAt: input.endedAt,
      action: "runs_end",
      resourceType: "run",
      resourceId: input.runId,
      environmentId: scope.environmentId,
      runId: input.runId,
      targetVersion: configHash,
    }),
  ]);
  const ended = batch[0]?.results ?? [];
  const updated = batch[1]?.results ?? [];
  if (ended.length === 0 && updated.length === 0) return false;
  if (ended.length !== 1 || updated.length !== 1) {
    throw new Error("endRun: guarded D1 batch produced an inconsistent result");
  }
  return true;
}

function endRunStatement(
  d1: D1Database,
  input: EndRunInput,
  runGuardParams: readonly unknown[],
  liveGuardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `
      UPDATE runs
      SET status = 'ended', ended_at = ?, end_reason = ?
      WHERE ${RUN_GUARD_SQL}
        AND EXISTS (SELECT 1 FROM experiments WHERE ${LIVE_EXPERIMENT_GUARD_SQL})
      RETURNING id
    `,
    )
    .bind(input.endedAt, input.endReason ?? null, ...runGuardParams, ...liveGuardParams);
}

function clearExperimentLiveRunStatement(
  d1: D1Database,
  input: EndRunInput,
  liveGuardParams: readonly unknown[],
  runGuardParams: readonly unknown[],
) {
  return d1
    .prepare(
      `
      UPDATE experiments
      SET status = 'draft', live_run_id = NULL, updated_at = ?, updated_by = ?
      WHERE ${LIVE_EXPERIMENT_GUARD_SQL}
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE ${RUN_ENDED_BY_THIS_REQUEST_SQL}
        )
      RETURNING id
    `,
    )
    .bind(
      input.updatedAt,
      input.updatedBy ?? null,
      ...liveGuardParams,
      ...runGuardParams,
      input.endedAt,
    );
}

const RUN_GUARD_SQL = `
  app_id = ?
  AND environment_id = ?
  AND id = ?
  AND experiment_id = ?
  AND status = 'running'
`;

const RUN_ENDED_BY_THIS_REQUEST_SQL = `
  app_id = ?
  AND environment_id = ?
  AND id = ?
  AND experiment_id = ?
  AND status = 'ended'
  AND ended_at = ?
`;

const LIVE_EXPERIMENT_GUARD_SQL = `
  app_id = ?
  AND environment_id = ?
  AND id = ?
  AND live_run_id = ?
`;

function runGuardParamsFor(scope: EnvScope, input: EndRunInput): unknown[] {
  return [scope.appId, scope.environmentId, input.runId, input.experimentId];
}

function liveExperimentGuardParams(scope: EnvScope, input: EndRunInput): unknown[] {
  return [scope.appId, scope.environmentId, input.experimentId, input.expectedLiveRunId];
}
