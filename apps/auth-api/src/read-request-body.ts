import { DEFAULT_MUTATING_JSON_BODY_MAX_BYTES } from "@splitch/contracts";
import {
  type BoundedBodyFailureReason,
  mediaTypeOf,
  readBoundedRequestBody,
} from "@splitch/worker-runtime";
import { OAuthError, renderOAuthError } from "./oauth-errors";

const JSON_MEDIA_TYPE = "application/json";
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

export const AUTH_REQUEST_MAX_BODY_BYTES = DEFAULT_MUTATING_JSON_BODY_MAX_BYTES;

export type AuthBodyRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: BoundedBodyFailureReason };

export function renderAuthBodyError(reason: BoundedBodyFailureReason): Response {
  return renderOAuthError(
    new OAuthError(
      "invalid_request",
      reason === "too_large" ? "request body is too large" : "unsupported content type",
    ),
  );
}

export async function readJsonRequestBody(request: Request): Promise<AuthBodyRead> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: AUTH_REQUEST_MAX_BODY_BYTES,
    allowedMediaTypes: [JSON_MEDIA_TYPE],
  });
  if (!bounded.ok) return bounded;
  if (bounded.text.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(bounded.text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}

export async function readOAuthRequestBody(request: Request): Promise<AuthBodyRead> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: AUTH_REQUEST_MAX_BODY_BYTES,
    allowedMediaTypes: [JSON_MEDIA_TYPE, FORM_MEDIA_TYPE],
  });
  if (!bounded.ok) return bounded;
  if (mediaTypeOf(request.headers.get("content-type")) === FORM_MEDIA_TYPE) {
    return { ok: true, value: Object.fromEntries(new URLSearchParams(bounded.text)) };
  }
  if (bounded.text.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(bounded.text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}
