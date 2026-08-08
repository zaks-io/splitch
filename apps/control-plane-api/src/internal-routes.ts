import type { ControlPlaneApiEnv } from "./env";

// Deliberately frozen: changing this Durable Object instance name discards checkpoint history.
const CREDENTIAL_CACHE_BACKFILL_INSTANCE_NAME = "schema-v1";

/**
 * Operator- and test-only doors. They sit outside the authenticated app so that
 * neither the deploy gate token nor the local e2e run id can ever be mistaken
 * for a principal.
 */

export async function runCredentialCacheBackfill(env: ControlPlaneApiEnv): Promise<void> {
  await env.CREDENTIAL_CACHE_BACKFILL.getByName(CREDENTIAL_CACHE_BACKFILL_INSTANCE_NAME).fetch(
    "https://backfill/run",
    { method: "POST" },
  );
}

export async function handleCredentialCacheBackfillGate(
  request: Request,
  env: ControlPlaneApiEnv,
  url: URL,
): Promise<Response> {
  if (
    !env.SPLITCH_DEPLOY_GATE_TOKEN ||
    request.headers.get("authorization") !== `Bearer ${env.SPLITCH_DEPLOY_GATE_TOKEN}`
  ) {
    return new Response("not found", { status: 404 });
  }
  const suffix = url.pathname.replace("/internal/credential-cache-backfill", "") || "/status";
  if (
    (suffix !== "/run" && suffix !== "/status") ||
    (suffix === "/run" && request.method !== "POST")
  ) {
    return new Response("not found", { status: 404 });
  }
  return env.CREDENTIAL_CACHE_BACKFILL.getByName(CREDENTIAL_CACHE_BACKFILL_INSTANCE_NAME).fetch(
    new URL(suffix, "https://backfill.internal"),
    suffix === "/run" ? { method: "POST" } : undefined,
  );
}

export async function handleLiveUpdateTestControl(
  request: Request,
  env: ControlPlaneApiEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/__test/live-updates/")) return null;
  if (
    !env.SPLITCH_LOCAL_E2E_RUN_ID ||
    request.method !== "POST" ||
    request.headers.get("x-splitch-local-e2e-run-id") !== env.SPLITCH_LOCAL_E2E_RUN_ID
  ) {
    return new Response("not found", { status: 404 });
  }
  const match = url.pathname.match(/^\/__test\/live-updates\/([^/]+)\/([^/]+)\/(up|down)$/);
  if (!match) return new Response("not found", { status: 404 });
  const [, appId, environmentId, state] = match;
  if (!appId || !environmentId || !state) return new Response("not found", { status: 404 });
  await env.CONFIG_STORE_WRITER.getByName(`${appId}:${environmentId}`).setLiveUpdatesAvailable(
    state === "up",
  );
  return Response.json({ ok: true, state });
}
