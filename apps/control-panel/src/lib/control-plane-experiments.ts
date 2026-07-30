import { createPanelExperimentsClient } from "@splitch/control-plane-sdk/panel-experiments";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/** Server-only binding client for Experiment list and detail reads. */
export function createControlPanelExperimentsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelExperimentsClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
