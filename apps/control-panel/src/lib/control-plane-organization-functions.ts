import { env as workerEnv } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelOrganizationsClient } from "./control-plane-apps";
import {
  type CreateControlPanelOrganizationResult,
  settleAfterCreate,
} from "./create-organization-outcome";
import { markPendingResyncBestEffort } from "./pending-resync";
import { loadSessionFromRequest } from "./session-refresh";
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
    const loaded = await loadSessionFromRequest(bindings, getRequest());
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

    // The Organization exists in the Control Plane at this point. A resync
    // failure below must never be reported through the same path as a failed
    // create (SPL-203): that told the operator to retry a mutation that
    // already succeeded, and the retry could only fail again on the handle.
    const orgSlug = result.data.slug;
    const settled = await settleAfterCreate(orgSlug, async () => {
      await resyncSessionMemberships(bindings, loaded.tokenHash, loaded.session);
    });
    if (settled.outcome === "created-session-stale") {
      // Best-effort: this write must never be able to convert the
      // Organization create above, which already succeeded, into a reported
      // failure (SPL-203 review round 2).
      await markPendingResyncBestEffort(bindings.SESSION_STORE, loaded.tokenHash, {
        resource: "organization",
        slug: settled.orgSlug,
        reason: settled.reason,
        remedy: settled.remedy,
      });
    }
    return settled;
  });
