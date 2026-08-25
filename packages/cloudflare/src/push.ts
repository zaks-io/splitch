import {
  CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES,
  CloudflareConfigSnapshotSchema,
} from "@splitch/contracts";
import { hmacHex, timingSafeHexEqual } from "./crypto";

const CONFIGURATION_PATH = "/integrations/splitch/configuration";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export async function handleConfigurationPush(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== CONFIGURATION_PATH)
    return new Response(null, { status: 404 });
  const body = await readBoundedBody(request);
  if (body instanceof Response) return body;
  const authenticationError = await authenticatePush(
    request.headers,
    body,
    env.SPLITCH_PUSH_SECRET,
  );
  if (authenticationError) return authenticationError;
  const parsed = parseSnapshot(body);
  if (parsed instanceof Response) return parsed;
  const deliveryId = request.headers.get("splitch-delivery-id");
  if (!deliveryId) throw new Error("authenticated configuration push has no delivery ID");
  const state = env.SPLITCH_STATE.getByName(env.SPLITCH_INSTALLATION_ID);
  try {
    const applied = await state.applySnapshot(body, deliveryId);
    if (!applied.ok)
      return Response.json(
        { code: "FORBIDDEN", message: "snapshot crosses the installed Environment scope" },
        { status: 403 },
      );
    return new Response(null, {
      status: 204,
      headers: { "splitch-environment-version": String(applied.environmentVersion) },
    });
  } catch {
    console.error(
      JSON.stringify({
        message: "configuration push failed",
        deliveryId,
        environmentVersion: parsed.environmentVersion,
      }),
    );
    return Response.json(
      { code: "INTERNAL_SERVER_ERROR", message: "snapshot apply failed" },
      { status: 500 },
    );
  }
}

async function readBoundedBody(request: Request): Promise<string | Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES)
    return Response.json(
      { code: "VALIDATION_ERROR", message: "snapshot body is too large" },
      { status: 413 },
    );
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES)
    return Response.json(
      { code: "VALIDATION_ERROR", message: "snapshot body is too large" },
      { status: 413 },
    );
  return body;
}

async function authenticatePush(
  headers: Headers,
  body: string,
  secret: string,
): Promise<Response | null> {
  const deliveryId = headers.get("splitch-delivery-id");
  const timestamp = headers.get("splitch-timestamp");
  const signature = headers.get("splitch-signature")?.replace(/^v1=/, "") ?? null;
  if (!deliveryId || !timestamp || !signature)
    return Response.json(
      { code: "UNAUTHORIZED", message: "push signature is required" },
      { status: 401 },
    );
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1_000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
  )
    return Response.json(
      { code: "UNAUTHORIZED", message: "push timestamp is invalid" },
      { status: 401 },
    );
  const expected = await hmacHex(secret, `${timestamp}.${deliveryId}.${body}`);
  if (!(await timingSafeHexEqual(signature, expected)))
    return Response.json(
      { code: "UNAUTHORIZED", message: "push signature is invalid" },
      { status: 401 },
    );
  return null;
}

function parseSnapshot(
  body: string,
): ReturnType<typeof CloudflareConfigSnapshotSchema.parse> | Response {
  try {
    return CloudflareConfigSnapshotSchema.parse(JSON.parse(body));
  } catch {
    return Response.json(
      { code: "VALIDATION_ERROR", message: "snapshot body is invalid" },
      { status: 400 },
    );
  }
}
