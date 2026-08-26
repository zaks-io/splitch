import { createPanelSentryClient } from "@splitch/control-plane-sdk/panel-sentry";
import {
  type ControlPanelActor,
  type DelegationOptions,
  panelDelegationFetch,
} from "./control-plane-apps";

/**
 * Server-only Sentry installation client over the signed Control Plane binding.
 *
 * No Environment is pinned on the delegation: a Sentry installation belongs to
 * an Organization, and every Sentry path already names it, so the claim binds to
 * that segment rather than to a header the operator's current Environment
 * selection happens to carry.
 */
export function createControlPanelSentryClient(
  controlPlane: Fetcher,
  actor: ControlPanelActor,
  delegationSecret: string,
  delegationOptions?: DelegationOptions,
) {
  return createPanelSentryClient({
    fetch: panelDelegationFetch(
      controlPlane,
      actor,
      delegationSecret,
      undefined,
      delegationOptions,
    ),
  });
}
