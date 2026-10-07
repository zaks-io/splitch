import {
  type McpDelegationActor,
  type McpDelegationReplayGuard,
  type PersonalAccessTokenAuthority,
  type PublicSurface,
  parseMcpDelegation,
} from "@splitch/contracts";
import type { AuthResolver, Principal } from "./principal";

const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;
const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
/**
 * MCP addresses an operation at the PUBLIC SURFACE its credential belongs to, not
 * at the Worker that executes it (ADR-0046), so only a public surface can accept
 * an MCP delegation. A Worker that merely owns delegated routes has no MCP door:
 * it is reached over the surface's own binding, after the surface's gates.
 */
export function makeMcpDelegationAuthResolver(options: {
  surface: PublicSurface;
  secret: string;
  replayGuard: McpDelegationReplayGuard;
  resolveLiveScopes?: (subject: string) => Promise<string[]>;
  /** Required on a surface that accepts Personal Access Token delegations. */
  resolvePersonalAccessToken?: PersonalAccessTokenResolver;
}): AuthResolver {
  return async (request) => {
    const actor = await parseMcpDelegation({ request, ...options });
    if (!actor) return { ok: false, reason: "UNAUTHORIZED" };
    if (actor.personalAccessTokenId && actor.personalAccessTokenHash) {
      return personalAccessTokenPrincipal(
        actor,
        { tokenId: actor.personalAccessTokenId, tokenHash: actor.personalAccessTokenHash },
        options.resolvePersonalAccessToken,
      );
    }
    return { ok: true, principal: await principalFromActor(actor, options.resolveLiveScopes) };
  };
}

/**
 * Re-read a Personal Access Token and clamp live membership by its grants.
 * Returns null when the token is unknown, revoked, expired, rotated (the hash no
 * longer matches), or not owned by the delegation subject.
 */
export type PersonalAccessTokenResolver = (token: {
  subject: string;
  tokenId: string;
  tokenHash: string;
}) => Promise<PersonalAccessTokenAuthority | null>;

async function personalAccessTokenPrincipal(
  actor: McpDelegationActor,
  token: { tokenId: string; tokenHash: string },
  resolve: PersonalAccessTokenResolver | undefined,
): Promise<Awaited<ReturnType<AuthResolver>>> {
  if (!resolve) {
    throw new Error("worker-runtime: Personal Access Token resolver is required");
  }
  const authority = await resolve({ subject: actor.subject, ...token });
  if (!authority) {
    return {
      ok: false,
      reason: "CREDENTIAL_REVOKED",
      error: {
        code: "CREDENTIAL_REVOKED",
        message: "personal access token is revoked, rotated, expired, or unknown",
        details: {},
      },
    };
  }
  return {
    ok: true,
    principal: {
      ...principalFromScopes(actor, authority.scopes),
      personalAccessToken: {
        id: token.tokenId,
        writeScopes: authority.writeScopes,
        writeAll: authority.writeAll,
      },
    },
  };
}

async function principalFromActor(
  actor: McpDelegationActor,
  resolveLiveScopes: ((subject: string) => Promise<string[]>) | undefined,
): Promise<Principal> {
  return principalFromScopes(actor, await actorScopes(actor, resolveLiveScopes));
}

function principalFromScopes(actor: McpDelegationActor, scopes: readonly string[]): Principal {
  return {
    kind: "control-plane-token",
    id: actor.subject,
    scopes,
    ...scopeBinding(scopes),
    environmentId: null,
    authDoor: actor.authDoor,
    ...(actor.liveMembership ? { liveMembership: true } : {}),
  };
}

/** The single Org/App a scope set names, or null on an axis it names zero or many of. */
export function scopeBinding(scopes: readonly string[]): {
  orgId: string | null;
  appId: string | null;
} {
  return {
    orgId: soleId(idsInScopes(scopes, ORG_SCOPE)),
    appId: soleId(idsInScopes(scopes, APP_SCOPE)),
  };
}

async function actorScopes(
  actor: McpDelegationActor,
  resolveLiveScopes: ((subject: string) => Promise<string[]>) | undefined,
): Promise<readonly string[]> {
  if (!actor.liveMembership) return actor.scopes;
  if (!resolveLiveScopes) {
    throw new Error("worker-runtime: live MCP membership resolver is required");
  }
  return resolveLiveScopes(actor.subject);
}

function idsInScopes(scopes: readonly string[], pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const match = pattern.exec(scope);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

function soleId(ids: Set<string>): string | null {
  return ids.size === 1 ? ([...ids][0] as string) : null;
}
