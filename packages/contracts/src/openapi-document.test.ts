import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { EvaluateAllEntrySchema } from "./leaves/evaluate-all-wire";
import { buildOpenApiDocument } from "./openapi-document";
import { renderOpenApiSchema } from "./openapi-proto-safe-record";
import { publicSurfaceFor } from "./route-contract";
import { routeRegistry } from "./route-registry";

/**
 * The OpenAPI document is emitted on demand from the registry and proven HERE —
 * never committed to disk. These assertions are the contract that the emitted
 * doc is valid OpenAPI 3.1 and covers every publicly surfaced registered route
 * (path + operationId), so a new public route automatically appears in discovery
 * with no second authoring step while binding-only contracts stay private.
 */

const doc = buildOpenApiDocument();
const publicRoutes = routeRegistry.filter((route) => publicSurfaceFor(route) !== null);

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

function evaluateAllResponseSchema(): Record<string, unknown> {
  const operation = doc.paths?.["/api/sdk/evaluate-all"]?.post as {
    responses?: {
      "200"?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
    };
  };
  const schema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  if (schema === undefined) {
    throw new Error("evaluate-all 200 response schema missing from OpenAPI document");
  }
  return schema;
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

describe("openapi document: evaluate-all evaluations shape", () => {
  it("keeps the real evaluations additionalProperties shape (not blank {})", () => {
    const responseSchema = evaluateAllResponseSchema();
    const evaluations = (responseSchema.properties as Record<string, unknown> | undefined)
      ?.evaluations as Record<string, unknown> | undefined;

    const expected = renderOpenApiSchema(
      z.object({
        evaluations: z.record(z.string(), EvaluateAllEntrySchema),
      }),
    ) as {
      properties?: { evaluations?: Record<string, unknown> };
    };

    expect(evaluations).toEqual(expected.properties?.evaluations);
    expect(evaluations).toMatchObject({
      type: "object",
      additionalProperties: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          reason: expect.objectContaining({ enum: expect.any(Array) }),
          exposureIdentity: expect.anything(),
          exposureTicket: expect.anything(),
        }),
      }),
    });
  });
});

describe("openapi document: full route coverage", () => {
  it("derives required Idempotency-Key headers into OpenAPI", () => {
    const operation = doc.paths?.["/api/sdk/evaluate"]?.post as {
      parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
    };
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "Idempotency-Key",
        required: true,
      }),
    );
  });

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

  it("addresses Environment Exposure status only at the Control Plane surface", () => {
    const operation = documentOperations().find(
      (entry) => entry.operationId === "environment_exposure_status_get",
    );

    expect(operation).toEqual({
      operationId: "environment_exposure_status_get",
      path: "/apps/{appId}/envs/{environmentId}/exposure-status",
      method: "get",
    });
  });

  it("does not publish binding-only internal cleanup routes", () => {
    const operations = documentOperations();

    expect({
      internalPaths: Object.keys(doc.paths ?? {}).filter((path) => path.startsWith("/internal/")),
      cleanupOperations: operations.filter(
        ({ operationId }) =>
          operationId === "environment_exposure_status_delete" ||
          operationId === "holdover_write_outbox_delete" ||
          operationId === "entity_assignment_privacy_export" ||
          operationId === "entity_assignment_privacy_delete",
      ),
    }).toEqual({ internalPaths: [], cleanupOperations: [] });
  });

  it("emits only the error codes declared by each route", () => {
    const operation = doc.paths?.["/apps/{appId}/attention-rollup"]?.get as {
      responses?: Record<string, unknown>;
    };
    const conflictResponse = JSON.stringify(operation.responses?.["409"]);

    expect(conflictResponse).toContain("ATTENTION_FANOUT_LIMIT_EXCEEDED");
    expect(conflictResponse).toContain("message");
    expect(conflictResponse).toContain("details");
    expect(conflictResponse).not.toContain("RUN_FROZEN");
  });

  it("emits one operationId per publicly surfaced route, no more no less", () => {
    const emittedIds = documentOperations()
      .map((op) => op.operationId)
      .sort();
    expect(emittedIds).toEqual(publicRoutes.map((route) => route.operationId).sort());
  });

  it("emits a path + matching method for every publicly surfaced route", () => {
    const emitted = new Set(
      documentOperations().map((op) => `${op.method.toUpperCase()} ${op.path}`),
    );
    for (const route of publicRoutes) {
      // OpenAPI paths use {param}; our routes use :param — compare on operationId
      // presence plus method via the per-route openapi config the doc was built from.
      const expectedMethod = route.method.toUpperCase();
      const openapiPath = route.openapi.path;
      expect(emitted.has(`${expectedMethod} ${openapiPath}`)).toBe(true);
    }
  });

  it("covers a non-trivial number of routes (N > 0)", () => {
    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(documentOperations().length).toBe(publicRoutes.length);
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
