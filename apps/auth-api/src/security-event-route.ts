import { DEFAULT_MUTATING_JSON_BODY_MAX_BYTES } from "@splitch/contracts";
import { readBoundedRequestBody } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import {
  processSecurityEventToken,
  SecurityEventError,
  type SecurityEventDeps,
} from "./security-event-token";

export const SECURITY_EVENT_TOKEN_MAX_BYTES = DEFAULT_MUTATING_JSON_BODY_MAX_BYTES;

export function mountSecurityEventRoute(app: Hono, deps: SecurityEventDeps | undefined): void {
  app.post("/agent/event/notify", (c) => handleSecurityEventRequest(c.req.raw, deps));
}

async function handleSecurityEventRequest(
  request: Request,
  deps: SecurityEventDeps | undefined,
): Promise<Response> {
  if (!deps) return new Response("security event receiver is not configured", { status: 500 });
  const body = await readBoundedRequestBody(request, {
    maxBytes: SECURITY_EVENT_TOKEN_MAX_BYTES,
    allowedMediaTypes: ["application/secevent+jwt"],
  });
  if (!body.ok) {
    return renderSetError(
      body.reason === "too_large" ? "SET exceeds the body limit" : "unsupported media type",
    );
  }
  try {
    await processSecurityEventToken(deps, body.text);
    return new Response(null, { status: 202 });
  } catch (cause) {
    return renderSecurityEventFault(cause);
  }
}

function renderSecurityEventFault(cause: unknown): Response {
  if (cause instanceof SecurityEventError) return renderSetError(cause.message, cause.err);
  console.error("security event receiver fault", cause);
  return new Response(null, { status: 500 });
}

function renderSetError(description: string, err = "invalid_request"): Response {
  return Response.json(
    { err, description },
    { status: 400, headers: { "content-language": "en" } },
  );
}
