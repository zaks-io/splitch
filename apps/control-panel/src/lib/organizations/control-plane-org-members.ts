import { createPanelOrgMembersClient } from "@splitch/control-plane-sdk/panel-org-members";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "#lib/shared/control-plane-apps";

/**
 * Server-only Org membership client over the signed Control Plane Worker binding.
 *
 * No `environmentId`: membership is an Organization fact, so pinning the
 * delegation to one Environment would name a scope the resource does not have.
 */
export function createControlPanelOrgMembersClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelOrgMembersClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
