import { env as workerEnv } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelAppsClient } from "./control-plane-apps";
import { type CreateControlPanelAppResult, settleAfterCreate } from "./create-app-outcome";
import { markPendingResyncBestEffort } from "./pending-resync";
import { loadSessionFromRequest } from "./session";
import { resyncSessionMemberships } from "./session-resync";

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
        outcome: "refused",
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
        outcome: "refused",
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

    if (!result.ok) {
      return { outcome: "refused", status: result.status, error: result.error };
    }

    // The App exists in the Control Plane at this point. A resync failure below
    // must never be reported through the same path as a failed create (SPL-203):
    // that told the operator to retry a mutation that already succeeded, and the
    // retry could only fail again on `apps_org_key_unique`.
    const settled = await settleAfterCreate(result.data.app.key, async () => {
      await resyncSessionMemberships(bindings, loaded.tokenHash, loaded.session);
    });
    if (settled.outcome === "created-session-stale") {
      // Written outside the session object so a reload before the next
      // successful resync still knows this App exists (SPL-203 review:
      // otherwise the notice — and the fact the create-again retry is
      // impossible — disappears the moment the page reloads). Best-effort:
      // this write must never be able to convert the App create above, which
      // already succeeded, into a reported failure (SPL-203 review round 2).
      await markPendingResyncBestEffort(bindings.SESSION_STORE, loaded.tokenHash, {
        resource: "app",
        orgId,
        slug: settled.appSlug,
        reason: settled.reason,
        remedy: settled.remedy,
      });
    }
    return settled;
  });
