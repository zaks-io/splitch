import {
  applyResponseHeaders,
  HOSTED_PRODUCTION_SECURITY_HEADERS,
  WORKER_BASELINE_SECURITY_HEADERS,
} from "@splitch/worker-runtime";

type WorkerSecurityEnv = { SPLITCH_PLATFORM_TARGET?: string };

export function productionHttpsRedirect(request: Request, env: WorkerSecurityEnv): Response | null {
  const url = new URL(request.url);
  // Build adapters prerender the built Worker through a plain-HTTP loopback server.
  if (
    env.SPLITCH_PLATFORM_TARGET !== "production" ||
    url.protocol !== "http:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    return null;
  }
  url.protocol = "https:";
  return applyResponseHeaders(
    new Response(null, { status: 308, headers: { location: url.toString() } }),
    WORKER_BASELINE_SECURITY_HEADERS,
  );
}

/** Stamp the shared baseline everywhere and HSTS only on production HTTPS. */
export function applyWorkerSecurityHeaders(
  response: Response,
  request: Request,
  env: WorkerSecurityEnv,
): Response {
  const isProductionHttps =
    env.SPLITCH_PLATFORM_TARGET === "production" && new URL(request.url).protocol === "https:";
  return applyResponseHeaders(
    response,
    isProductionHttps ? HOSTED_PRODUCTION_SECURITY_HEADERS : WORKER_BASELINE_SECURITY_HEADERS,
  );
}
