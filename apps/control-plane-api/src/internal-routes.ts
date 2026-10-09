import type { ControlPlaneApiEnv } from "./env";

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
