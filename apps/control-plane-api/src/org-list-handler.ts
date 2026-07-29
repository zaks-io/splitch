import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { organizationResponse } from "./org-response";
import { organizationIdsInScopes } from "./scope-binding";

export function makeListOrganizationsHandler(repo: Repository) {
  return async ({ principal }: HandlerArgs<unknown>): Promise<Response> => {
    const scopedOrgIds = organizationIdsInScopes(principal.scopes);
    const memberships = (await repo.identity.listOrgMembershipsForUser(principal.id)).filter(
      (membership) => scopedOrgIds.has(membership.orgId),
    );
    const orgIds = new Set(memberships.map((membership) => membership.orgId));
    const items = await Promise.all(
      [...orgIds].map(async (orgId) => {
        const org = await repo.identity.getOrg(orgId);
        return org ? organizationResponse(org) : null;
      }),
    );

    return Response.json({ items: items.filter((org) => org !== null) });
  };
}
