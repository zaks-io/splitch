import {
  getRoute,
  type MutationNext,
  nextAfterExperimentStart,
  nextAfterFlagShip,
  nextAfterPendingApproval,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { RunRow } from "./experiment-model";

/** Fail loud if a builder ever emits an unregistered operation id. */
function requireRegisteredNext(next: MutationNext): MutationNext {
  if (getRoute(next.tool) === undefined) {
    throw new Error(
      `mutation next.tool ${JSON.stringify(next.tool)} is not a registered operation`,
    );
  }
  return next;
}

/**
 * `next` after a committed Start. Planned duration and target_n must already be
 * frozen on the Run row — inventing either would lie about the decision floor.
 */
export function emitNextAfterExperimentStart(
  appId: string,
  run: Pick<
    RunRow,
    "id" | "experimentId" | "environmentId" | "startedAt" | "plannedDurationDays" | "targetN"
  >,
): MutationNext {
  // Planned duration is always frozen at Start. target_n is sequential-only;
  // fixed-horizon Runs leave it null and still get a results-poll next.
  if (run.plannedDurationDays === null) {
    throw new Error(
      `Run ${run.id} has no frozen plannedDurationDays; refusing to invent a next step`,
    );
  }
  return requireRegisteredNext(
    nextAfterExperimentStart({
      appId,
      environmentId: run.environmentId,
      experimentId: run.experimentId,
      runId: run.id,
      runStartedAt: run.startedAt,
      plannedDurationDays: run.plannedDurationDays,
      targetN: run.targetN,
    }),
  );
}

export function emitNextAfterPendingApproval(
  appId: string,
  approvalRequestId: string,
): MutationNext {
  return requireRegisteredNext(nextAfterPendingApproval({ appId, approvalRequestId }));
}

export async function emitNextAfterFlagShip(
  repo: Repository,
  appId: string,
  environmentId: string,
  flagId: string,
): Promise<MutationNext> {
  const flag = await repo.flags.getFlag(appScope(appId), flagId);
  if (!flag) {
    throw new Error(`Flag ${flagId} missing while building next after Flag ship`);
  }
  return requireRegisteredNext(
    nextAfterFlagShip({
      appId,
      environmentId,
      flagKey: flag.key,
    }),
  );
}
