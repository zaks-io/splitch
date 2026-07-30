import { createPanelOverviewClient } from "@splitch/control-plane-sdk/panel-overview";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/** Server-only binding client for the App Overview read. */
export function createControlPanelOverviewClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelOverviewClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
