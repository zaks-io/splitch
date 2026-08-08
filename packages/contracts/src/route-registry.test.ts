import { describe, expect, it } from "vitest";
import { errorCodes } from "./errors";
import { honoPathToOpenApiPath } from "./openapi-route";
import {
  authKinds,
  httpMethods,
  idempotencyModes,
  publicSurfaceFor,
  publicSurfaces,
  rateLimitClasses,
  routeOwners,
} from "./route-contract";
import {
  getRoute,
  operationIds,
  routeRegistry,
  routesDelegatedBy,
  routesDelegatedTo,
  routesMountedBy,
  routesSurfacedBy,
} from "./route-registry";

/**
 * The registry is cross-cutting: every Worker mounts it, the SDK infers from it,
 * MCP derives tools from it. These assertions are the contract that keeps all
 * three consumers honest. The fail-loud guard cases (dup id, unknown ErrorCode)
 * live in route-registry-guards.test.ts.
 */

// The canonical control-plane + data-plane endpoint set: the MCP tool list
// (docs/spec/contracts/mcp-tool-derivation.md) plus the non-MCP routes
// (openapi discovery + the two data-plane SDK endpoints). Kept explicit so a
// drift in either direction (an invented or omitted endpoint) fails loudly.
const CANONICAL_OPERATION_IDS = [
  // Organizations + members
  "organizations_list",
  "organizations_create",
  "organizations_get",
  "organizations_update",
  "organizations_delete",
  "organization_members_list",
  "organization_members_add",
  "organization_members_update",
  "organization_members_remove",
  // Apps
  "apps_list",
  "apps_create",
  "apps_get",
  "app_attention_rollup_get",
  "apps_update",
  "apps_delete",
  "app_members_list",
  "app_members_add",
  "app_members_update",
  "app_members_remove",
  // Environments
  "environments_list",
  "environments_create",
  "environments_get",
  "environments_update",
  "environments_delete",
  // Approval Requests + Reviews
  "approval_requests_list",
  "approval_requests_get",
  "approval_request_reviews_create",
  // Flags
  "flags_list",
  "flags_create",
  "flags_get",
  "flags_update",
  "flags_delete",
  // Variants
  "flag_variants_create",
  "flag_variants_update",
  "flag_variants_delete",
  // Flag Configuration
  "flag_config_get",
  "flag_config_update",
  "flag_targeting_rules_replace",
  "flags_promote",
  // Segments
  "segments_list",
  "segments_create",
  "segments_get",
  "segments_update",
  "segments_delete",
  // Experiments
  "experiments_list",
  "experiments_create",
  "experiments_get",
  "experiments_update",
  "experiments_start",
  "experiments_delete",
  // Runs
  "runs_list",
  "runs_get",
  "runs_end",
  // Metrics
  "metrics_list",
  "metrics_create",
  "metrics_get",
  "metrics_update",
  "metrics_delete",
  // SDK credentials
  "client_key_get",
  "client_key_update",
  "client_key_rotate",
  "api_keys_list",
  "api_keys_create",
  "api_keys_revoke",
  // Test-eval + analytics + discovery
  "flags_test_eval",
  "experiment_results_get",
  "experiment_results_post",
  "organization_usage_get",
  "openapi_document_get",
  // Privacy
  "current_user_privacy_export",
  "current_user_delete",
  "organization_privacy_export",
  "app_privacy_export",
  "entity_privacy_export",
  "entity_privacy_delete",
  "privacy_requests_get",
  // Data-plane SDK (not MCP tools)
  "sdk_evaluate",
  "sdk_cached_evaluation_telemetry",
  "sdk_peek",
  "sdk_verify",
  "sdk_evaluate_all",
  "sdk_exposures",
] as const;

