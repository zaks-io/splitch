import {
  deriveMcpTools,
  getRouteMembershipGate,
  membershipGatePatterns,
  scopeSatisfiesMembershipGate,
} from "@splitch/contracts";
import type { McpAccessTokenActor } from "./mcp-access-token";

interface McpToolCapability {
  readonly name: string;
  readonly gate: readonly string[];
  readonly grantedBy: readonly string[];
}

interface McpCapabilitiesResource {
  readonly scopes: readonly string[];
  readonly tools: readonly McpToolCapability[];
}

export function buildCapabilitiesResource(actor: McpAccessTokenActor): McpCapabilitiesResource {
  const tools = deriveMcpTools().map((tool) => {
    const gate = membershipGatePatterns(getRouteMembershipGate(tool.name));
    return {
      name: tool.name,
      gate,
      grantedBy: actor.scopes.filter((scope) =>
        gate.some((pattern) => scopeSatisfiesMembershipGate(scope, pattern)),
      ),
    };
  });
  return { scopes: [...actor.scopes], tools };
}
