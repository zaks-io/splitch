import { routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";

// Select route domains from the registry, so another mutation in a covered
// group cannot silently bypass the declared audit contract.
function coveredMutation(route: (typeof routeRegistry)[number]): boolean {
  if (route.method === "GET") return false;
  return (
    (/\/(?:api-keys|client-key|members)(?:\/|$)/u.test(route.path) &&
      route.path.startsWith("/apps/")) ||
    /\/(?:promote|start|end|conclusions|promotion-requests|reviews)$/u.test(route.path)
  );
}

describe("App audit producer registry coverage", () => {
  it("declares an App audit action for every covered mutation route", () => {
    const routes = routeRegistry.filter(coveredMutation);
    expect(routes.length).toBeGreaterThanOrEqual(13);
    for (const route of routes) {
      expect(route.audit, `${route.operationId} must declare its App audit action`).toBe("app");
    }
  });

  it("preserves once-only credential mint and rotation retry semantics", () => {
    for (const operation of ["api_keys_create", "client_key_rotate"]) {
      const route = routeRegistry.find((entry) => entry.operationId === operation);
      expect(route).toMatchObject({ audit: "app", idempotency: "none" });
    }
  });
});
