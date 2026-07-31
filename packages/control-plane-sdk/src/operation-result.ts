import type { ErrorResponse } from "@splitch/contracts";
import { ErrorResponseSchema } from "@splitch/contracts";

export interface ControlPlaneOperationOptions {
  readonly authorization?: string | null;
  /**
   * Idempotency key for a route whose contract declares one but gives it no
   * request body to travel in — the DELETE mutations. Body-carrying routes take
   * the key from `idempotency_key` on the input instead, so there is exactly one
   * key per call either way.
   */
  readonly idempotencyKey?: string;
}

/**
 * Options for a body-less `idempotency: "required"` route. Every other required
 * route gets a compile error from a non-optional `idempotency_key` schema field;
 * these two carry the key out-of-band, so the type has to carry the requirement
 * (SPL-266).
 *
 * Every method taking this type reads the key as `callOptions?.idempotencyKey`
 * despite the parameter being non-optional. That is deliberate: an untyped or JS
 * caller passing nothing must get the named `IdempotencyKeyRequiredError` from
 * `withIdempotencyHeader`, not a `TypeError`. Do not tidy the `?.` away to match
 * the signature.
 */
export interface ControlPlaneIdempotentOperationOptions extends ControlPlaneOperationOptions {
  readonly idempotencyKey: string;
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
