import { describe, expect, it } from "vitest";
import {
  EventDefinitionVersionSchema,
  PublishEventDefinitionVersionRequestSchema,
} from "./event-definition";

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
});
