import { type UserRole, UserRoleSchema } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { AuthResult } from "@splitch/worker-runtime";
import {
  type MembershipClaim,
  type MembershipRole,
  membershipClaimsInScopes,
} from "./scope-binding";

/**
 * Live D1 membership recheck for human/agent bearer tokens (SPL-482).
 *
 * Token scopes are minted from membership at issue time. Removal or demotion
 * must fail the next request, so this port reads current Org and App rows
 * before the registrar's scope checks. Tokens that carry no membership axes
 * (service credentials whose authority does not derive from membership) skip
 * the read.
 */

export interface TokenMembershipAccess {
  authorize(userId: string, claims: readonly MembershipClaim[]): Promise<boolean>;
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
): TokenMembershipAccess {
  return {
    async authorize(userId, claims) {
      const results = await Promise.all(claims.map((claim) => claimHolds(repo, userId, claim)));
      return results.every(Boolean);
    },
  };
}

/** Refuse a removed or role-incompatible membership before route scope checks. */
export async function authorizeBearerMembership(
  access: TokenMembershipAccess | undefined,
  userId: string,
  scopes: readonly string[],
): Promise<AuthResult | null> {
  const claims = membershipClaimsInScopes(scopes);
  if (claims.length === 0) return null;
  if (!access) return null;
  return (await access.authorize(userId, claims)) ? null : MEMBERSHIP_REFUSED;
}

async function claimHolds(
  repo: Pick<Repository, "identity">,
  userId: string,
  claim: MembershipClaim,
): Promise<boolean> {
  if (claim.axis === "org") {
    const membership = await repo.identity.getOrgMembership(claim.id, userId);
    return roleCovers(membership?.role, claim.role);
  }

  // App access is derived from both axes: Org removal must invalidate the
  // App-scoped token even if the App row is still present.
  const [appMembership, orgMembership] = await Promise.all([
    repo.identity.getAppMembership(appScope(claim.id), userId),
    repo.identity.getOrgMembershipForApp(claim.id, userId),
  ]);
  return roleCovers(appMembership?.role, claim.role) && orgMembership !== null;
}

function roleCovers(actual: string | undefined, claimed: MembershipRole): boolean {
  const parsed = UserRoleSchema.safeParse(actual);
  return parsed.success && ROLE_RANK[parsed.data] >= ROLE_RANK[claimed];
}
