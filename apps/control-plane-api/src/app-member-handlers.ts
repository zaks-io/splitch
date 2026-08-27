import {
  type AppMember,
  boundListRead,
  LIST_READ_LIMIT,
  type UserRole,
  UserRoleSchema,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { requireAppAdmin, requireAppDelete, requireAppMember } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import { objectBody, pathParam } from "./handler-input";
import { membershipConflict } from "./membership-conflict";
import type { MemberProfileResolver } from "./org-handlers";

/**
 * App membership: the App's own access list (`app_memberships`), distinct from
 * Organization membership. Being in the Org does not grant App access, and this
 * list is what `requireAppRole` rechecks live on every call.
 *
 * Every read and write here goes through `appScope(appId)` so `app_id` is
 * injected by the data-access seam rather than trusted from the request
 * (ADR-0018 — D1 has no RLS).
 */

export interface AppMemberHandlerDeps {
  repo: Repository;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
}

type AppMembershipRow = NonNullable<
  Awaited<ReturnType<Repository["identity"]["getAppMembership"]>>
>;

export function makeAppMemberHandlers(deps: AppMemberHandlerDeps) {
  const now = () => deps.nowIso?.() ?? new Date().toISOString();

  return {
    /**
     * Readable by every App role: the App matrix grants "view config" to member,
     * so seeing who else has access is a member read.
     */
    async listAppMembers({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const forbidden = await requireAppMember(deps, appId, principal, requestId);
      if (forbidden) return forbidden;

      const scanned = await deps.repo.identity.listAppMembers(appScope(appId), {
        limit: LIST_READ_LIMIT + 1,
      });
      const page = boundListRead(scanned);
      const items: AppMember[] = [];
      for (const row of page.items) {
        items.push(await appMemberResponse(deps, row, app.organizationId, request));
      }
      return Response.json({ ...page, items });
    },

    async addAppMember({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const payload = objectBody(input);
      const userId = payload.userId as string;
      const role = UserRoleSchema.parse(payload.role);

      const refusal = await grantRefusal(deps, {
        app,
        principal,
        requestId,
        role,
        userId,
      });
      if (refusal) return refusal;

      const scope = appScope(appId);
      const existing = await deps.repo.identity.getAppMembership(scope, userId);
      if (existing)
        return membershipConflict(UserRoleSchema.parse(existing.role), "app", requestId);

      const row = await deps.repo.identity.createAppMembership(scope, {
        userId,
        role,
        createdAt: now(),
      });
      return Response.json(await appMemberResponse(deps, row, app.organizationId, request));
    },

    async updateAppMember({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const userId = pathParam(input, "userId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const forbidden = await requireAppDelete(deps, appId, principal, requestId);
      if (forbidden) return forbidden;

      const scope = appScope(appId);
      const current = await deps.repo.identity.getAppMembership(scope, userId);
      if (!current) return userNotFound(requestId);

      const role = UserRoleSchema.parse(objectBody(input).role);
      const updated = await deps.repo.identity.updateAppMembership(scope, userId, { role });
      if (!updated) return failedOwnerMutation(current, role, appId, requestId);
      return Response.json(await appMemberResponse(deps, updated, app.organizationId, request));
    },

    async removeAppMember({ input, principal, requestId }: HandlerArgs<unknown>) {
      const appId = pathParam(input, "appId");
      const userId = pathParam(input, "userId");
      const app = await deps.repo.identity.getApp(appId);
      if (!app) return appNotFound(requestId);

      const forbidden = await requireAppDelete(deps, appId, principal, requestId);
      if (forbidden) return forbidden;

      const scope = appScope(appId);
      const current = await deps.repo.identity.getAppMembership(scope, userId);
      if (!current) return userNotFound(requestId);

      const deleted = await deps.repo.identity.deleteAppMembership(scope, userId);
      if (deleted === 0) return failedOwnerMutation(current, null, appId, requestId);
      return Response.json({ deleted: true });
    },
  };
}

/**
 * `email` is `null` when the identity cache has no profile for the user yet
 * (written at first sign-in). Substituting a placeholder would be a silent
 * default (ADR-0036), and refusing the whole read would take the rest of App
 * Settings down with it, so the absence is modelled and rendered as such.
 */
async function appMemberResponse(
  deps: AppMemberHandlerDeps,
  membership: AppMembershipRow,
  orgId: string,
  request: Request,
): Promise<AppMember> {
  const profile = await deps.memberProfileResolver?.({
    orgId,
    userId: membership.userId,
    request,
  });
  return {
    appId: membership.appId,
    userId: membership.userId,
    email: profile?.email ?? null,
    role: UserRoleSchema.parse(membership.role),
    createdAt: membership.createdAt,
  };
}

/**
 * The two gates a grant has to clear beyond "you may grant access at all".
 *
 * Granting owner is owner-only even though granting access is not: an admin who
 * could mint an owner would walk straight past the owner-only role-change and
 * revoke gates below.
 *
 * App access is granted from INSIDE the Organization that owns the App, so a
 * user with no Org membership has no relationship to this tenant to widen. That
 * is refused rather than silently implying an Org membership the caller never
 * asked for and may not be allowed to create.
 */
async function grantRefusal(
  deps: AppMemberHandlerDeps,
  args: {
    app: { id: string; organizationId: string };
    principal: HandlerArgs<unknown>["principal"];
    requestId: string;
    role: UserRole;
    userId: string;
  },
): Promise<Response | null> {
  const { app, principal, requestId, role, userId } = args;
  const adminGate = await requireAppAdmin(deps, app.id, principal, requestId);
  if (adminGate) return adminGate;

  if (role === "owner") {
    const ownerGate = await requireAppDelete(deps, app.id, principal, requestId);
    if (ownerGate) return ownerGate;
  }

  const orgMembership = await deps.repo.identity.getOrgMembership(app.organizationId, userId);
  return orgMembership ? null : userNotInOrganization(requestId);
}

/**
 * A 0-row last-owner UPDATE/DELETE is the losing side of the atomic predicate
 * in the repository. The pre-read told us this was an owner-loss attempt, so
 * the refusal is LAST_OWNER_REQUIRED rather than a vanishing-row 404.
 */
function failedOwnerMutation(
  current: AppMembershipRow,
  nextRole: UserRole | null,
  appId: string,
  requestId: string,
): Response {
  if (current.role === "owner" && nextRole !== "owner") {
    return lastOwnerRequired(appId, requestId);
  }
  return userNotFound(requestId);
}

function lastOwnerRequired(appId: string, requestId: string): Response {
  return renderError(
    {
      code: "LAST_OWNER_REQUIRED",
      message: "app must retain at least one owner",
      details: { appId },
    },
    { requestId },
  );
}

function userNotFound(requestId: string): Response {
  return renderError(
    { code: "USER_NOT_FOUND", message: "user not found", details: {} },
    { requestId },
  );
}

function userNotInOrganization(requestId: string): Response {
  return renderError(
    {
      code: "USER_NOT_FOUND",
      message: "user is not a member of the organization that owns this app",
      details: {},
    },
    { requestId },
  );
}
