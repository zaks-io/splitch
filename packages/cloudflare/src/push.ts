import { CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES } from "@splitch/contracts";
import { parseConfigSnapshot } from "@splitch/evaluation-core";
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
  const announced = await state.announceSnapshot(
    parsed.appId,
    parsed.environmentId,
    parsed.environmentVersion,
  );
  if (!announced.ok)
    return Response.json(
      { code: "FORBIDDEN", message: "snapshot crosses the installed Environment scope" },
      { status: 403 },
    );
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
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES
  )
    return bodyTooLarge();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES) {
        await reader.cancel();
        return bodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function bodyTooLarge(): Response {
  return Response.json(
    { code: "VALIDATION_ERROR", message: "snapshot body is too large" },
    { status: 413 },
  );
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

function parseSnapshot(body: string): ReturnType<typeof parseConfigSnapshot> | Response {
  try {
    return parseConfigSnapshot(body, "Cloudflare");
  } catch {
    return Response.json(
      { code: "VALIDATION_ERROR", message: "snapshot body is invalid" },
      { status: 400 },
    );
  }
}
