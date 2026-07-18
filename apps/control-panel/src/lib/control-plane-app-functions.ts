import { env as workerEnv } from "cloudflare:workers";
import type {
  AppsCreateInput,
  AppsCreateOutput,
  ControlPlaneOperationResult,
} from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelAppsClient } from "./control-plane-apps";
import { loadSessionFromRequest } from "./session";

export type CreateControlPanelAppResult = ControlPlaneOperationResult<AppsCreateOutput>;

export const createControlPanelApp = createServerFn({ method: "POST" })
  .validator((data: AppsCreateInput) => data)
  .handler(async ({ data }): Promise<CreateControlPanelAppResult> => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }

    return createControlPanelAppsClient(bindings.CONTROL_PLANE_API, loaded.tokenHash).create(data);
  });
