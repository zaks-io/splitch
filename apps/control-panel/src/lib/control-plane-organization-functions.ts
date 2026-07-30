import { env as workerEnv } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelOrganizationsClient } from "./control-plane-apps";
import type { CreateControlPanelOrganizationResult } from "./create-organization-outcome";
import { loadSessionFromRequest } from "./session";
import { resyncSessionMemberships } from "./session-resync";

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
