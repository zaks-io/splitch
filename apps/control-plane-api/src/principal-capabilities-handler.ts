import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { type HandlerArgs, type Principal, requireWideMemberships } from "@splitch/worker-runtime";

/** Effective authority resolved at the Control Plane boundary for the current principal. */
export function getPrincipalCapabilities({ principal }: HandlerArgs<unknown>): Response {
  return Response.json({
    scopes: effectiveScopes(principal),
    membershipWideRead:
      principal.liveMembership === true ||
      principal.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  });
}

function effectiveScopes(principal: Principal): readonly string[] {
  if (principal.authorization !== MEMBERSHIP_WIDE_READ_AUTHORIZATION) {
    return principal.scopes;
  }
  const memberships = requireWideMemberships(principal);
  return [
    ...memberships.organizations.map((membership) => `org:${membership.id}:${membership.role}`),
    ...memberships.apps.map((membership) => `app:${membership.id}:${membership.role}`),
  ].sort();
}
