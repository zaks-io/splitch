import type { ErrorResponse } from "@splitch/contracts";
import { ErrorResponseSchema } from "@splitch/contracts";

export interface ControlPlaneOperationOptions {
  readonly authorization?: string | null;
}

export type ControlPlaneOperationResult<T = unknown> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: ErrorResponse; status: number };

export async function parseControlPlaneResponse<T>(
  response: Response,
  operationId: string,
  output: {
    safeParse(input: unknown): { success: true; data: T } | { success: false; error?: unknown };
  },
): Promise<ControlPlaneOperationResult<T>> {
  const body = await readJson(response);
  const error = ErrorResponseSchema.safeParse(body);

  if (error.success) {
    return { ok: false, error: error.data, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`control-plane-sdk: ${operationId} failed with HTTP ${response.status}`);
  }

  const parsed = output.safeParse(approvalTransitionResponse(operationId, body));
  if (!parsed.success) {
    throw new Error(`control-plane-sdk: ${operationId} returned an invalid response body`);
  }

  return { ok: true, data: parsed.data, status: response.status };
}

/**
 * Deprecated SPL-150 bridge for successful responses from the legacy Approval
 * mutation paths. Remove when the Approval runtime emits the final envelopes.
 */
function approvalTransitionResponse(operationId: string, body: unknown): unknown {
  if (!isRecord(body) || "approvalRequest" in body) {
    return body;
  }

  switch (operationId) {
    case "flag_variants_update":
      return { flag: body, approvalRequest: null };
    case "flag_config_update":
    case "flag_targeting_rules_replace":
      return { config: body, approvalRequest: null };
    case "flags_promote":
    case "experiments_start":
      return { ...body, approvalRequest: null };
    default:
      return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}
