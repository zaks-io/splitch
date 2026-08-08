import { type UserRole, userRoles } from "./leaf-schemas-runtime";
import { isMcpToolRoute } from "./mcp-tools";
import type { ApiRouteContract } from "./openapi-route";
import { routeRegistry } from "./route-registry";

/**
 * Canonical membership gate for each MCP-exposed control-plane route. Mirrors the
 * Control Plane / Analysis Worker handler authorization (org-authz, app-authz) —
 * not HTTP verb heuristics. Validated at module load against the route registry.
 */

export const membershipAxes = ["token", "org", "app"] as const;
export type MembershipAxis = (typeof membershipAxes)[number];

export const membershipRoles = userRoles;
export type MembershipRole = UserRole;

export interface RouteMembershipGate {
  readonly axis: MembershipAxis;
  readonly minimumRole?: MembershipRole;
}

const TOKEN: RouteMembershipGate = { axis: "token" };
const ORG_MEMBER: RouteMembershipGate = { axis: "org", minimumRole: "member" };
const ORG_ADMIN: RouteMembershipGate = { axis: "org", minimumRole: "admin" };
const ORG_OWNER: RouteMembershipGate = { axis: "org", minimumRole: "owner" };
const APP_MEMBER: RouteMembershipGate = { axis: "app", minimumRole: "member" };
const APP_ADMIN: RouteMembershipGate = { axis: "app", minimumRole: "admin" };
const APP_OWNER: RouteMembershipGate = { axis: "app", minimumRole: "owner" };

const MCP_TOOL_MEMBERSHIP_GATES = {
  organizations_list: TOKEN,
  // No Org exists yet to hold a role in, so there is no org axis to gate on. The
  // handler applies the real gate: a provisional principal may not create one.
  organizations_create: TOKEN,
  organizations_get: ORG_MEMBER,
  organizations_update: ORG_OWNER,
  organizations_delete: ORG_OWNER,
  organization_members_list: ORG_ADMIN,
  organization_members_add: ORG_ADMIN,
  organization_members_update: ORG_OWNER,
  organization_members_remove: ORG_OWNER,
  apps_list: ORG_MEMBER,
  apps_create: ORG_ADMIN,
  apps_get: APP_MEMBER,
  app_attention_rollup_get: APP_MEMBER,
  apps_update: APP_ADMIN,
  apps_delete: APP_OWNER,
  environments_list: APP_MEMBER,
  environments_create: APP_ADMIN,
  environments_get: APP_MEMBER,
  environments_update: APP_ADMIN,
  environments_delete: APP_OWNER,
  approval_requests_list: APP_MEMBER,
  approval_requests_get: APP_MEMBER,
  approval_request_reviews_create: APP_MEMBER,
  flags_list: APP_MEMBER,
  flags_create: APP_ADMIN,
  flags_get: APP_MEMBER,
  flags_update: APP_ADMIN,
  flags_delete: APP_ADMIN,
  flag_variants_create: APP_ADMIN,
  flag_variants_update: APP_ADMIN,
  flag_variants_delete: APP_ADMIN,
  flag_config_get: APP_MEMBER,
  flag_config_update: APP_ADMIN,
  flag_targeting_rules_replace: APP_ADMIN,
  flags_promote: APP_ADMIN,
  segments_list: APP_MEMBER,
  segments_create: APP_ADMIN,
  segments_get: APP_MEMBER,
  segments_update: APP_ADMIN,
  segments_delete: APP_ADMIN,
  event_definitions_list: APP_MEMBER,
  event_definitions_create: APP_ADMIN,
  event_definitions_get: APP_MEMBER,
  event_definitions_update: APP_ADMIN,
  event_definition_versions_create: APP_ADMIN,
  event_definition_versions_list: APP_MEMBER,
  event_definition_versions_get: APP_MEMBER,
  experiments_list: APP_MEMBER,
  experiments_create: APP_ADMIN,
  experiments_get: APP_MEMBER,
  experiments_update: APP_ADMIN,
  experiments_delete: APP_ADMIN,
  experiments_start: APP_ADMIN,
  runs_list: APP_MEMBER,
  runs_get: APP_MEMBER,
  runs_end: APP_ADMIN,
  metrics_list: APP_MEMBER,
  metrics_create: APP_ADMIN,
  metrics_get: APP_MEMBER,
  metrics_update: APP_ADMIN,
  metrics_delete: APP_ADMIN,
  client_key_get: APP_ADMIN,
  client_key_update: APP_ADMIN,
  client_key_rotate: APP_ADMIN,
  api_keys_list: APP_ADMIN,
  api_keys_create: APP_ADMIN,
  api_keys_revoke: APP_ADMIN,
  flags_test_eval: APP_MEMBER,
  experiment_results_get: APP_MEMBER,
  experiment_results_post: APP_MEMBER,
  organization_usage_get: ORG_MEMBER,
  current_user_privacy_export: TOKEN,
  current_user_delete: TOKEN,
  organization_privacy_export: ORG_OWNER,
  app_privacy_export: APP_ADMIN,
  entity_privacy_export: APP_ADMIN,
  entity_privacy_delete: APP_ADMIN,
  privacy_requests_get: TOKEN,
} as const satisfies Record<string, RouteMembershipGate>;

