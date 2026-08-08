import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { createBootstrapClient } from "./client";

type BootstrapRequest = {
  targetingKey: string;
  attributes?: Record<string, string | number | boolean>;
  idempotencyKey?: string;
};

function parseBootstrapBody(body: unknown): BootstrapRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.targetingKey !== "string") {
    return null;
  }
  const attributes =
    typeof record.attributes === "object" && record.attributes !== null
      ? (record.attributes as Record<string, string | number | boolean>)
      : undefined;
  const idempotencyKey =
    typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined;
  return { targetingKey: record.targetingKey, attributes, idempotencyKey };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * HTTP action that builds the browser client's bootstrap payload via
 * `evaluateAll`. HTTP actions share the action context (including `fetch`)
 * and are the natural SSR/bootstrap hand-off surface
 * (https://docs.convex.dev/functions/http-actions).
 *
 * Uses the API Key from Convex env vars — never embed it in client code
 * (https://docs.convex.dev/production/environment-variables).
 */
const bootstrap = httpAction(async (_ctx, request) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const parsed = parseBootstrapBody(body);
  if (parsed === null) {
    return jsonError("targetingKey is required", 400);
  }

  const client = createBootstrapClient();
  const precomputed = await client.evaluateAll({
    targetingKey: parsed.targetingKey,
    attributes: parsed.attributes,
    idempotencyKey: parsed.idempotencyKey,
  });

  // Byte-for-byte browser bootstrap input: { context, evaluations, etag }.
  return new Response(JSON.stringify(precomputed), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const http = httpRouter();
http.route({
  path: "/splitch/bootstrap",
  method: "POST",
  handler: bootstrap,
});

export default http;
