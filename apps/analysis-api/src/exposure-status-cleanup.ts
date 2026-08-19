import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { rowObject, stringField } from "./results-row-fields";
import {
  type ExposureStatusDeleteScope,
  TinybirdDeleteError,
  type TinybirdDeleteTransport,
} from "./tinybird-delete";

export interface ExposureStatusCleanupDeps {
  tinybirdDelete: TinybirdDeleteTransport;
}

export function makeExposureStatusCleanupHandler(deps: ExposureStatusCleanupDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = cleanupScope(input, principal.appId, principal.environmentId);
      await deps.tinybirdDelete.deleteExposureStatus(scope);
      return Response.json({ deleted: true as const });
    } catch (cause) {
      return renderError(cleanupError(cause), { requestId });
    }
  };
}

function cleanupScope(
  input: unknown,
  principalAppId: string | null,
  principalEnvironmentId: string | null,
): ExposureStatusDeleteScope {
  const parsed = rowObject(input);
  const appId = stringField(rowObject(parsed.params), "appId");
  const query = rowObject(parsed.query);
  const environmentId = optionalString(query.environmentId, "environmentId");
  if (
    principalAppId !== appId ||
    (environmentId === undefined
      ? principalEnvironmentId !== null
      : principalEnvironmentId !== environmentId)
  ) {
    throw new ExposureStatusCleanupForbiddenError();
  }
  return environmentId === undefined ? { appId } : { appId, environmentId };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`analysis-api: ${name} must be a non-empty string`);
  }
  return value;
}

function cleanupError(cause: unknown): ErrorResponse {
  if (cause instanceof ExposureStatusCleanupForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof TinybirdDeleteError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "Exposure status cleanup is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: "Exposure status cleanup failed",
    details: {},
  };
}

class ExposureStatusCleanupForbiddenError extends Error {
  constructor() {
    super("cleanup identity is not scoped to the requested App and Environment");
    this.name = "ExposureStatusCleanupForbiddenError";
  }
}
