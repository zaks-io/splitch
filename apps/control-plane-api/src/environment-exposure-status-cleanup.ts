import { getRoute } from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";

function registeredCleanupRoute() {
  const route = getRoute("environment_exposure_status_delete");
  if (!route) {
    throw new Error("control-plane-api: Exposure status cleanup route is not registered");
  }
  return route;
}
const cleanupRoute = registeredCleanupRoute();

export interface EnvironmentExposureStatusCleanupInput {
  appId: string;
  environmentId?: string;
  actorId: string;
  orgId: string | null;
  requestId: string;
}

export interface EnvironmentExposureStatusCleanup {
  delete(input: EnvironmentExposureStatusCleanupInput): Promise<void>;
}

export class EnvironmentExposureStatusCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentExposureStatusCleanupError";
  }
}

export function createEnvironmentExposureStatusCleanup(
  analysis: Fetcher | undefined,
): EnvironmentExposureStatusCleanup {
  return {
    delete: (input) => deleteExposureStatus(analysis, input),
  };
}

async function deleteExposureStatus(
  analysis: Fetcher | undefined,
  input: EnvironmentExposureStatusCleanupInput,
): Promise<void> {
  if (!analysis) {
    throw new EnvironmentExposureStatusCleanupError(
      "control-plane-api: ANALYSIS_API is required for Exposure status cleanup",
    );
  }
  try {
    await sendCleanupRequest(analysis, input);
  } catch (cause) {
    if (cause instanceof EnvironmentExposureStatusCleanupError) throw cause;
    throw new EnvironmentExposureStatusCleanupError(
      `control-plane-api: Exposure status cleanup request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

async function sendCleanupRequest(
  analysis: Fetcher,
  input: EnvironmentExposureStatusCleanupInput,
): Promise<void> {
  const response = await analysis.fetch(
    delegatedRequest(
      cleanupRoute,
      {
        operation: cleanupRoute.operationId,
        actorId: input.actorId,
        orgId: input.orgId,
        appId: input.appId,
        environmentId: input.environmentId ?? null,
      },
      {
        params: { appId: input.appId },
        query: input.environmentId === undefined ? {} : { environmentId: input.environmentId },
        requestId: input.requestId,
      },
    ),
  );
  if (!response.ok) {
    throw new EnvironmentExposureStatusCleanupError(
      `control-plane-api: Exposure status cleanup failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.deleted !== true || Object.keys(body).length !== 1) {
    throw new EnvironmentExposureStatusCleanupError(
      "control-plane-api: Exposure status cleanup returned an invalid response",
    );
  }
}
