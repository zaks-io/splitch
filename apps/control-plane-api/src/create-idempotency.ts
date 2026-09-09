import { canonicalHash, CanonicalJsonInputError } from "@splitch/contracts";
import { renderError } from "@splitch/worker-runtime";
import { validationErrors } from "./flag-definition-errors";

export async function createRequestHash(
  value: unknown,
  requestId: string,
): Promise<{ ok: true; hash: `sha256:${string}` } | { ok: false; response: Response }> {
  try {
    return { ok: true, hash: await canonicalHash(value) };
  } catch (cause) {
    if (!(cause instanceof CanonicalJsonInputError)) throw cause;
    return {
      ok: false,
      response: validationErrors(requestId, [{ path: ["body"], message: cause.message }]),
    };
  }
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
