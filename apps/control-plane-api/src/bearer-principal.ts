import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import type { JwksVerifier } from "./jwks-verify";
import { deriveBinding, membershipClaimsInScopes } from "./scope-binding";
import type { SessionStore } from "./session-store";
import {
  authorizeBearerMembership,
  authorizeResolvedBearerMembership,
  requireTokenMembershipAccess,
  type resolveBearerMemberships,
  type TokenMembershipAccess,
} from "./token-membership";

const BEARER_PREFIX = "Bearer ";

export interface BearerAuthDeps {
  verifier: JwksVerifier;
  sessions: SessionStore;
  membershipAccess: TokenMembershipAccess;
}

export async function resolveBearerPrincipal(
  request: Request,
  deps: BearerAuthDeps,
  nowSeconds: number,
) {
  const token = extractBearer(request.headers.get("authorization"));
  if (!token) return { ok: false as const, reason: "UNAUTHORIZED" as const };

  const verified = await deps.verifier.verify(token, nowSeconds);
  if (!verified) return { ok: false as const, reason: "UNAUTHORIZED" as const };

  const access = requireTokenMembershipAccess(deps.membershipAccess);
  const claimsMembership = membershipClaimsInScopes(verified.scopes).length > 0;
  const wide = verified.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION;
  const current = await resolveCurrentAuthority(deps, access, verified.sub, claimsMembership, wide);
  if (current.revoked) {
    return { ok: false as const, reason: "CREDENTIAL_REVOKED" as const };
  }

  const membership = current.memberships
    ? authorizeResolvedBearerMembership(current.memberships, verified.scopes)
    : await authorizeBearerMembership(access, verified.sub, verified.scopes);
  if (membership) return membership;

  if (wide) {
    if (!current.memberships) {
      throw new Error("control-plane: wide authorization requires resolved memberships");
    }
    return {
      ok: true as const,
      principal: {
        kind: "control-plane-token" as const,
        id: verified.sub,
        scopes: [],
        orgId: null,
        appId: null,
        environmentId: null,
        authDoor: verified.authDoor,
        authorization: verified.authorization,
        memberships: current.memberships,
      },
    };
  }

  const binding = deriveBinding(verified.scopes);
  return {
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: verified.sub,
      scopes: verified.scopes,
      orgId: binding.orgId,
      appId: binding.appId,
      environmentId: binding.environmentId,
      authDoor: verified.authDoor,
    },
  };
}

async function resolveCurrentAuthority(
  deps: Pick<BearerAuthDeps, "sessions">,
  access: TokenMembershipAccess,
  userId: string,
  claimsMembership: boolean,
  wide: boolean,
): Promise<{
  revoked: boolean;
  memberships: Awaited<ReturnType<typeof resolveBearerMemberships>> | null;
}> {
  const concurrentResolver = access.resolveForRequest ?? (wide ? access.resolve : undefined);
  const membershipRead =
    concurrentResolver && (claimsMembership || wide)
      ? concurrentResolver(userId)
      : Promise.resolve(null);
  const [revocation, memberships] = await Promise.allSettled([
    deps.sessions.isRevoked(userId),
    membershipRead,
  ]);
  if (revocation.status === "rejected") throw revocation.reason;
  // Preserve the existing precedence: a revoked session is refused without a
  // membership fault changing that ordinary credential outcome into a 500.
  if (revocation.value) return { revoked: true, memberships: null };
  if (memberships.status === "rejected") throw memberships.reason;
  return { revoked: false, memberships: memberships.value };
}

function extractBearer(header: string | null): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
