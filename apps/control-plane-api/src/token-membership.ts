import { type MembershipSet, type UserRole, UserRoleSchema } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { AuthResolver, AuthResult, PrincipalMemberships } from "@splitch/worker-runtime";
import { resolveCachedMemberships } from "./membership-cache";
import {
  type MembershipClaim,
  type MembershipRole,
  membershipClaimsInScopes,
} from "./scope-binding";

/**
 * Membership recheck for human/agent bearer tokens (SPL-482).
 *
 * Token scopes are minted from membership at issue time. This port resolves the
 * current Org and App membership set before the registrar's scope checks; KV
 * invalidation bounds how long another location can retain the prior set.
 * Tokens that carry no membership axes (service credentials whose authority
 * does not derive from membership) skip the read.
 */

export interface TokenMembershipAccess {
  authorize(userId: string, claims: readonly MembershipClaim[]): Promise<boolean>;
  resolve(userId: string): Promise<PrincipalMemberships>;
  /** Cache-capable adapters expose the request read so auth can start it beside revocation. */
  resolveForRequest?: (userId: string) => Promise<PrincipalMemberships>;
}

const ROLE_RANK: Record<UserRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

const MEMBERSHIP_REFUSED: AuthResult = {
  ok: false,
  reason: "UNAUTHORIZED",
  error: {
    code: "FORBIDDEN",
    message: "live membership is required",
    details: {},
  },
};

export function makeTokenMembershipAccess(
  repo: Pick<Repository, "identity">,
  kv: KVNamespace,
  writeOnMiss = true,
): TokenMembershipAccess {
  const resolve = (userId: string) =>
    resolveCachedMemberships(
      kv,
      userId,
      () => resolveLiveMemberships(repo, userId),
      console,
      writeOnMiss,
    );
  return {
    async authorize(userId, claims) {
      return claimsHold(await resolve(userId), claims);
    },
    resolve,
    resolveForRequest: resolve,
  };
}

async function resolveLiveMemberships(
  repo: Pick<Repository, "identity">,
  userId: string,
): Promise<MembershipSet> {
  const organizations = await repo.identity.listOrgMembershipsForUser(userId);
  const apps = await repo.identity.listAppMembershipsWithAppForUser(
    userId,
    organizations.map((membership) => membership.orgId),
  );
  return {
    organizations: organizations.map((membership) => ({
      id: membership.orgId,
      role: UserRoleSchema.parse(membership.role),
    })),
    apps: apps.map((membership) => ({
      id: membership.app.id,
      organizationId: membership.app.organizationId,
      role: UserRoleSchema.parse(membership.role),
    })),
  };
}

export async function resolveBearerMemberships(
  access: TokenMembershipAccess,
  userId: string,
): Promise<PrincipalMemberships> {
  return access.resolve(userId);
}

/** Fail loud when the bearer resolver is constructed without a membership port. */
export function requireTokenMembershipAccess(
  access: TokenMembershipAccess | undefined,
): TokenMembershipAccess {
  if (!access) {
    throw new Error("control-plane: membershipAccess is required");
  }
  return access;
}

/** Refuse a removed or role-incompatible membership before route scope checks. */
export async function authorizeBearerMembership(
  access: TokenMembershipAccess,
  userId: string,
  scopes: readonly string[],
): Promise<AuthResult | null> {
  const claims = membershipClaimsInScopes(scopes);
  if (claims.length === 0) return null;
  return (await access.authorize(userId, claims)) ? null : MEMBERSHIP_REFUSED;
}

export function authorizeResolvedBearerMembership(
  memberships: PrincipalMemberships,
  scopes: readonly string[],
): AuthResult | null {
  const claims = membershipClaimsInScopes(scopes);
  if (claims.length === 0) return null;
  return claimsHold(memberships, claims) ? null : MEMBERSHIP_REFUSED;
}

/**
 * Recheck live membership after another resolver has accepted the request.
 * Used by the MCP Control Plane door, which copies minted scopes from the
 * delegation and would otherwise skip the public-bearer recheck.
 */
export function withBearerMembershipCheck(
  resolver: AuthResolver,
  access: TokenMembershipAccess,
): AuthResolver {
  return async (request) => {
    const result = await resolver(request);
    if (!result.ok) return result;
    return (
      (await authorizeBearerMembership(access, result.principal.id, result.principal.scopes)) ??
      result
    );
  };
}

function claimsHold(
  memberships: PrincipalMemberships,
  claims: readonly MembershipClaim[],
): boolean {
  const organizationRoles = new Map(
    memberships.organizations.map(({ id, role }) => [id, role] as const),
  );
  const appMemberships = new Map(memberships.apps.map((membership) => [membership.id, membership]));
  return claims.every((claim) => claimHolds(organizationRoles, appMemberships, claim));
}

function claimHolds(
  organizationRoles: ReadonlyMap<string, UserRole>,
  appMemberships: ReadonlyMap<string, PrincipalMemberships["apps"][number]>,
  claim: MembershipClaim,
): boolean {
  if (claim.axis === "org") {
    return roleCovers(organizationRoles.get(claim.id), claim.role);
  }

  const appMembership = appMemberships.get(claim.id);
  return (
    roleCovers(appMembership?.role, claim.role) &&
    appMembership !== undefined &&
    organizationRoles.has(appMembership.organizationId)
  );
}

function roleCovers(actual: string | undefined, claimed: MembershipRole): boolean {
  const parsed = UserRoleSchema.safeParse(actual);
  return parsed.success && ROLE_RANK[parsed.data] >= ROLE_RANK[claimed];
}
