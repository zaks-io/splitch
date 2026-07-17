import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi-document";
import { operationIds, routeRegistry } from "./route-registry";

/**
 * The OpenAPI document is emitted on demand from the registry and proven HERE —
 * never committed to disk. These assertions are the contract that the emitted
 * doc is valid OpenAPI 3.1 and covers EVERY registered route (path + operationId),
 * so a new route automatically appears in discovery with no second authoring step.
 */

const doc = buildOpenApiDocument();

/** Collect every (operationId, path, method) the emitted document advertises. */
function documentOperations(): { operationId: string; path: string; method: string }[] {
  const ops: { operationId: string; path: string; method: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
      const operation = op as { operationId?: string };
      if (operation?.operationId) {
        ops.push({ operationId: operation.operationId, path, method });
      }
    }
  }
  return ops;
}

describe("openapi document: validity", () => {
  it("declares OpenAPI 3.1 with required info", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
  });

  it("has a non-empty paths object", () => {
    expect(doc.paths).toBeDefined();
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  it("threads a custom title/version through", () => {
    const custom = buildOpenApiDocument({ title: "custom-title", version: "9.9.9" });
    expect(custom.info.title).toBe("custom-title");
    expect(custom.info.version).toBe("9.9.9");
  });
});

describe("openapi document: full route coverage", () => {
  it("emits the Organization usage endpoint from its route contract", () => {
    const operation = documentOperations().find(
      (entry) => entry.operationId === "organization_usage_get",
    );

    expect(operation).toEqual({
      operationId: "organization_usage_get",
      path: "/orgs/{orgId}/usage",
      method: "get",
    });
  });

  it("emits one operationId per registered route, no more no less", () => {
    const emittedIds = documentOperations()
      .map((op) => op.operationId)
      .sort();
    expect(emittedIds).toEqual([...operationIds].sort());
  });

  it("emits a path + matching method for EVERY registered route", () => {
    const emitted = new Set(
      documentOperations().map((op) => `${op.method.toUpperCase()} ${op.path}`),
    );
    for (const route of routeRegistry) {
      // OpenAPI paths use {param}; our routes use :param — compare on operationId
      // presence plus method via the per-route openapi config the doc was built from.
      const expectedMethod = route.method.toUpperCase();
      const openapiPath = route.openapi.path;
      expect(emitted.has(`${expectedMethod} ${openapiPath}`)).toBe(true);
    }
  });

  it("covers a non-trivial number of routes (N > 0)", () => {
    expect(routeRegistry.length).toBeGreaterThan(0);
    expect(documentOperations().length).toBe(routeRegistry.length);
  });

  it("attaches a request body or a 200 response schema to each operation", () => {
    for (const [, item] of Object.entries(doc.paths ?? {})) {
      for (const [, op] of Object.entries(item as Record<string, unknown>)) {
        const operation = op as { responses?: Record<string, unknown> };
        expect(operation.responses?.["200"]).toBeDefined();
      }
    }
  });
});
