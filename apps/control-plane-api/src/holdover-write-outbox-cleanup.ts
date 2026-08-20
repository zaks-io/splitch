import { getRoute } from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";

function registeredCleanupRoute() {
  const route = getRoute("holdover_write_outbox_delete");
  if (!route) {
    throw new Error("control-plane-api: holdover write outbox cleanup route is not registered");
  }
  return route;
}
const cleanupRoute = registeredCleanupRoute();

type HoldoverWriteAppDeletionPhase = "prepare" | "finalize" | "cancel" | "mark-d1-deleted";

interface HoldoverWriteOutboxCleanupInput {
  appId: string;
  /** Required for every App deletion phase; absent for Entity deletion. */
  generationId?: string;
  idType?: string;
  targetingKeyHash?: string;
  /** Required for Entity deletion; App deletion uses request time when omitted. */
  deleteBeforeTs?: string;
  /** Required for App deletion phases; ignored for Entity deletion. */
  phase?: HoldoverWriteAppDeletionPhase;
  actorId: string;
  orgId: string | null;
  requestId: string;
}

type HoldoverWriteAppDeletionInput = Omit<
  HoldoverWriteOutboxCleanupInput,
  "phase" | "idType" | "targetingKeyHash" | "generationId"
> & { generationId: string };

export interface HoldoverWriteOutboxCleanup {
  prepare(input: HoldoverWriteAppDeletionInput): Promise<void>;
  markD1Deleted(input: HoldoverWriteAppDeletionInput): Promise<void>;
  finalize(input: HoldoverWriteAppDeletionInput): Promise<void>;
  cancel(input: HoldoverWriteAppDeletionInput): Promise<void>;
  delete(input: HoldoverWriteOutboxCleanupInput): Promise<void>;
}

export class HoldoverWriteOutboxCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoverWriteOutboxCleanupError";
  }
}

export function createHoldoverWriteOutboxCleanup(
  evaluation: Fetcher | undefined,
): HoldoverWriteOutboxCleanup {
  return {
    prepare: (input) => deleteHoldoverWriteOutbox(evaluation, { ...input, phase: "prepare" }),
    markD1Deleted: (input) =>
      deleteHoldoverWriteOutbox(evaluation, { ...input, phase: "mark-d1-deleted" }),
    finalize: (input) => deleteHoldoverWriteOutbox(evaluation, { ...input, phase: "finalize" }),
    cancel: (input) => deleteHoldoverWriteOutbox(evaluation, { ...input, phase: "cancel" }),
    delete: (input) => deleteHoldoverWriteOutbox(evaluation, input),
  };
}

async function deleteHoldoverWriteOutbox(
  evaluation: Fetcher | undefined,
  input: HoldoverWriteOutboxCleanupInput,
): Promise<void> {
  if (!evaluation) {
    throw new HoldoverWriteOutboxCleanupError(
      "control-plane-api: EVALUATION_API is required for holdover write outbox cleanup",
    );
  }
  try {
    await sendCleanupRequest(evaluation, input);
  } catch (cause) {
    if (cause instanceof HoldoverWriteOutboxCleanupError) throw cause;
    throw new HoldoverWriteOutboxCleanupError(
      `control-plane-api: holdover write outbox cleanup request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

async function sendCleanupRequest(
  evaluation: Fetcher,
  input: HoldoverWriteOutboxCleanupInput,
): Promise<void> {
  const query: Record<string, string> = {};
  if (input.idType !== undefined) query.idType = input.idType;
  if (input.targetingKeyHash !== undefined) query.targetingKeyHash = input.targetingKeyHash;
  if (input.deleteBeforeTs !== undefined) query.deleteBeforeTs = input.deleteBeforeTs;
  if (input.phase !== undefined) query.phase = input.phase;
  if (input.generationId !== undefined) query.generationId = input.generationId;
  const response = await evaluation.fetch(
    delegatedRequest(
      cleanupRoute,
      {
        operation: cleanupRoute.operationId,
        actorId: input.actorId,
        orgId: input.orgId,
        appId: input.appId,
        environmentId: null,
      },
      {
        params: { appId: input.appId },
        query,
        requestId: input.requestId,
      },
    ),
  );
  if (!response.ok) {
    throw new HoldoverWriteOutboxCleanupError(
      `control-plane-api: holdover write outbox cleanup failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.deleted !== true || Object.keys(body).length !== 1) {
    throw new HoldoverWriteOutboxCleanupError(
      "control-plane-api: holdover write outbox cleanup returned an invalid response",
    );
  }
}
