import {
  type AppsClient,
  createControlPlaneSdk,
  type FlagsClient,
  type OrganizationsClient,
} from "@splitch/control-plane-sdk";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  CONTROL_PANEL_ENVIRONMENT_HEADER,
  issueControlPanelDelegation,
  parseControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";

export interface ControlPanelActor {
  actorId: string;
  sessionExpiresAt: number;
}

export interface DelegationOptions {
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

/**
 * Server-only typed Organizations client over the Control Plane Worker binding.
 *
 * `create` is the one Organization operation with no `:orgId`, so its delegation
 * claims name no resource and the Worker's handler is the sole authorization
 * authority. Same transport as every other Panel call: one binding, one
 * delegation, no second door.
 */
export function createControlPanelOrganizationsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
): OrganizationsClient {
  return createControlPlaneSdk({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  }).organizations;
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

/**
 * The signed delegation header is the only credential this binding accepts, and
 * every inbound header is copied onto the outbound request. The SDK exposes a
 * per-call `authorization` option, so caller-supplied bearer or cookie material
 * can reach here; the entrypoint refuses it, but only once it has already crossed
 * the binding. Refuse before dispatch instead.
 */
function refuseCallerCredentials(headers: Headers): void {
  for (const header of ["authorization", "cookie"]) {
    if (headers.has(header)) {
      throw new Error(`control-panel binding request must not carry ${header} material`);
    }
  }
}

export function panelDelegationFetch(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  environmentId?: string,
  options: DelegationOptions = {},
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const headers = new Headers(request.headers);
    refuseCallerCredentials(headers);
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
