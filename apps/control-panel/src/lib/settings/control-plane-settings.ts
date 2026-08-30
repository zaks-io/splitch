import { createPanelSettingsClient } from "@splitch/control-plane-sdk/panel-settings";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "#lib/shared/control-plane-apps";

/** Server-only binding client for per-Environment Settings operations. */
export function createControlPanelSettingsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelSettingsClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
