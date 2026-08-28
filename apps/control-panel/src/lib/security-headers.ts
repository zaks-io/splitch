import { applyResponseHeaders, CONTROL_PANEL_SECURITY_HEADERS } from "@splitch/worker-runtime";

/** Stamp the Control Panel policy: baseline plus frame-ancestors none / X-Frame-Options DENY. */
export function withControlPanelSecurityHeaders(response: Response): Response {
  return applyResponseHeaders(response, CONTROL_PANEL_SECURITY_HEADERS);
}
