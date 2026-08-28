import { describe, expect, it } from "vitest";
import { PublishEventDefinitionVersionRequestSchema } from "./event-definition-write";

function publishBody(jsonSchema: Record<string, unknown>) {
  return {
    entityType: "user",
    fields: [{ name: "payload", type: "json" as const, required: false, jsonSchema }],
    dimensions: [],
  };
}

function nestProperties(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let jsonSchema = leaf;
  for (let i = 0; i < depth; i += 1) {
    jsonSchema = { type: "null", properties: { child: jsonSchema } };
  }
  return jsonSchema;
}

describe("Event Definition write structure bounds", () => {
  it("rejects a type:null + properties chain at depth 2000 without throwing", () => {
    const body = publishBody(nestProperties(2000, { type: "null" }));
    expect(() => PublishEventDefinitionVersionRequestSchema.safeParse(body)).not.toThrow();
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("rejects an invalid discriminator + properties chain at depth 2000 without throwing", () => {
    const body = publishBody(nestProperties(2000, { type: "nope" }));
    expect(() => PublishEventDefinitionVersionRequestSchema.safeParse(body)).not.toThrow();
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });
});
