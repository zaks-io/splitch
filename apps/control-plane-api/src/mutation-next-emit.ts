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
 * `next` after a committed Start. Planned duration must already be frozen on
 * the Run — inventing one would lie about the decision floor. Pre-migration
 * Runs (before 0035) legitimately have `plannedDurationDays` null; omit `next`
 * rather than failing a successful Start replay.
 */
export function emitNextAfterExperimentStart(
  appId: string,
  run: Pick<
    RunRow,
    "id" | "experimentId" | "environmentId" | "startedAt" | "plannedDurationDays" | "targetN"
  >,
): MutationNext | null {
  // target_n is sequential-only; fixed-horizon Runs leave it null and still get
  // a results-poll next when planned duration is present.
  if (run.plannedDurationDays === null) return null;
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
