import { env as workerEnv } from "cloudflare:workers";
import type {
  PanelExperimentDetailInput,
  PanelExperimentsListInput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelExperimentsClient } from "./control-plane-experiments";
import { loadSessionFromRequest } from "./session";

export const loadControlPanelExperiments = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentsListInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }
    return createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).list(data);
  });

export const loadControlPanelExperimentDetail = createServerFn({ method: "GET" })
  .validator((data: PanelExperimentDetailInput) => data)
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }
    return createControlPanelExperimentsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).detail(data);
  });
