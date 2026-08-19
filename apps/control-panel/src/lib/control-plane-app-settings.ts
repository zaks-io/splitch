import { createPanelAppSettingsClient } from "@splitch/control-plane-sdk/panel-app-settings";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/**
 * Server-only binding client for App Settings.
 *
 * No `environmentId`: renaming an App, changing who may reach it, and deleting
 * it are App-level acts, so pinning the delegation to one Environment would
 * name a scope these resources do not have.
 */
export function createControlPanelAppSettingsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelAppSettingsClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
