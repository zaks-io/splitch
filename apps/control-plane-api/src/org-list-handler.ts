import { boundListRead, LIST_READ_LIMIT } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { organizationResponse } from "./org-response";
import { organizationIdsInScopes } from "./scope-binding";

/**
 * `/orgs` is the agent cold-start entry: it answers "which Organizations am
 * I in?" and the tenant key is the principal itself, not a path `:orgId`.
 * Filtering by the token's org scopes would make it return `{items: []}` for
 * the app-less token a fresh login mints, deadlocking the very first step.
 *
 * The exemption is limited to `device_flow` because that is the only door whose
 * holder can already reach every one of these Orgs: its refresh token rebinds
 * to any of them on demand, so listing them grants no reach it lacks. Doors
 * that mint a refresh-less access token (the claim ceremony, client_credentials)
 * genuinely ARE narrowed by their scopes, so they keep the scope intersection.
 */
export function makeListOrganizationsHandler(repo: Repository) {
  return async ({ principal }: HandlerArgs<unknown>): Promise<Response> => {
    const memberships = await repo.identity.listOrgMembershipsForUser(principal.id, {
      limit: LIST_READ_LIMIT + 1,
    });
    const page = boundListRead(memberships);
    const orgIds = reachableOrgIds(principal, page.items);
    const items = await Promise.all(
      [...orgIds].map(async (orgId) => {
        const org = await repo.identity.getOrg(orgId);
        return org ? organizationResponse(org) : null;
      }),
    );

    return Response.json({
      ...page,
      items: items.filter((org) => org !== null),
    });
  };
}

/**
 * Live membership is the floor for every door: a scope naming an Org the
 * principal does not belong to never widens the result.
 */
function reachableOrgIds(
  principal: Principal,
  memberships: readonly { orgId: string }[],
): Set<string> {
  const member = new Set(memberships.map((membership) => membership.orgId));
  if (principal.authDoor === "device_flow") {
    return member;
  }
  const scoped = organizationIdsInScopes(principal.scopes);
  return new Set([...member].filter((orgId) => scoped.has(orgId)));
}
