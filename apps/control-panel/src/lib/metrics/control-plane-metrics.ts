import { createPanelMetricsClient } from "@splitch/control-plane-sdk/panel-metrics";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "#lib/shared/control-plane-apps";

/** Server-only Metric client over the signed Control Plane Worker binding. */
export function createControlPanelMetricsClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  environmentId: string,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelMetricsClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      environmentId,
      delegationOptions,
    ),
  });
}
