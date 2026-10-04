import {
  deriveMcpTools,
  getRoute,
  getRouteMembershipGate,
  membershipGatePatterns,
  scopeSatisfiesMembershipGate,
} from "@splitch/contracts";
export interface McpEffectiveAuthority {
  readonly scopes: readonly string[];
  readonly membershipWideRead: boolean;
  /** Present for a Personal Access Token: mutations are limited to its write grants. */
  readonly personalAccessToken?: {
    readonly id: string;
    readonly writeScopes: readonly string[];
    readonly writeAll: boolean;
  };
}

interface McpToolCapability {
  readonly name: string;
  readonly gate: readonly string[];
  readonly grantedBy: readonly string[];
}

interface McpCapabilitiesResource {
  readonly scopes: readonly string[];
  readonly personalAccessToken?: McpEffectiveAuthority["personalAccessToken"];
  readonly tools: readonly McpToolCapability[];
}

export function buildCapabilitiesResource(
  authority: McpEffectiveAuthority,
): McpCapabilitiesResource {
  const tools = deriveMcpTools().map((tool) => {
    const gate = membershipGatePatterns(getRouteMembershipGate(tool.name));
    const scopeGrants = grantingScopes(authority, tool.name).filter((scope) =>
      gate.some((pattern) => scopeSatisfiesMembershipGate(scope, pattern)),
    );
    return {
      name: tool.name,
      gate,
      grantedBy:
        authority.membershipWideRead && gate.includes("membership-wide-read")
          ? [...scopeGrants, "membership-wide-read"]
          : scopeGrants,
    };
  });
  return {
    scopes: [...authority.scopes],
    ...(authority.personalAccessToken
      ? { personalAccessToken: authority.personalAccessToken }
      : {}),
    tools,
  };
}

/**
 * The scopes that may grant one tool. A Personal Access Token's mutating calls
 * are narrowed to its write grants, and a mutation naming no Organization or App
 * needs a read-write `all` grant, so the resource must not advertise more.
 */
function grantingScopes(authority: McpEffectiveAuthority, toolName: string): readonly string[] {
  const token = authority.personalAccessToken;
  const route = getRoute(toolName);
  if (!token || route?.effects.mutates === false) return authority.scopes;
  const targeted = /:(orgId|appId)\b/.test(route?.path ?? "");
  return targeted || token.writeAll ? token.writeScopes : [];
}
