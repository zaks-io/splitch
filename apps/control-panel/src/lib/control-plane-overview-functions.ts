import { env as workerEnv } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelOverviewClient } from "./control-plane-overview";
import { loadSessionFromRequest } from "./session-refresh";

const OverviewScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

export const loadControlPanelOverview = createServerFn({ method: "GET" })
  .validator((data: unknown) => OverviewScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings, getRequest());
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 401 as const,
        error: {
          code: "UNAUTHORIZED" as const,
          message: "authentication required",
          details: {} as Record<string, never>,
        },
      };
    }
    const client = createControlPanelOverviewClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    );
    return client.read(data);
  });
