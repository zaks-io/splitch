import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { unwrapField, unwrapToObject, zodDefType } from "./request-body-help-unwrap";
import { routeRegistry } from "./route-registry";

/**
 * A field readable at the top level of `*_get` must not be writable only nested
 * on `*_update` (or vice versa). Derived from the registry — no hand list.
 */

const WRITE_ONLY_KEYS = new Set(["idempotency_key", "review"]);

function objectShape(schema: z.ZodTypeAny | undefined): Record<string, z.ZodTypeAny> | undefined {
  const obj = schema ? unwrapToObject(schema) : undefined;
  return obj?.shape as Record<string, z.ZodTypeAny> | undefined;
}

function requestBodySchema(route: (typeof routeRegistry)[number]): z.ZodTypeAny | undefined {
  const input = unwrapToObject(route.input);
  const body = input?.shape.body;
  return body as z.ZodTypeAny | undefined;
}

function mergePaths(into: Map<string, string[]>, from: Map<string, string[]>): void {
  for (const [key, paths] of from) {
    into.set(key, [...(into.get(key) ?? []), ...paths]);
  }
}

function fieldPaths(schema: z.ZodTypeAny | undefined, prefix = ""): Map<string, string[]> {
  const shape = objectShape(schema);
  const out = new Map<string, string[]>();
  if (!shape) return out;
  for (const [key, field] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.set(key, [...(out.get(key) ?? []), path]);
    const inner = unwrapField(field).inner;
    if (zodDefType(inner) === "object") mergePaths(out, fieldPaths(inner, path));
  }
  return out;
}

function hasTopLevel(paths: string[] | undefined, key: string): boolean {
  return paths?.includes(key) === true;
}

describe("get/update shared-field placement", () => {
  const pairs = routeRegistry
    .filter((route) => route.operationId.endsWith("_get"))
    .map((getRoute) => {
      const updateId = `${getRoute.operationId.slice(0, -"_get".length)}_update`;
      const updateRoute = routeRegistry.find((route) => route.operationId === updateId);
      return updateRoute ? { getRoute, updateRoute } : null;
    })
    .filter(
      (
        pair,
      ): pair is {
        getRoute: (typeof routeRegistry)[number];
        updateRoute: (typeof routeRegistry)[number];
      } => pair !== null,
    );

  it("pairs every *_get that has a matching *_update", () => {
    expect(pairs.map((pair) => pair.getRoute.operationId).sort()).toEqual([
      "apps_get",
      "client_key_get",
      "environments_get",
      "event_definitions_get",
      "experiments_get",
      "flag_config_get",
      "flags_get",
      "metrics_get",
      "organizations_get",
      "segments_get",
    ]);
  });

  it("a top-level readable field is not writable only nested, and vice versa", () => {
    for (const { getRoute, updateRoute } of pairs) {
      const getPaths = fieldPaths(getRoute.output);
      const writePaths = fieldPaths(requestBodySchema(updateRoute));
      const shared = [...getPaths.keys()].filter(
        (key) => writePaths.has(key) && !WRITE_ONLY_KEYS.has(key),
      );
      for (const key of shared) {
        const readableTop = hasTopLevel(getPaths.get(key), key);
        const writableTop = hasTopLevel(writePaths.get(key), key);
        expect(
          {
            operation: `${getRoute.operationId}/${updateRoute.operationId}`,
            key,
            readableTop,
            writableTop,
          },
          `${getRoute.operationId}/${updateRoute.operationId} field "${key}" must live at the same level on get and update`,
        ).toEqual({
          operation: `${getRoute.operationId}/${updateRoute.operationId}`,
          key,
          readableTop,
          writableTop,
        });
      }
    }
  });
});
