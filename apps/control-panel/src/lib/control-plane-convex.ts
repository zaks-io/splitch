import { createPanelConvexClient } from "@splitch/control-plane-sdk/panel-convex";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/**
 * Server-only Convex installation client over the signed Control Plane binding.
 *
 * No Environment is pinned on the delegation: every Convex path already names
 * the Environment it acts on, so the claim binds to that path segment.
 */
export function createControlPanelConvexClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelConvexClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
