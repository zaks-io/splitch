import { describe, expect, it } from "vitest";
import {
  type ApiRouteContract,
  type DefineApiRouteInput,
  defineApiRoute,
  z,
} from "./openapi-route";
import { defineRoute, type RouteContract, type RoutePermission } from "./route-contract";
import { deleteClosed, readOnlyClosed, updateClosed } from "./route-effects";
import { assertRegistry, getRoute, routeRegistry } from "./route-registry";

const expectedOperations: Record<RoutePermission, readonly string[]> = {
  read: [
    "api_keys_list",
    "app_attention_rollup_get",
    "app_audit_list",
    "app_members_list",
    "approval_requests_get",
    "approval_requests_list",
    "apps_get",
    "apps_list",
    "cloudflare_installations_list",
    "convex_installations_list",
    "environment_exposure_status_get",
    "environments_get",
    "environments_list",
    "event_definition_versions_get",
    "event_definition_versions_list",
    "event_definitions_get",
    "event_definitions_list",
    "experiment_plan",
    "experiment_results_get",
    "experiment_results_post",
    "experiments_get",
    "experiments_list",
    "expired_flags_list",
    "flag_changes_export",
    "flag_changes_list",
    "flag_config_get",
    "flag_inventory_health_get",
    "flag_removal_brief",
    "flags_get",
    "flags_list",
    "flags_test_eval",
    "metrics_get",
    "metrics_list",
    "organization_members_list",
    "organization_usage_get",
    "organizations_get",
    "organizations_list",
    "principal_capabilities_get",
    "principal_flags_list",
    "privacy_requests_get",
    "runs_get",
    "runs_list",
    "segments_get",
    "segments_list",
    "sentry_installations_get",
    "sentry_installations_list",
    "stale_flags_list",
  ],
  write: [
    "apps_create",
    "apps_update",
    "client_key_get",
    "conclusion_promotion_requests_create",
    "environments_create",
    "environments_sync",
    "environments_update",
    "event_definition_versions_create",
    "event_definitions_create",
    "event_definitions_update",
    "experiments_create",
    "experiments_start",
    "experiments_update",
    "flag_config_update",
    "flag_targeting_rules_replace",
    "flag_variants_create",
    "flag_variants_update",
    "flags_create",
    "flags_promote",
    "flags_update",
    "metrics_create",
    "metrics_update",
    "organizations_create",
    "runs_conclude",
    "runs_end",
    "segments_create",
    "segments_update",
  ],
  delete: [
    "apps_delete",
    "environments_delete",
    "experiments_delete",
    "flag_variants_delete",
    "flags_delete",
    "metrics_delete",
    "organizations_delete",
    "segments_delete",
  ],
  credentials: [
    "api_keys_create",
    "api_keys_revoke",
    "client_key_rotate",
    "client_key_update",
    "cloudflare_installations_revoke",
    "convex_installations_revoke",
    "integration_deliveries_create",
    "sentry_installations_create",
    "sentry_installations_delete",
    "sentry_secret_rotations_create",
  ],
  members: [
    "app_members_add",
    "app_members_remove",
    "app_members_update",
    "organization_members_add",
    "organization_members_remove",
    "organization_members_update",
    "organizations_update",
  ],
  privacy: [
    "app_privacy_export",
    "current_user_privacy_export",
    "entity_privacy_delete",
    "entity_privacy_export",
    "organization_privacy_export",
  ],
  temporary_environments: [],
  derived: ["approval_request_reviews_create"],
  "owner-cleanup": [
    "personal_access_tokens_list",
    "personal_access_tokens_revoke",
    "personal_access_tokens_revoke_all",
  ],
  "session-only": [
    "current_user_delete",
    "personal_access_tokens_create",
    "personal_access_tokens_rotate",
    "personal_access_tokens_update",
  ],
};

const sample = {
  operationId: "things_get",
  owner: "control-plane-api",
  method: "GET",
  path: "/things",
  summary: "Read a thing.",
  response: z.object({ ok: z.boolean() }),
  auth: "control-plane-token",
  permission: "read",
  rateLimit: "none",
  idempotency: "none",
  errors: [],
  effects: readOnlyClosed,
} as const satisfies DefineApiRouteInput;