describe("route registry: canonical coverage", () => {
  it("registers exactly the canonical endpoint set, no more no less", () => {
    expect([...operationIds].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it("registers a non-trivial number of routes (N > 0)", () => {
    expect(routeRegistry.length).toBe(CANONICAL_OPERATION_IDS.length);
    expect(routeRegistry.length).toBeGreaterThan(0);
  });

  it("exposes a single frozen registry structure", () => {
    expect(Object.isFrozen(routeRegistry)).toBe(true);
  });
});

describe("route registry: per-route invariants", () => {
  it("every operationId is unique", () => {
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("every operationId is lower snake_case resource_operation", () => {
    for (const id of operationIds) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("route.id equals operationId (one identity for the registrar + MCP)", () => {
    for (const route of routeRegistry) {
      expect(route.id).toBe(route.operationId);
    }
  });

  it("every errors[] entry is a known ErrorCode", () => {
    const known = new Set<string>(errorCodes);
    for (const route of routeRegistry) {
      for (const code of route.errors) {
        expect(known.has(code)).toBe(true);
      }
    }
  });

  it("routes with guard scopes document the scope failure emitted by the runtime guard", () => {
    for (const route of routeRegistry) {
      if (route.scopes.length > 0) {
        expect(route.errors).toContain("INSUFFICIENT_SCOPES");
      }
    }
  });

  it("every auth/rateLimit/idempotency/method is a valid enum member", () => {
    const auths = new Set<string>(authKinds);
    const rates = new Set<string>(rateLimitClasses);
    const idems = new Set<string>(idempotencyModes);
    const methods = new Set<string>(httpMethods);
    for (const route of routeRegistry) {
      expect(auths.has(route.auth)).toBe(true);
      expect(rates.has(route.rateLimit)).toBe(true);
      expect(idems.has(route.idempotency)).toBe(true);
      expect(methods.has(route.method)).toBe(true);
    }
  });

  it("every route carries a derived @hono/zod-openapi definition with a matching operationId", () => {
    for (const route of routeRegistry) {
      expect(route.openapi.operationId).toBe(route.operationId);
      expect(route.openapi.path).toBe(honoPathToOpenApiPath(route.path));
      expect(route.openapi.method).toBe(route.method.toLowerCase());
    }
  });
});

describe("route registry: lookup", () => {
  it("requires a caller-owned logical identity for billable SDK Evaluation", () => {
    expect(getRoute("sdk_evaluate")?.idempotency).toBe("required");
  });

  it("getRoute finds a registered route by operationId", () => {
    const route = getRoute("flags_create");
    expect(route?.method).toBe("POST");
    expect(route?.path).toBe("/apps/:appId/flags");
  });

  it("getRoute returns undefined for an unknown operationId", () => {
    expect(getRoute("not_a_real_tool")).toBeUndefined();
  });
});

/**
 * Workers resolve their whole mount table at module load, so this lookup runs
 * once per route before the first request. If it threw for the binding-only kind
 * it would not fail that one route -- it would fail Worker init and take down
 * every route on the Worker, for a route nobody addressed publicly.
 */
describe("route registry: public surface is total over AuthKind", () => {
  it.each(authKinds)("resolves %s without throwing", (auth) => {
    expect(() => publicSurfaceFor({ auth })).not.toThrow();
  });

  it("answers null for the binding-only kind and a surface for every other", () => {
    const bindingOnly = authKinds.filter((auth) => publicSurfaceFor({ auth }) === null);
    expect(bindingOnly).toEqual(["internal-worker"]);
  });

  it("agrees from both sides on which routes are delegated", () => {
    // What a surface forwards and what an owner accepts over the binding are one
    // set. A route with no public surface is in neither: nobody forwards it, so
    // nothing may sit in an owner's inbound allowlist claiming otherwise.
    const forwarded = publicSurfaces.flatMap((surface) => [...routesDelegatedBy(surface)]);
    const accepted = routeOwners.flatMap((owner) => [...routesDelegatedTo(owner)]);
    expect(ids(accepted)).toEqual(ids(forwarded));
  });

  it("splits every Worker's mount table into its public door and its binding door", () => {
    // The two doors are what each entrypoint actually mounts, so they must add up
    // to the whole Worker and never overlap. An overlap is the bug directly: the
    // same operation answered on a public hostname AND over the binding is the
    // second address ADR-0046 exists to prevent.
    //
    // The identity holds only while every route HAS a public surface. A
    // binding-only (`internal-worker`) route would reach `routesMountedBy` through
    // ownership while belonging to neither door, so it would be mounted by the
    // union and addressed by nothing. Assert that precondition rather than let the
    // loop below pass vacuously: the door model has to grow before such a route is
    // added, and this is what makes that a failing test instead of a mount gap.
    expect(ids(routeRegistry.filter((route) => publicSurfaceFor(route) === null))).toEqual([]);

    for (const worker of routeOwners) {
      const surfaced = ids(routesSurfacedBy(worker));
      const delegated = ids(routesDelegatedTo(worker));
      expect(surfaced.filter((id) => delegated.includes(id))).toEqual([]);
      expect([...surfaced, ...delegated].sort()).toEqual(ids(routesMountedBy(worker)));
    }
  });
});

function ids(routes: readonly { operationId: string }[]): string[] {
  return routes.map((route) => route.operationId).sort();
}
