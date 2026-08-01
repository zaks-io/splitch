import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { organizationResponse } from "./org-response";

/**
 * `/orgs` is the agent cold-start entry: it answers "which Organizations am
 * I in?" and the tenant key is the principal itself, not a path `:orgId`.
 * Filtering by the token's org scopes would make it return `{items: []}` for
 * the app-less token a fresh login mints, deadlocking the very first step.
 * A narrower binding is not narrower authority here — the same session can
 * rebind to any of these Orgs through the refresh grant, so listing the
 * memberships it could bind to leaks nothing the holder cannot already reach.
 */
export function makeListOrganizationsHandler(repo: Repository) {
  return async ({ principal }: HandlerArgs<unknown>): Promise<Response> => {
    const memberships = await repo.identity.listOrgMembershipsForUser(principal.id);
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