export type McpToolOperationId = keyof typeof MCP_TOOL_MEMBERSHIP_GATES;

export function getRouteMembershipGate(operationId: string): RouteMembershipGate {
  const gate = MCP_TOOL_MEMBERSHIP_GATES[operationId as McpToolOperationId];
  if (!gate) {
    throw new Error(`mcp-tool-membership-gates: missing gate for operation "${operationId}"`);
  }
  return gate;
}

export function membershipGatePatterns(gate: RouteMembershipGate): readonly string[] {
  if (gate.axis === "token") return ["token"];
  return [`${gate.axis}:${gate.minimumRole}`];
}

/**
 * Derived from the role vocabulary, not retyped. A hard-coded alternation fails
 * silently when a role is added: the new role simply matches no gate. `ROLE_RANK`
 * below stays an explicit table because rank is ordering, not membership, and its
 * `Record` type turns the same addition into a compile error.
 */
const roleAlternation = membershipRoles.join("|");
const APP_SCOPE = new RegExp(`^app:([^:]+):(${roleAlternation})$`);
const ORG_SCOPE = new RegExp(`^org:([^:]+):(${roleAlternation})$`);

const ROLE_RANK: Record<MembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export function scopeSatisfiesMembershipGate(heldScope: string, gate: string): boolean {
  if (gate === "token") return heldScope.length > 0;
  const [axis, minimumRole] = gate.split(":") as [MembershipAxis, MembershipRole];
  const match = (axis === "app" ? APP_SCOPE : ORG_SCOPE).exec(heldScope);
  if (!match) return false;
  return ROLE_RANK[match[2] as MembershipRole] >= ROLE_RANK[minimumRole];
}

function assertMcpToolMembershipGates(routes: readonly ApiRouteContract[]): void {
  const mcpRoutes = routes.filter(isMcpToolRoute);
  for (const route of mcpRoutes) {
    if (!(route.operationId in MCP_TOOL_MEMBERSHIP_GATES)) {
      throw new Error(
        `mcp-tool-membership-gates: route "${route.operationId}" is an MCP tool but has no gate`,
      );
    }
  }
  for (const operationId of Object.keys(MCP_TOOL_MEMBERSHIP_GATES)) {
    const route = routes.find((candidate) => candidate.operationId === operationId);
    if (!route || !isMcpToolRoute(route)) {
      throw new Error(
        `mcp-tool-membership-gates: gate "${operationId}" does not match an MCP tool route`,
      );
    }
  }
}

assertMcpToolMembershipGates(routeRegistry);
