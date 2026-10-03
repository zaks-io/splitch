import type { ApprovalRequest } from "@splitch/contracts";
import type { EnvScope } from "@splitch/db";
import type { ExperimentDeps } from "./experiment-handler-shared";
import type { ExperimentRow, RunRow } from "./experiment-model";
import { jsonArray, runResponse } from "./experiment-model";
import { emitNextAfterExperimentStart } from "./mutation-next-emit";

/** Wire body for a committed Start (direct door or Approval-applied). */
export function experimentStartResponse(input: {
  experimentId: ExperimentRow["id"] | string;
  run: RunRow;
  previousRunId: string | null;
  approvalRequest: ApprovalRequest | null;
  appId: string;
  runSnapshotShipped?: boolean;
}) {
  const next = emitNextAfterExperimentStart(input.appId, input.run);
  return {
    experimentId: input.experimentId,
    run: runResponse(input.run),
    previousRunId: input.previousRunId,
    approvalRequest: input.approvalRequest,
    ...(input.runSnapshotShipped !== undefined
      ? { runSnapshotShipped: input.runSnapshotShipped }
      : {}),
    // Same snapshot the committed Run row holds (and evaluation reads).
    frozenTargetingRules: jsonArray(input.run.targetingRules),
    ...(next !== null ? { next } : {}),
  };
}

/**
 * Only reached for an `applied` Approval Request, so the application result and
 * the Run it names both have to exist. A 404 here would blame a missing
 * Experiment for what is really a broken applied record, so it fails loud
 * instead (ADR-0036).
 */
export async function appliedExperimentStartResponse(
  deps: ExperimentDeps,
  scope: EnvScope,
  experimentId: string,
  approvalRequest: ApprovalRequest,
) {
  const result = approvalRequest.applicationResult;
  if (!result) {
    throw new Error(`applied Approval Request ${approvalRequest.id} carries no application result`);
  }
  const run = await deps.repo.experiments.getRun(scope, result.resourceId);
  if (!run) {
    throw new Error(
      `applied Approval Request ${approvalRequest.id} names Run ${result.resourceId}, which does not exist`,
    );
  }
  const previousRunId = approvalRequest.diff.current.liveRunId;
  return Response.json(
    experimentStartResponse({
      experimentId,
      run,
      previousRunId: typeof previousRunId === "string" ? previousRunId : null,
      approvalRequest,
      appId: scope.appId,
    }),
  );
}
