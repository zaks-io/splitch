/**
 * Same-origin Origin check for cookie-authenticated form POSTs.
 *
 * Same treatment as `live-update-upgrade.ts`: `Origin` must equal the request
 * URL origin. `SameSite=Lax` is a *site* boundary — `app.splitch.dev` and its
 * siblings (`auth.`, `api.`, `edge.`, `ingest.`, `mcp.`, apex `splitch.dev`)
 * are same-site, so Lax still sends `__session` on a POST from those hosts.
 * Without this check, HTML on any `*.splitch.dev` host can forge
 * `POST /auth/logout` or `POST /claim/consent/$attemptId` (SPL-263).
 *
 * Do not invent a second CSRF treatment. Reuse this helper.
 */
export function rejectCrossOriginWrite(request: Request): Response | null {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  return null;
}
