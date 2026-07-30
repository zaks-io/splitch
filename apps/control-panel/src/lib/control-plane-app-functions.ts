import { env as workerEnv } from "cloudflare:workers";
import type { AppsCreateOutput, ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type ControlPanelMutationBindings, controlPanelMutationBindings } from "./bindings";
import { createControlPanelAppsClient } from "./control-plane-apps";
import { buildSessionPrincipal } from "./membership";
import { loadSessionFromRequest, refreshSession, type StoredSession } from "./session";

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

/**
 * Creating an App also creates the App membership that authorizes reading it, and
 * the session's membership snapshot predates both. Without this the new App is
 * absent from the very list the operator just added it to — a success that reads
 * as a failure. Rebuilt from D1, which is the authority; every other session
 * field is carried through untouched.
 */
async function resyncSessionMemberships(
  bindings: ControlPanelMutationBindings,
  tokenHash: string,
  session: StoredSession,
): Promise<void> {
  if (!session.workosSessionId) {
    throw new Error("control-panel session is missing its WorkOS session identifier");
  }
  const principal = await buildSessionPrincipal(createRepository(bindings.DB), {
    userId: session.userId,
    workosSessionId: session.workosSessionId,
  });
  await refreshSession(bindings.SESSION_STORE, tokenHash, {
    ...session,
    orgs: principal.orgs,
  });
}
