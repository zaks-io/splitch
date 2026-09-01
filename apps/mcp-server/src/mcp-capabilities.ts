import {
  deriveMcpTools,
  getRouteMembershipGate,
  membershipGatePatterns,
  scopeSatisfiesMembershipGate,
} from "@splitch/contracts";
export interface McpEffectiveAuthority {
  readonly scopes: readonly string[];
  readonly membershipWideRead: boolean;
}

interface McpToolCapability {
  readonly name: string;
  readonly gate: readonly string[];
  readonly grantedBy: readonly string[];
}

interface McpCapabilitiesResource {
  readonly scopes: readonly string[];
  readonly tools: readonly McpToolCapability[];
}

export function buildCapabilitiesResource(
  authority: McpEffectiveAuthority,
): McpCapabilitiesResource {
  const tools = deriveMcpTools().map((tool) => {
    const gate = membershipGatePatterns(getRouteMembershipGate(tool.name));
    const scopeGrants = authority.scopes.filter((scope) =>
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
  return { scopes: [...authority.scopes], tools };
}
