import {
  type AppsClient,
  createControlPlaneSdk,
  type FlagsClient,
} from "@splitch/control-plane-sdk";
import {
  CONTROL_PANEL_ENVIRONMENT_HEADER,
  CONTROL_PANEL_IDENTITY_HEADER,
  issueControlPanelIdentity,
  parseControlPanelOperation,
  serializeControlPanelIdentity,
} from "@splitch/control-plane-sdk/control-panel-identity";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";

interface ControlPanelActor {
  actorId: string;
  sessionExpiresAt: number;
}

interface IdentityOptions {
  nowSeconds?: () => number;
  nonce?: () => string;
}

/** Server-only typed Apps client over the Control Plane Worker binding. */
export function createControlPanelAppsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  identityOptions?: IdentityOptions,
): AppsClient {
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelIdentityFetch(controlPlane, actor, undefined, identityOptions),
  }).apps;
}

/** Server-only typed Flags client over the Control Plane Worker binding. */
export function createControlPanelFlagsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId: string,
  identityOptions?: IdentityOptions,
): FlagsClient {
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelIdentityFetch(controlPlane, actor, environmentId, identityOptions),
  }).flags;
}

function panelIdentityFetch(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId?: string,
  options: IdentityOptions = {},
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const headers = new Headers(request.headers);
    if (environmentId) headers.set(CONTROL_PANEL_ENVIRONMENT_HEADER, environmentId);
    const operation = parseControlPanelOperation(
      request.method,
      new URL(request.url).pathname,
      environmentId,
    );
    if (!operation) throw new Error("control-panel attempted an unsupported binding operation");
    const nowSeconds = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const identity = issueControlPanelIdentity(operation, actor.actorId, {
      nowSeconds,
      sessionExpiresAt: actor.sessionExpiresAt,
      ...(options.nonce ? { nonce: options.nonce() } : {}),
    });
    headers.set(CONTROL_PANEL_IDENTITY_HEADER, serializeControlPanelIdentity(identity));
    return controlPlane.fetch(new Request(request, { headers }));
  };
}