function malformed(overrides: Record<string, unknown>): ApiRouteContract {
  return { ...defineApiRoute(sample), ...overrides } as ApiRouteContract;
}

describe("route permissions", () => {
  it("matches the complete audited permission map for all 111 control-plane routes", () => {
    const expected = Object.fromEntries(
      Object.entries(expectedOperations).flatMap(([permission, operations]) =>
        operations.map((operation) => [operation, permission]),
      ),
    );
    const routes = routeRegistry.filter((route) => route.auth === "control-plane-token");
    expect(routes).toHaveLength(112);
    expect(Object.keys(expected)).toHaveLength(112);
    expect(
      Object.fromEntries(routes.map((route) => [route.operationId, route.permission])),
    ).toEqual(expected);
  });

  it("never assigns control-plane permissions to another auth kind", () => {
    for (const route of routeRegistry) {
      if (route.auth !== "control-plane-token") expect(route).not.toHaveProperty("permission");
    }
  });

  it("assigns read only to nonmutating operations", () => {
    for (const route of routeRegistry) {
      if (route.auth === "control-plane-token" && route.permission === "read") {
        expect(route.effects.mutates, route.operationId).toBe(false);
      }
    }
  });

  it("requires read for nonmutating operations except special rules", () => {
    const reads = routeRegistry.filter((route) => !route.effects.mutates);
    for (const route of reads) {
      if (
        route.auth === "control-plane-token" &&
        !["owner-cleanup", "session-only", "derived"].includes(route.permission)
      ) {
        expect(route.permission, route.operationId).toBe("read");
      }
    }
  });

  it("never assigns write to a destructive irreversible operation", () => {
    const destructive = routeRegistry.filter(
      (route) => route.effects.destructive && route.effects.reversibility === "irreversible",
    );
    for (const route of destructive) expect(route.permission, route.operationId).not.toBe("write");
  });

  it("uses audited effects for POST reads and the provisioning GET", () => {
    for (const id of ["experiment_plan", "flags_test_eval", "experiment_results_post"]) {
      expect(getRoute(id)?.permission).toBe("read");
    }
    expect(getRoute("client_key_get")?.permission).toBe("write");
  });

  it("fails typecheck if a control-plane route omits permission", () => {
    const { permission: _permission, ...missing } = sample;
    // @ts-expect-error Control-plane routes must declare permission.
    const _input: DefineApiRouteInput = missing;
    // @ts-expect-error The authoring helper must enforce the same requirement.
    defineApiRoute(missing);
    const { permission: _contractPermission, ...missingContract } = defineRoute({
      ...defineApiRoute(sample),
      auth: "control-plane-token",
      permission: "read",
    });
    // @ts-expect-error Runtime contracts must also carry their permission.
    const _contract: RouteContract = { ...missingContract, auth: "control-plane-token" };
    expect(missing).not.toHaveProperty("permission");
  });

  it("fails typecheck if another auth kind declares permission", () => {
    const forbidden = { ...sample, auth: "api-key" } as const;
    // @ts-expect-error A data-plane credential cannot declare a PAT permission.
    const _input: DefineApiRouteInput = forbidden;
    // @ts-expect-error The authoring helper must reject that combination.
    defineApiRoute(forbidden);
    const runtimeContract = { ...defineApiRoute(sample), auth: "api-key" } as const;
    // @ts-expect-error Runtime contracts must also reject the combination.
    const _contract: RouteContract = runtimeContract;
    expect(forbidden.permission).toBe("read");
  });

  it.each([undefined, "unknown"])(
    "rejects missing or invalid permission %s at runtime",
    (permission) => {
      expect(() => assertRegistry([malformed({ permission })])).toThrow(
        /missing or invalid permission/,
      );
    },
  );

  it("rejects a permission on any other auth kind at runtime", () => {
    expect(() => assertRegistry([malformed({ auth: "api-key" })])).toThrow(
      /must not declare permission/,
    );
  });

  it("rejects a read permission on a mutating operation", () => {
    expect(() => assertRegistry([malformed({ effects: updateClosed })])).toThrow(
      /mutating route .* cannot require read/,
    );
  });

  it("rejects write permission for destructive irreversible effects", () => {
    expect(() =>
      assertRegistry([malformed({ effects: deleteClosed, permission: "write" })]),
    ).toThrow(/destructive irreversible route .* cannot require write/);
  });
});
