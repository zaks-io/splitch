import { createPanelExperimentsClient } from "@splitch/control-plane-sdk/panel-experiments";
import { panelSessionFetch } from "./control-plane-apps";

/** Server-only binding client for the SPL-111 composite list operation. */
export function createControlPanelExperimentsClient(
  controlPlane: Fetcher,
  sessionTokenHash: string,
) {
  return createPanelExperimentsClient({
    fetch: panelSessionFetch(controlPlane, sessionTokenHash),
  });
}
