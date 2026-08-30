import {
  createPanelExposureStatusClient,
  type PanelExposureStatusClient,
} from "@splitch/control-plane-sdk/panel-exposure-status";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "#lib/shared/control-plane-apps";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";

/** Server-only Exposure status client over the signed Control Plane binding. */
export function createControlPanelExposureStatusClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId: string,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
): PanelExposureStatusClient {
  return createPanelExposureStatusClient({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      environmentId,
      delegationOptions,
    ),
  });
}
