import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QueryBooleanSchema, ResourceDeleteModeQuerySchema } from "./resource-delete-tree";

describe("ResourceDeleteModeQuerySchema (SPL-326)", () => {
  it("coerces query-string booleans and accepts MCP real booleans", () => {
    expect(QueryBooleanSchema.parse(true)).toBe(true);
    expect(QueryBooleanSchema.parse(false)).toBe(false);
    expect(QueryBooleanSchema.parse("true")).toBe(true);
    expect(QueryBooleanSchema.parse("false")).toBe(false);
    expect(QueryBooleanSchema.safeParse("1").success).toBe(false);
    expect(QueryBooleanSchema.safeParse("").success).toBe(false);
  });

  it("rejects dryRun and force together", () => {
    expect(ResourceDeleteModeQuerySchema.safeParse({ dryRun: true, force: true }).success).toBe(
      false,
    );
    expect(ResourceDeleteModeQuerySchema.safeParse({ dryRun: "true", force: "true" }).success).toBe(
      false,
    );
  });

  it("is JSON-Schema representable for MCP tool derivation", () => {
    const schema = z.toJSONSchema(ResourceDeleteModeQuerySchema) as {
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.properties?.dryRun?.type).toBe("boolean");
    expect(schema.properties?.force?.type).toBe("boolean");
  });
});
