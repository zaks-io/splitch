import { env as workerEnv } from "cloudflare:workers";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "#lib/shared/bindings";
import { createControlPanelOverviewClient } from "#lib/overview/control-plane-overview";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

const OverviewScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

export const loadControlPanelOverview = createServerFn({ method: "GET" })
  .validator((data: unknown) => OverviewScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const spans = createPerformanceSpanRecorder(bindings);
    const loaded = await spans.record({ name: "Panel session load", op: "cache.get" }, () =>
      loadSessionFromRequest(bindings, getRequest()),
    );
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
    return spans.record({ name: "Panel overview read", op: "function" }, () => client.read(data));
  });
