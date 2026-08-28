import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { ClosedJsonSchemaSchema, EventDefinitionVersionSchema } from "./event-definition";
import {
  PublishEventDefinitionVersionRequestSchema,
  WriteClosedJsonSchemaSchema,
} from "./event-definition-write";
import { PERSISTED_ARRAY_MAX_ITEMS, PERSISTED_JSON_MAX_DEPTH } from "./persisted-field-limits";
import { incomingJsonBoundIssue } from "./incoming-json-bound";
import { describeRequestBody, requestBodySchemaForOperation } from "./request-body-help";
import { unwrapField, zodDefType, zodElement, zodOptions } from "./request-body-help-unwrap";

describe("Event Definition publication contracts", () => {
  it("allows an anonymous-only Web Event Definition Version", () => {
    const parsed = PublishEventDefinitionVersionRequestSchema.parse({
      entityType: null,
      fields: [],
      dimensions: [],
    });

    expect(parsed.entityType).toBeNull();
  });

  it("rejects a numeric field without an allowlist or finite bounds", () => {
    const parsed = EventDefinitionVersionSchema.safeParse({
      id: "event_definition_version_migrated",
      eventDefinitionId: "event_definition_migrated",
      version: 1,
      schemaHash: "migration:0019",
      entityType: null,
      fields: [
        {
          name: "amount",
          type: "number",
          required: false,
          numberKind: "amount",
        },
      ],
      dimensions: [],
      publishedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    ["an allowlist", { allowedValues: [1, 2] }, []],
    ["a bounded range", { minimum: 0, maximum: 2 }, []],
    ["neither domain", {}, ["number requires either an allowlist or bounded range"]],
    [
      "both domains",
      { allowedValues: [1, 2], minimum: 0, maximum: 2 },
      ["number cannot combine an allowlist and bounded range"],
    ],
  ])("reports the numeric domain for %s", (_case, domain, expectedMessages) => {
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: [
        {
          name: "amount",
          type: "number",
          required: false,
          numberKind: "amount",
          ...domain,
        },
      ],
      dimensions: [],
    });

    expect(parsed.success ? [] : parsed.error.issues.map(({ message }) => message)).toEqual(
      expectedMessages,
    );
  });

  it("still rejects a one-sided numeric range", () => {
    const parsed = EventDefinitionVersionSchema.safeParse({
      id: "event_definition_version_invalid",
      eventDefinitionId: "event_definition",
      version: 1,
      schemaHash: "invalid",
      entityType: "user",
      fields: [
        {
          name: "amount",
          type: "number",
          required: false,
          numberKind: "amount",
          minimum: 0,
        },
      ],
      dimensions: [],
      publishedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("still reads a historically long field name on a stored Version", () => {
    const parsed = EventDefinitionVersionSchema.safeParse({
      id: "event_definition_version_legacy",
      eventDefinitionId: "event_definition_legacy",
      version: 1,
      schemaHash: "legacy",
      entityType: "user",
      fields: [
        {
          name: "n".repeat(400),
          type: "boolean",
          required: false,
        },
      ],
      dimensions: [],
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects more published fields than the named array bound", () => {
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: Array.from({ length: PERSISTED_ARRAY_MAX_ITEMS + 1 }, (_, index) => ({
        name: `field_${index}`,
        type: "boolean",
        required: false,
      })),
      dimensions: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects Closed JSON deeper than the named depth bound", () => {
    let jsonSchema: Record<string, unknown> = { type: "null" };
    for (let depth = 1; depth < PERSISTED_JSON_MAX_DEPTH; depth += 1) {
      jsonSchema = {
        type: "object",
        properties: { child: jsonSchema },
        additionalProperties: false,
      };
    }
    const atBound = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: [{ name: "payload", type: "json", required: false, jsonSchema }],
      dimensions: [],
    });
    expect(atBound.success).toBe(true);

    const overflow = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: [
        {
          name: "payload",
          type: "json",
          required: false,
          jsonSchema: {
            type: "object",
            properties: { child: jsonSchema },
            additionalProperties: false,
          },
        },
      ],
      dimensions: [],
    });
    expect(overflow.success).toBe(false);
    if (overflow.success) return;
    expect(overflow.error.issues[0]?.path[0]).toBe("fields");
  });
});

describe("Event Definition publication pre-refinement depth guard", () => {
  it("rejects a valid Closed JSON document at depth 2000 without throwing", () => {
    let jsonSchema: Record<string, unknown> = { type: "null" };
    for (let depth = 0; depth < 2000; depth += 1) {
      jsonSchema = { type: "array", items: jsonSchema };
    }
    const encoded = JSON.stringify(jsonSchema);
    expect(encoded.length).toBeGreaterThan(50_000);
    expect(encoded.length).toBeLessThan(1_048_576);

    const body = {
      entityType: "user",
      fields: [{ name: "payload", type: "json", required: false, jsonSchema }],
      dimensions: [],
    };
    expect(() => PublishEventDefinitionVersionRequestSchema.safeParse(body)).not.toThrow();
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("stays JSON-Schema-representable for MCP tool derivation", () => {
    expect(() => z.toJSONSchema(PublishEventDefinitionVersionRequestSchema)).not.toThrow();
  });

  it("keeps the derived request schema free of Zod transforms", () => {
    const body = requestBodySchemaForOperation("event_definition_versions_create");
    expect(body).toBe(PublishEventDefinitionVersionRequestSchema);
    expect(() => describeRequestBody(PublishEventDefinitionVersionRequestSchema)).not.toThrow();

    const fieldsSchema = PublishEventDefinitionVersionRequestSchema.shape.fields;
    const fieldUnion = unwrapField(zodElement(fieldsSchema)).inner;
    const jsonField = zodOptions(fieldUnion).find((option) => {
      const inner = unwrapField(option).inner;
      return inner instanceof z.ZodObject && "jsonSchema" in inner.shape;
    });
    expect(jsonField).toBeDefined();
    if (!jsonField) return;
    const jsonSchemaField = (unwrapField(jsonField).inner as z.ZodObject).shape.jsonSchema;
    expect(zodDefType(unwrapField(jsonSchemaField).inner)).toBe("lazy");
    expect(unwrapField(jsonSchemaField).inner).toBe(WriteClosedJsonSchemaSchema);
  });

  it("reports the exact unknown field key instead of the union member", () => {
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: [{ name: "x", type: "boolean", required: false, extra: true }],
      dimensions: [],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["extra"],
      path: ["fields", 0],
    });
  });

  it("rejects a depth-2000 type:null properties chain without throwing", () => {
    const jsonSchema = nestClosedJsonProperties(2000, { type: "null" });
    expect(incomingJsonBoundIssue(jsonSchema)).not.toBeNull();
    const body = publishJsonField(jsonSchema);
    expect(() => PublishEventDefinitionVersionRequestSchema.safeParse(body)).not.toThrow();
    expect(() => ClosedJsonSchemaSchema.safeParse(jsonSchema)).not.toThrow();
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("rejects a depth-2000 invalid-discriminator properties chain without throwing", () => {
    const jsonSchema = nestClosedJsonProperties(2000, { type: "c" });
    expect(incomingJsonBoundIssue(jsonSchema)).not.toBeNull();
    const body = publishJsonField(jsonSchema);
    expect(() => PublishEventDefinitionVersionRequestSchema.safeParse(body)).not.toThrow();
    expect(() => ClosedJsonSchemaSchema.safeParse(jsonSchema)).not.toThrow();
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("reports only extra on a legitimate Closed JSON object", () => {
    const parsed = WriteClosedJsonSchemaSchema.safeParse({
      type: "object",
      properties: { foo: { type: "null" } },
      additionalProperties: false,
      extra: true,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["extra"] }),
    ]);
    expect(JSON.stringify(parsed.error.issues)).not.toContain("properties");
    expect(JSON.stringify(parsed.error.issues)).not.toContain("additionalProperties");
  });

  it("reports the invalid discriminator instead of an unrelated key", () => {
    const parsed = WriteClosedJsonSchemaSchema.safeParse({ type: "c", a: "value" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]).toMatchObject({
      code: "invalid_union",
      path: ["type"],
    });
    expect(JSON.stringify(parsed.error.issues)).not.toContain('"a"');
  });
});

function nestClosedJsonProperties(
  depth: number,
  leaf: Record<string, unknown>,
): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let index = 0; index < depth; index += 1) {
    node = { type: leaf.type, properties: { child: node } };
  }
  return node;
}

function publishJsonField(jsonSchema: Record<string, unknown>) {
  return {
    entityType: "user",
    fields: [{ name: "payload", type: "json", required: false, jsonSchema }],
    dimensions: [],
  };
}
