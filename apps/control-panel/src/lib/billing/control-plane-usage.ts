import {
  createPanelUsageClient,
  type PanelUsageClient,
} from "@splitch/control-plane-sdk/panel-usage";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "#lib/shared/control-plane-apps";

const CONTROL_PLANE_INTERNAL_ORIGIN = "https://control-plane.internal";

/**
 * Server-only typed usage client over the Control Plane Worker binding.
 *
 * No `environmentId`: the Evaluation allowance is Organization-scoped
 * (ADR-0033), so pinning the delegation to one Environment would name a scope
 * the read does not have.
 */
export function createControlPanelUsageClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
): PanelUsageClient {
  return createPanelUsageClient({
    baseUrl: CONTROL_PLANE_INTERNAL_ORIGIN,
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
