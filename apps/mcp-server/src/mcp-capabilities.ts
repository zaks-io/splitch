import {
  deriveMcpTools,
  getRoute,
  getRouteMembershipGate,
  membershipGatePatterns,
  type PersonalAccessTokenAuthority,
  scopeSatisfiesMembershipGate,
} from "@splitch/contracts";
export interface McpEffectiveAuthority {
  readonly scopes: readonly string[];
  readonly membershipWideRead: boolean;
  /** Present for a Personal Access Token, with authority for each permission. */
  readonly personalAccessToken?: {
    readonly id: string;
    readonly permissions: PersonalAccessTokenAuthority["permissions"];
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
 * A tool advertises only scopes carrying its declared permission. A derived
 * Approval Review still checks the stored proposal when it is applied.
 */
function grantingScopes(authority: McpEffectiveAuthority, toolName: string): readonly string[] {
  const token = authority.personalAccessToken;
  const route = getRoute(toolName);
  if (!token) return authority.scopes;
  if (route?.auth !== "control-plane-token") return [];
  switch (route.permission) {
    case "read":
    case "owner-cleanup":
    case "derived":
      return authority.scopes;
    case "session-only":
      return [];
    default: {
      const permission = token.permissions[route.permission];
      const targeted = /:(orgId|appId)\b/.test(route.path);
      return targeted || permission.all ? permission.scopes : [];
    }
  }
}
