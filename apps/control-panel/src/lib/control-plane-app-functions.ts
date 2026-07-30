import { env as workerEnv } from "cloudflare:workers";
import type { AppsCreateOutput, ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelAppsClient } from "./control-plane-apps";
import { loadSessionFromRequest } from "./session";
import { resyncSessionMemberships } from "./session-resync";

export type CreateControlPanelAppResult = ControlPlaneOperationResult<AppsCreateOutput>;

/**
 * The Org comes from the URL scope, so the request carries only what the operator
 * typed. Parsed rather than cast: an unauthenticated caller can reach this
 * handler, and a malformed body must fail as a 400 rather than throwing a 500
 * downstream (ADR-0036).
 */
const CreateAppInputSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().trim().min(1),
  key: z.string().trim().min(1),
});

export const createControlPanelApp = createServerFn({ method: "POST" })
  .validator((data: unknown) => CreateAppInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<CreateControlPanelAppResult> => {
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "The App draft is malformed",
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String),
              message: issue.message,
            })),
          },
        },
      };
    }

    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }

    const { orgId, name, key } = parsed.data;
    const result = await createControlPanelAppsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).create({ orgId, organizationId: orgId, name, key });

    if (result.ok) {
      await resyncSessionMemberships(bindings, loaded.tokenHash, loaded.session);
    }
    return result;
  });
