import {
  type McpDelegationReplayGuard,
  parseMcpDelegation,
  type RouteOwner,
} from "@splitch/contracts";
import type { AuthResolver, Principal } from "./principal";

const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;
const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
export function makeMcpDelegationAuthResolver(options: {
  owner: RouteOwner;
  secret: string;
  replayGuard: McpDelegationReplayGuard;
}): AuthResolver {
  return async (request) => {
    const actor = await parseMcpDelegation({ request, ...options });
    if (!actor) return { ok: false, reason: "UNAUTHORIZED" };
    return { ok: true, principal: principalFromActor(actor.subject, actor.scopes) };
  };
}

function principalFromActor(subject: string, scopes: readonly string[]): Principal {
  return {
    kind: "control-plane-token",
    id: subject,
    scopes,
    orgId: soleId(idsInScopes(scopes, ORG_SCOPE)),
    appId: soleId(idsInScopes(scopes, APP_SCOPE)),
    environmentId: null,
  };
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
