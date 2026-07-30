import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type ControlPanelMutationBindings, controlPanelMutationBindings } from "./bindings";
import { createControlPanelOrganizationsClient } from "./control-plane-apps";
import type { CreateControlPanelOrganizationResult } from "./create-organization-outcome";
import { buildSessionPrincipal } from "./membership";
import { loadSessionFromRequest, refreshSession, type StoredSession } from "./session";

/**
 * Parsed rather than cast: an unauthenticated caller can reach this handler, and
 * a malformed body must fail as a 400 rather than throwing a 500 downstream
 * (ADR-0036). The slug is passed through exactly as typed — the Worker owns
 * whether it is acceptable.
 */
const CreateOrganizationInputSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});

export const createControlPanelOrganization = createServerFn({ method: "POST" })
  .validator((data: unknown) => CreateOrganizationInputSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<CreateControlPanelOrganizationResult> => {
    if (!parsed.success) {
      return {
        outcome: "refused",
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "The Organization draft is malformed",
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
        outcome: "refused",
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      };
    }

    const result = await createControlPanelOrganizationsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).create({ name: parsed.data.name, slug: parsed.data.slug });

    if (!result.ok) {
      return { outcome: "refused", status: result.status, error: result.error };
    }

    const orgSlug = result.data.slug;
    try {
      await resyncSessionMemberships(bindings, loaded.tokenHash, loaded.session);
    } catch (cause) {
      return { outcome: "created-session-stale", orgSlug, reason: describe(cause) };
    }
    return { outcome: "created", orgSlug };
  });

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The new Organization membership is created alongside the Organization, and the
 * session's membership snapshot predates both. Without this the Organization the
 * user just created is absent from the list they are about to land on. Rebuilt
 * from D1, which is the authority; every other session field is carried through
 * untouched.
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
