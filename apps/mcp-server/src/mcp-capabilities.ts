import { deriveMcpTools, isMcpToolRoute, routeRegistry } from "@splitch/contracts";
import type { McpAccessTokenActor } from "./mcp-access-token";

const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;

type ScopeAxis = "app" | "org";
type ScopeRole = "owner" | "admin" | "member";

export interface McpToolCapability {
  readonly name: string;
  readonly gate: readonly string[];
  readonly grantedBy: readonly string[];
}

export interface McpCapabilitiesResource {
  readonly scopes: readonly string[];
  readonly tools: readonly McpToolCapability[];
}

const ROLE_RANK: Record<ScopeRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export function buildCapabilitiesResource(actor: McpAccessTokenActor): McpCapabilitiesResource {
  const tools = deriveMcpTools().map((tool) => {
    const route = routeRegistry.find((candidate) => candidate.operationId === tool.name);
    if (!route || !isMcpToolRoute(route)) {
      throw new Error(`mcp-server: missing MCP route for tool "${tool.name}"`);
    }
    const gate = gatePatternsForRoute(route.method, route.path);
    return {
      name: tool.name,
      gate,
      grantedBy: actor.scopes.filter((scope) => gate.some((pattern) => scopeSatisfiesGate(scope, pattern))),
    };
  });
  return { scopes: [...actor.scopes], tools };
}

function gatePatternsForRoute(method: string, path: string): string[] {
  if (!path.includes(":orgId") && !path.includes(":appId")) {
    return ["token"];
  }
  const axis: ScopeAxis = path.includes(":appId") ? "app" : "org";
  const minimumRole = writeRoleForMethod(method);
  return [`${axis}:${minimumRole}`];
}

function writeRoleForMethod(method: string): ScopeRole {
  if (method === "DELETE") return "owner";
  if (method === "GET" || method === "HEAD") return "member";
  return "admin";
}

function scopeSatisfiesGate(heldScope: string, gate: string): boolean {
  if (gate === "token") return heldScope.length > 0;
  const [axis, minimumRole] = gate.split(":") as [ScopeAxis, ScopeRole];
  const match = (axis === "app" ? APP_SCOPE : ORG_SCOPE).exec(heldScope);
  if (!match) return false;
  return ROLE_RANK[match[2] as ScopeRole] >= ROLE_RANK[minimumRole];
}
