import { renderError } from "@splitch/worker-runtime";
import { canonicalHash } from "./approval-canonical";

export function createRequestHash(value: unknown): Promise<`sha256:${string}`> {
  return canonicalHash(value);
}

export function createIdempotencyKey(
  body: Record<string, unknown>,
  request: Request,
): string | undefined {
  const header = request.headers.get("idempotency-key") ?? undefined;
  const field = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
  return header ?? field;
}

export function createIdempotencyConflict(
  resourceType: "app" | "flag",
  idempotencyKey: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "idempotency key was already used for a different payload",
      details: { scope: `${resourceType}_create` as "app_create" | "flag_create", idempotencyKey },
    },
    { requestId },
  );
}
