import {
  type EnvironmentExposureStatusResponse,
  EnvironmentExposureStatusResponseSchema,
  type ErrorResponse,
} from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { rowObject, stringField } from "./results-row-fields";
import { scopedPipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird";

const EXPOSURE_STATUS_PIPE = "environment_exposure_status";
const TINYBIRD_DATETIME64 = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u;

interface ExposureStatusScope {
  appId: string;
  environmentId: string;
}

export interface ExposureStatusDeps {
  tinybird: TinybirdReadTransport;
}

export function makeExposureStatusHandler(deps: ExposureStatusDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = exposureStatusScope(input, principal.appId, principal.environmentId);
      const status = await readExposureStatusFromTinybird(deps.tinybird, scope);
      return Response.json(EnvironmentExposureStatusResponseSchema.parse(status));
    } catch (cause) {
      return renderError(errorFor(cause), { requestId });
    }
  };
}

export async function readExposureStatusFromTinybird(
  tinybird: TinybirdReadTransport,
  scope: ExposureStatusScope,
): Promise<EnvironmentExposureStatusResponse> {
  const rows = await tinybird.readPipe(EXPOSURE_STATUS_PIPE, scopedPipeParams(scope));
  if (rows.length === 0) {
    return { state: "not_received", firstExposureAt: null };
  }
  if (rows.length !== 1) {
    throw new Error("analysis-api: Tinybird returned multiple Environment Exposure status rows");
  }

  const row = rowObject(rows[0]);
  assertScope(row, scope);
  return {
    state: "received",
    firstExposureAt: tinybirdTimestamp(stringField(row, "first_exposure_at")),
  };
}

function exposureStatusScope(
  input: unknown,
  principalAppId: string | null,
  principalEnvironmentId: string | null,
): ExposureStatusScope {
  const params = rowObject(rowObject(input).params);
  const appId = stringField(params, "appId");
  const environmentId = stringField(params, "environmentId");
  if (principalAppId !== appId || principalEnvironmentId !== environmentId) {
    throw new ExposureStatusForbiddenError();
  }
  return { appId, environmentId };
}

function assertScope(row: Record<string, unknown>, scope: ExposureStatusScope): void {
  if (
    stringField(row, "app_id") !== scope.appId ||
    stringField(row, "environment_id") !== scope.environmentId
  ) {
    throw new ExposureStatusIsolationError();
  }
}

function tinybirdTimestamp(value: string): string {
  if (!TINYBIRD_DATETIME64.test(value)) {
    throw new Error("analysis-api: Tinybird returned an invalid first Exposure timestamp");
  }
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("analysis-api: Tinybird returned an invalid first Exposure timestamp");
  }
  return parsed.toISOString();
}

function errorFor(cause: unknown): ErrorResponse {
  if (cause instanceof ExposureStatusForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof TinybirdReadError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "Exposure status is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  if (cause instanceof ExposureStatusIsolationError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "Exposure status isolation failure",
      details: {},
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "Exposure status read failed", details: {} };
}

class ExposureStatusForbiddenError extends Error {
  constructor() {
    super("credential is not scoped to this Environment");
    this.name = "ExposureStatusForbiddenError";
  }
}

class ExposureStatusIsolationError extends Error {
  constructor() {
    super("Tinybird returned a row outside the requested App and Environment scope");
    this.name = "ExposureStatusIsolationError";
  }
}

export type { ExposureStatusScope };
