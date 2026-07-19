import {
  type AppsClient,
  createControlPlaneSdk,
  type FlagsClient,
} from "@splitch/control-plane-sdk";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  CONTROL_PANEL_ENVIRONMENT_HEADER,
  issueControlPanelDelegation,
  parseControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";

interface ControlPanelActor {
  actorId: string;
  sessionExpiresAt: number;
}

interface DelegationOptions {
  nowSeconds?: () => number;
  nonce?: () => string;
}

/** Server-only typed Apps client over the Control Plane Worker binding. */
export function createControlPanelAppsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
): AppsClient {
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  }).apps;
}

/** Server-only typed Flags client over the Control Plane Worker binding. */
export function createControlPanelFlagsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId: string,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
): FlagsClient {
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      environmentId,
      delegationOptions,
    ),
  }).flags;
}

function panelDelegationFetch(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  environmentId?: string,
  options: DelegationOptions = {},
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
    headers.set(
      CONTROL_PANEL_DELEGATION_HEADER,
      await issueControlPanelDelegation(request, operation, actor.actorId, delegationSecret, {
        nowSeconds,
        sessionExpiresAt: actor.sessionExpiresAt,
        ...(options.nonce ? { nonce: options.nonce() } : {}),
      }),
    );
    return controlPlane.fetch(new Request(request, { headers }));
  };
}
