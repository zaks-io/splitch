import { describe, expect, it } from "vitest";
import { EventDefinitionVersionSchema } from "./event-definition";
import { PublishEventDefinitionVersionRequestSchema } from "./event-definition-write";
import { PERSISTED_ARRAY_MAX_ITEMS, PERSISTED_JSON_MAX_DEPTH } from "./persisted-field-limits";

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
