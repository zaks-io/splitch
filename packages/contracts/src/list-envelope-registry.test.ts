import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { unwrapField, unwrapToObject, zodDefType, zodOptions } from "./request-body-help-unwrap";
import { routeRegistry } from "./route-registry";
import { listResponse } from "./wire-envelopes-core";

const LIST_ENVELOPE_KEYS = ["cursor", "items", "readLimit", "readTruncated"] as const;

function objectShape(schema: unknown): Record<string, unknown> {
  return unwrapToObject(schema as z.ZodTypeAny)?.shape ?? {};
}

function objectShapes(schema: z.ZodTypeAny): Record<string, unknown>[] {
  if (zodDefType(schema) === "union") return zodOptions(schema).flatMap(objectShapes);
  const shape = objectShape(schema);
  return Object.keys(shape).length === 0 ? [] : [shape];
}

describe("list envelope: every *_list route uses listResponse", () => {
  const listRoutes = routeRegistry.filter((route) => route.operationId.endsWith("_list"));

  it("finds the registered list operations", () => {
    expect(listRoutes.map((route) => route.operationId).sort()).toEqual([
      "api_keys_list",
      "app_members_list",
      "approval_requests_list",
      "apps_list",
      "cloudflare_installations_list",
      "convex_installations_list",
      "environments_list",
      "event_definition_versions_list",
      "event_definitions_list",
      "experiments_list",
      "flags_list",
      "metrics_list",
      "organization_members_list",
      "organizations_list",
      "runs_list",
      "segments_list",
      "sentry_installations_list",
    ]);
  });

  it("every list response is produced by listResponse and carries exactly the shared keys", () => {
    for (const route of listRoutes) {
      const shapes = objectShapes(route.output);
      expect(shapes.length, route.operationId).toBeGreaterThan(0);
      for (const shape of shapes) {
        const keys = Object.keys(shape).sort();
        expect(keys, route.operationId).toEqual([...LIST_ENVELOPE_KEYS]);
        expect(shape).not.toHaveProperty("total");
        expect(shape).not.toHaveProperty("limit");
        expect(shape).not.toHaveProperty("installations");
        expect(zodDefType(shape.items as z.ZodTypeAny), route.operationId).toBe("array");

        const item = unwrapField(shape.items as z.ZodTypeAny).inner;
        const rebuilt = listResponse(item as z.ZodTypeAny);
        expect(Object.keys(objectShape(rebuilt)).sort(), route.operationId).toEqual([
          ...LIST_ENVELOPE_KEYS,
        ]);
      }
    }
  });
});
