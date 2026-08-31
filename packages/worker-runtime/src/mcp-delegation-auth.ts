import {
  type McpDelegationActor,
  type McpDelegationReplayGuard,
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
}): AuthResolver {
  return async (request) => {
    const actor = await parseMcpDelegation({ request, ...options });
    if (!actor) return { ok: false, reason: "UNAUTHORIZED" };
    return { ok: true, principal: await principalFromActor(actor, options.resolveLiveScopes) };
  };
}

async function principalFromActor(
  actor: McpDelegationActor,
  resolveLiveScopes: ((subject: string) => Promise<string[]>) | undefined,
): Promise<Principal> {
  const scopes = await actorScopes(actor, resolveLiveScopes);
  return {
    kind: "control-plane-token",
    id: actor.subject,
    scopes,
    orgId: soleId(idsInScopes(scopes, ORG_SCOPE)),
    appId: soleId(idsInScopes(scopes, APP_SCOPE)),
    environmentId: null,
    authDoor: actor.authDoor,
    ...(actor.liveMembership ? { liveMembership: true } : {}),
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
