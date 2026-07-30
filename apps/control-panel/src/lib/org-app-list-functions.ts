import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "./bindings";
import { createControlPanelAppsClient } from "./control-plane-apps";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import type { AppAttention, OrgAppListView } from "./org-app-list";
import { loadSessionFromRequest } from "./session";

export type OrgAppListResult =
  | { kind: "ok"; view: OrgAppListView }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

/**
 * The Org landing read: the current Org's own Apps (never merged across Orgs),
 * each App's Environments, and each App's per-Environment attention rollup.
 * The rollup is read here rather than in the browser so the card renders in one
 * pass, and a failed rollup travels as a stated reason instead of an empty list.
 */
export const loadOrgAppList = createServerFn({ method: "GET" })
  .validator((orgSlug: string) => orgSlug)
  .handler(async ({ data: orgSlug }): Promise<OrgAppListResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    if (!loaded.ok) return { kind: "unauthenticated" };

    const repo = createRepository(bindings.DB);
    const session = await rehydrateLegacySession(
      repo,
      bindings.SESSION_STORE,
      loaded.tokenHash,
      loaded.session,
    );
    const organization = session.orgs.find((org) => org.orgSlug === orgSlug);
    if (!organization) return { kind: "forbidden" };

    const resolver = createEnvironmentResolver(repo);
    const actor = { actorId: session.userId, sessionExpiresAt: loaded.session.expiresAt };

    return {
      kind: "ok",
      view: {
        orgId: organization.orgId,
        orgSlug: organization.orgSlug,
        orgRole: organization.orgRole,
        isProvisional: organization.isProvisional,
        demoExpiresAt: organization.demoExpiresAt,
        apps: await Promise.all(
          organization.apps.map(async (app) => ({
            appId: app.appId,
            appSlug: app.appSlug,
            environments: await resolver.listEnvironments(app.appId),
            attention: await readAttention(bindings, actor, app.appId),
          })),
        ),
      },
    };
  });

/**
 * A rollup failure is reported, never swallowed: every non-success path returns
 * the reason the card will show, because the alternative — an absent marker — is
 * indistinguishable from a healthy App (ADR-0036).
 */
async function readAttention(
  bindings: ControlPanelBindings,
  actor: { actorId: string; sessionExpiresAt: number },
  appId: string,
): Promise<AppAttention> {
  const { CONTROL_PLANE_API, CONTROL_PANEL_DELEGATION_SECRET } = bindings;
  if (!CONTROL_PLANE_API || !CONTROL_PANEL_DELEGATION_SECRET) {
    return { kind: "unavailable", message: "the Control Plane binding is not configured" };
  }
  try {
    const result = await createControlPanelAppsClient(
      CONTROL_PLANE_API,
      actor,
      CONTROL_PANEL_DELEGATION_SECRET,
    ).getAttentionRollup({ appId });
    return result.ok
      ? { kind: "ready", items: result.data.items }
      : { kind: "unavailable", message: result.error.message };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : "the Control Plane could not be reached",
    };
  }
}
