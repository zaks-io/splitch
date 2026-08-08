import { describe, expect, it } from "vitest";
import {
  getRouteMembershipGate,
  membershipGatePatterns,
  membershipRoles,
  scopeSatisfiesMembershipGate,
} from "./mcp-tool-membership-gates";
import { isMcpToolRoute } from "./mcp-tools";
import { routeRegistry } from "./route-registry";

/**
 * The gate every MCP tool advertises, pinned by value. Rewriting a gate in the
 * module is meant to cost a second, deliberate edit here. A gate that only had to
 * exist could be relaxed to `token` across the board with every suite green.
 */
const EXPECTED_GATES: Record<string, string> = {
  organizations_list: "token",
  organizations_create: "token",
  organizations_get: "org:member",
  organizations_update: "org:owner",
  organizations_delete: "org:owner",
  organization_members_list: "org:admin",
  organization_members_add: "org:admin",
  organization_members_update: "org:owner",
  organization_members_remove: "org:owner",
  apps_list: "org:member",
  apps_create: "org:admin",
  apps_get: "app:member",
  app_attention_rollup_get: "app:member",
  apps_update: "app:admin",
  apps_delete: "app:owner",
  environments_list: "app:member",
  environments_create: "app:admin",
  environments_get: "app:member",
  environments_update: "app:admin",
  environments_delete: "app:owner",
  approval_requests_list: "app:member",
  approval_requests_get: "app:member",
  approval_request_reviews_create: "app:member",
  flags_list: "app:member",
  flags_create: "app:admin",
  flags_get: "app:member",
  flags_update: "app:admin",
  flags_delete: "app:admin",
  flag_variants_create: "app:admin",
  flag_variants_update: "app:admin",
  flag_variants_delete: "app:admin",
  flag_config_get: "app:member",
  flag_config_update: "app:admin",
  flag_targeting_rules_replace: "app:admin",
  flags_promote: "app:admin",
  segments_list: "app:member",
  segments_create: "app:admin",
  segments_get: "app:member",
  segments_update: "app:admin",
  segments_delete: "app:admin",
  event_definitions_list: "app:member",
  event_definitions_create: "app:admin",
  event_definitions_get: "app:member",
  event_definitions_update: "app:admin",
  event_definition_versions_create: "app:admin",
  event_definition_versions_list: "app:member",
  event_definition_versions_get: "app:member",
  experiments_list: "app:member",
  experiments_create: "app:admin",
  experiments_get: "app:member",
  experiments_update: "app:admin",
  experiments_delete: "app:admin",
  experiments_start: "app:admin",
  runs_list: "app:member",
  runs_get: "app:member",
  runs_end: "app:admin",
  metrics_list: "app:member",
  metrics_create: "app:admin",
  metrics_get: "app:member",
  metrics_update: "app:admin",
  metrics_delete: "app:admin",
  client_key_get: "app:admin",
  client_key_update: "app:admin",
  client_key_rotate: "app:admin",
  api_keys_list: "app:admin",
  api_keys_create: "app:admin",
  api_keys_revoke: "app:admin",
  flags_test_eval: "app:member",
  experiment_results_get: "app:member",
  experiment_results_post: "app:member",
  organization_usage_get: "org:member",
  current_user_privacy_export: "token",
  current_user_delete: "token",
  organization_privacy_export: "org:owner",
  app_privacy_export: "app:admin",
  entity_privacy_export: "app:admin",
  entity_privacy_delete: "app:admin",
  privacy_requests_get: "token",
};

describe("mcp tool membership gates", () => {
  it("covers every MCP tool route, and only those", () => {
    const toolOperationIds = routeRegistry
      .filter(isMcpToolRoute)
      .map((route) => route.operationId)
      .sort();
    expect(Object.keys(EXPECTED_GATES).sort()).toEqual(toolOperationIds);
  });

  it("pins the gate of every MCP tool by value", () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_GATES).map((operationId) => [
        operationId,
        membershipGatePatterns(getRouteMembershipGate(operationId)).join(","),
      ]),
    );
    expect(actual).toEqual(EXPECTED_GATES);
  });

  it.each(membershipRoles)("evaluates a gate for %s, the whole User role vocabulary", (role) => {
    expect(scopeSatisfiesMembershipGate(`app:app_local:${role}`, `app:${role}`)).toBe(true);
    expect(scopeSatisfiesMembershipGate(`org:org_local:${role}`, `org:${role}`)).toBe(true);
    expect(scopeSatisfiesMembershipGate(`app:app_local:${role}`, `org:${role}`)).toBe(false);
  });

  it("requires org owner for organizations_update, not org admin", () => {
    const gate = membershipGatePatterns(getRouteMembershipGate("organizations_update"));
    expect(gate).toEqual(["org:owner"]);
    expect(scopeSatisfiesMembershipGate("org:org_local:admin", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("org:org_local:owner", gate[0] as string)).toBe(true);
  });

  it("requires org admin for organization_members_list, not org member", () => {
    const gate = membershipGatePatterns(getRouteMembershipGate("organization_members_list"));
    expect(gate).toEqual(["org:admin"]);
    expect(scopeSatisfiesMembershipGate("org:org_local:member", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("org:org_local:admin", gate[0] as string)).toBe(true);
    expect(scopeSatisfiesMembershipGate("org:org_local:owner", gate[0] as string)).toBe(true);
  });

  it("requires app owner for app deletes while writes stop at app admin", () => {
    const deleteGate = membershipGatePatterns(getRouteMembershipGate("apps_delete"));
    const updateGate = membershipGatePatterns(getRouteMembershipGate("apps_update"));
    expect(deleteGate).toEqual(["app:owner"]);
    expect(updateGate).toEqual(["app:admin"]);
    expect(scopeSatisfiesMembershipGate("app:app_local:admin", deleteGate[0] as string)).toBe(
      false,
    );
    expect(scopeSatisfiesMembershipGate("app:app_local:admin", updateGate[0] as string)).toBe(true);
    expect(scopeSatisfiesMembershipGate("app:app_local:owner", deleteGate[0] as string)).toBe(true);
  });

  it("requires live App membership for the attention rollup", () => {
    const gate = membershipGatePatterns(getRouteMembershipGate("app_attention_rollup_get"));
    expect(gate).toEqual(["app:member"]);
    expect(scopeSatisfiesMembershipGate("org:org_local:owner", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("app:app_local:member", gate[0] as string)).toBe(true);
  });

  it.each([
    ["flags_delete", "flag catalog deletes"],
    ["flag_variants_delete", "flag variant deletes"],
    ["segments_delete", "segment deletes"],
    ["experiments_delete", "experiment deletes"],
    ["metrics_delete", "metric deletes"],
  ] as const)("requires app admin for %s (%s), not app member", (operationId, _description) => {
    const gate = membershipGatePatterns(getRouteMembershipGate(operationId));
    expect(gate).toEqual(["app:admin"]);
    expect(scopeSatisfiesMembershipGate("app:app_local:member", gate[0] as string)).toBe(false);
    expect(scopeSatisfiesMembershipGate("app:app_local:admin", gate[0] as string)).toBe(true);
    expect(scopeSatisfiesMembershipGate("app:app_local:owner", gate[0] as string)).toBe(true);
  });
});
