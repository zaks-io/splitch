import { createPanelSegmentsClient } from "@splitch/control-plane-sdk/panel-segments";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/** Server-only Segment client over the signed Control Plane Worker binding. */
export function createControlPanelSegmentsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId: string,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelSegmentsClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      environmentId,
      delegationOptions,
    ),
  });
}
