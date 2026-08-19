import {
  canGrantAppAccess,
  type PanelAppSettings,
} from "@splitch/control-plane-sdk/panel-app-settings";
import { appScope, type Repository } from "@splitch/db";
import { appResponse } from "./app-environment-model";
import { ORG_ADMIN_ROLES } from "./org-authz";
import type { MemberProfileResolver } from "./org-handlers";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";
import { catalogFlag } from "./panel-app-settings-catalog";
import { appAccessPeople } from "./panel-app-settings-people";
import { panelAppScopeAccess } from "./panel-scope-access";

interface PanelAppSettingsDeps {
  repo: Repository;
  memberProfileResolver?: MemberProfileResolver;
}

/**
 * The composed App Settings read behind the binding-only Panel entrypoint.
 *
 * `panelAppScopeAccess` rechecks live Organization AND App membership for this
 * exact call before a single settings row is read, and the role it returns is
 * what the screen renders its capabilities from. Every read below is scoped by
 * `appScope(appId)`, so the data-access seam injects `app_id` rather than
 * trusting anything the caller said (ADR-0018).
 */
export async function panelAppSettingsRead(
  deps: PanelAppSettingsDeps,
  input: { appId: string; actorId: string },
  request: Request,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const access = await panelAppScopeAccess(
    deps.repo,
    { actorId: input.actorId, appId: input.appId },
    requestId,
  );
  if (!access.ok) return access.response;

  const scope = appScope(input.appId);
  // One row past the ceiling, so truncation is OBSERVED rather than inferred,
  // matching the Flags list. The catalog is shown here read-only; editing a
  // Variant lives on Flag detail.
  const [memberships, scanned] = await Promise.all([
    deps.repo.identity.listAppMembers(scope),
    deps.repo.flags.listFlagPage(scope, FLAG_LIST_READ_LIMIT + 1),
  ]);
  const readTruncated = scanned.length > FLAG_LIST_READ_LIMIT;
  const rows = readTruncated ? scanned.slice(0, FLAG_LIST_READ_LIMIT) : scanned;
  const catalogs = await deps.repo.flags.listVariantsForFlags(
    scope,
    rows.map((row) => row.id),
  );
  const viewerRole = access.role;

  const people = await appAccessPeople(deps, {
    canGrantAccess: canGrantAppAccess(viewerRole),
    canListCandidates: ORG_ADMIN_ROLES.includes(access.orgRole),
    orgId: access.app.organizationId,
    memberships,
    request,
  });

  const response: PanelAppSettings = {
    app: appResponse(access.app),
    viewerRole,
    members: people.members,
    ...(people.candidates !== undefined ? { candidates: people.candidates } : {}),
    flags: {
      items: rows.map((row) => catalogFlag(row, catalogs.get(row.id) ?? [])),
      readTruncated,
      readLimit: FLAG_LIST_READ_LIMIT,
    },
  };
  return Response.json(response);
}
