/**
 * One baseline security-header policy for every Worker response.
 *
 * Apps may add headers (Control Panel anti-framing, CORS, MCP session). Merge
 * never overwrites a header the route already set, so protocol and
 * route-specific security headers keep their values.
 */

export const WORKER_BASELINE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const satisfies Record<string, string>;

/** Baseline plus clickjacking controls. Applied at the Control Panel boundary. */
export const CONTROL_PANEL_SECURITY_HEADERS = {
  ...WORKER_BASELINE_SECURITY_HEADERS,
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
} as const satisfies Record<string, string>;

/**
 * Copy `baseline`, then add `extras` only for names the baseline does not
 * already carry (case-insensitive). Baseline keys cannot be weakened here.
 */
export function mergeHeaderRecords(
  baseline: Record<string, string>,
  extras?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...baseline };
  if (!extras) return merged;
  const present = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(extras)) {
    if (present.has(key.toLowerCase())) continue;
    merged[key] = value;
    present.add(key.toLowerCase());
  }
  return merged;
}

/**
 * Stamp missing headers onto a Response. Existing names win. A WebSocket
 * upgrade is returned unchanged so the socket is not dropped. A stream keeps
 * its unread body.
 */
export function applyResponseHeaders(response: Response, extra?: Record<string, string>): Response {
  if (!extra) return response;
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  let changed = false;
  for (const [key, value] of Object.entries(extra)) {
    if (headers.has(key)) continue;
    headers.set(key, value);
    changed = true;
  }
  if (!changed) return response;
  return cloneResponse(response, headers);
}

function cloneResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
