import { createPanelCloudflareClient } from "@splitch/control-plane-sdk/panel-cloudflare";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/**
 * Server-only Cloudflare installation client over the signed Control Plane
 * binding.
 *
 * No Environment is pinned on the delegation: every Cloudflare path already
 * names the Environment it acts on, so the claim binds to that path segment.
 */
export function createControlPanelCloudflareClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelCloudflareClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
