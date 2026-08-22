import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "./bindings";
import { createControlPanelAppsClient, createControlPanelFlagsClient } from "./control-plane-apps";
import { createDelegationEnvironment } from "./flags-matrix-data";
import { authorizedEntry, entryFor, parseLastVisitedCookie } from "./last-visited-scope";
import { rememberOrganizationVisit } from "./last-visited-scope-functions";
import { createEnvironmentResolver, rehydrateLegacySession } from "./membership";
import type {
  AppAttention,
  OrgAppListApp,
  OrgAppListEnvironment,
  OrgAppListView,
  PendingAppResync,
} from "./org-app-list";
import { type PendingResync, readPendingResync } from "./pending-resync";
import type { StoredSession } from "./session";
import { loadSessionFromRequest } from "./session-refresh";
import { retryPendingResync } from "./session-resync";

export type OrgAppListResult =
  | { kind: "ok"; view: OrgAppListView; actorId: string }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

/**
 * The Home read: the current Org's own Apps (never merged across Orgs),
 * each App's Environments, and each App's per-Environment attention rollup.
 * The rollup is read here rather than in the browser so Home renders in one
 * pass, and a failed rollup travels as a stated reason instead of an empty list.
 *
 * `bindings`/`request` are explicit parameters (rather than read internally
 * from `workerEnv`/`getRequest()`) so this can be called directly in a test
 * against real Miniflare D1 + KV: `createServerFn`'s wrapped export only
 * behaves correctly through the framework's build-time transform, which
 * plain vitest does not apply.
 */
export async function loadOrgAppListForRequest(
  bindings: ControlPanelBindings,
  request: Request,
  orgSlug: string,
): Promise<OrgAppListResult> {
  const now = Date.now();
  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok) return { kind: "unauthenticated" };

  const repo = createRepository(bindings.DB);
  const rehydrated = await rehydrateLegacySession(
    repo,
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  const organization0 = rehydrated.orgs.find((org) => org.orgSlug === orgSlug);
  if (!organization0) return { kind: "forbidden" };

  // The self-heal half of "Reload to check again" (SPL-203 review round 2,
  // Blocker 2): a pending marker for THIS Organization's App means the last
  // resync failed, so a reload actually re-attempts it instead of re-reading
  // the identical stale principal forever.
  const pendingBefore = await readPendingResync(bindings.SESSION_STORE, loaded.tokenHash, "app");
  const retryEligible = pendingBefore?.orgId === organization0.orgId;
  const session: StoredSession = retryEligible
    ? await retryPendingResync(bindings, loaded.tokenHash, rehydrated)
    : rehydrated;
  // One SESSION_STORE read covers both the retry guard above and the notice
  // below: `retryPendingResync` clears the marker on success, always handing
  // back a new session reference (never the `rehydrated` one it was given —
  // `session-resync.test.ts` pins this with `toBe`), and leaves the marker
  // untouched, same reference, on failure or when no retry ran at all. So the
  // post-retry marker state is derivable from `pendingBefore` without a
  // second `get`.
  const pendingAfter = retryEligible && session !== rehydrated ? null : pendingBefore;

  const organization = session.orgs.find((org) => org.orgSlug === orgSlug) ?? organization0;

  const resolver = createEnvironmentResolver(repo);
  const actor = { actorId: session.userId, sessionExpiresAt: loaded.session.expiresAt };

  const apps = await Promise.all(
    organization.apps.map(async (app): Promise<OrgAppListApp> => {
      const environments = await resolver.listEnvironments(app.appId);
      const [attention, flags] = await Promise.all([
        readAttention(bindings, actor, app.appId),
        readFlags(bindings, actor, app.appId, environments),
      ]);
      return { appId: app.appId, appSlug: app.appSlug, environments, attention, flags };
    }),
  );
  return {
    kind: "ok",
    actorId: session.userId,
    view: {
      orgId: organization.orgId,
      orgSlug: organization.orgSlug,
      orgRole: organization.orgRole,
      isProvisional: organization.isProvisional,
      demoExpiresAt: organization.demoExpiresAt,
      apps,
      // Scoped to this Organization only: a pending App create in a
      // different Organization must not surface a notice here.
      pendingAppResync: toPendingAppResync(pendingAfter, organization.orgId),
      lastVisited: authorizedEntry(
        entryFor(
          parseLastVisitedCookie(request.headers.get("cookie"), session.userId),
          organization.orgId,
        ),
        { orgSlug: organization.orgSlug, apps },
      ),
      now,
    },
  };
}

async function readFlags(
  bindings: ControlPanelBindings,
  actor: { actorId: string; sessionExpiresAt: number },
  appId: string,
  environments: readonly OrgAppListEnvironment[],
): Promise<OrgAppListApp["flags"]> {
  if (environments.length === 0) {
    return { kind: "unavailable", message: "This App has no Environments" };
  }
  const { CONTROL_PLANE_API, CONTROL_PANEL_DELEGATION_SECRET } = bindings;
  if (!CONTROL_PLANE_API || !CONTROL_PANEL_DELEGATION_SECRET) {
    return { kind: "unavailable", message: "the Control Plane binding is not configured" };
  }

  try {
    const environment = createDelegationEnvironment(environments);
    const result = await createControlPanelFlagsClient(
      CONTROL_PLANE_API,
      actor,
      environment.environmentId,
      CONTROL_PANEL_DELEGATION_SECRET,
    ).list({ appId });
    return result.ok
      ? {
          kind: "ready",
          count: result.data.items.length,
          truncated: result.data.readTruncated,
        }
      : { kind: "unavailable", message: result.error.message };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : "the Control Plane could not be reached",
    };
  }
}

export const loadOrgAppList = createServerFn({ method: "GET" })
  .validator((orgSlug: string) => orgSlug)
  .handler(async ({ data: orgSlug }) => {
    const request = getRequest();
    const result = await loadOrgAppListForRequest(
      controlPanelBindings(workerEnv),
      request,
      orgSlug,
    );
    // Home is where the sidebar switcher lands, so this is the org-level
    // "last used" write; App routes record their own visits.
    if (result.kind === "ok") rememberOrganizationVisit(request, result.actorId, result.view.orgId);
    return result;
  });

function toPendingAppResync(
  pending: Extract<PendingResync, { resource: "app" }> | null,
  orgId: string,
): PendingAppResync | null {
  if (pending?.orgId !== orgId) return null;
  return { appSlug: pending.slug, reason: pending.reason, remedy: pending.remedy };
}

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
