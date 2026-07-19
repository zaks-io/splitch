import {
  type AppsClient,
  createControlPlaneSdk,
  type FlagsClient,
} from "@splitch/control-plane-sdk";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";
const PANEL_SESSION_HEADER = "x-splitch-panel-session";
const TOKEN_HASH = /^[a-f0-9]{64}$/;

/** Server-only typed Apps client over the Control Plane Worker binding. */
export function createControlPanelAppsClient(
  controlPlane: Fetcher,
  sessionTokenHash: string,
): AppsClient {
  if (!TOKEN_HASH.test(sessionTokenHash)) {
    throw new Error("control-panel session handle is invalid");
  }
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelSessionFetch(controlPlane, sessionTokenHash),
  }).apps;
}

/** Server-only typed Flags client over the Control Plane Worker binding. */
export function createControlPanelFlagsClient(
  controlPlane: Fetcher,
  sessionTokenHash: string,
  environmentId: string,
): FlagsClient {
  if (!TOKEN_HASH.test(sessionTokenHash)) {
    throw new Error("control-panel session handle is invalid");
  }
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelSessionFetch(controlPlane, sessionTokenHash, environmentId),
  }).flags;
}

function panelSessionFetch(
  controlPlane: Fetcher,
  sessionTokenHash: string,
  environmentId?: string,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set(PANEL_SESSION_HEADER, sessionTokenHash);
    if (environmentId) headers.set("x-splitch-panel-environment", environmentId);
    return controlPlane.fetch(new Request(request, { headers }));
  };
}
