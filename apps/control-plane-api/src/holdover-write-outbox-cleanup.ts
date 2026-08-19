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

interface HoldoverWriteOutboxCleanupInput {
  appId: string;
  idType?: string;
  targetingKeyHash?: string;
  actorId: string;
  orgId: string | null;
  requestId: string;
}

export interface HoldoverWriteOutboxCleanup {
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
