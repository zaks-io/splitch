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

  const parsed = output.safeParse(body);
  if (!parsed.success) {
    throw new Error(`control-plane-sdk: ${operationId} returned an invalid response body`);
  }

  return { ok: true, data: parsed.data, status: response.status };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}
