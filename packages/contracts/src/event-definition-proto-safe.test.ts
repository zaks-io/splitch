import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";
import { ClosedJsonSchemaSchema } from "./event-definition";
import {
  PublishEventDefinitionVersionRequestSchema,
  WriteClosedJsonSchemaSchema,
} from "./event-definition-write";
import { OWN_PROTO_KEY } from "./proto-safe-record";

const PROTOTYPE_NAMES = ["constructor", "toString", OWN_PROTO_KEY] as const;

function ownRecord(key: string, value: unknown): Record<string, unknown> {
  return JSON.parse(`{${JSON.stringify(key)}:${JSON.stringify(value)}}`) as Record<string, unknown>;
}

function closedObject(properties: Record<string, unknown>, required?: string[]) {
  return {
    type: "object" as const,
    properties,
    ...(required === undefined ? {} : { required }),
    additionalProperties: false as const,
  };
}

function issueTree(error: ZodError): string {
  return JSON.stringify(error.issues);
}

describe("Closed JSON own-property required declarations", () => {
  it.each(
    PROTOTYPE_NAMES,
  )("rejects required %s unless properties has an own matching schema", (name) => {
    const parsed = ClosedJsonSchemaSchema.safeParse(closedObject({}, [name]));
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(
      parsed.error.issues.some(
        (issue) => issue.message === `required property "${name}" is not declared`,
      ),
    ).toBe(true);
  });

  it.each([
    "constructor",
    "toString",
  ] as const)("accepts required %s when properties has an own matching schema", (name) => {
    const parsed = ClosedJsonSchemaSchema.parse(
      closedObject(ownRecord(name, { type: "boolean" }), [name]),
    );
    expect(parsed).toEqual({
      type: "object",
      properties: { [name]: { type: "boolean" } },
      required: [name],
      additionalProperties: false,
    });
  });

  it("refuses an own __proto__ properties key instead of treating it as declared", () => {
    const parsed = ClosedJsonSchemaSchema.safeParse(
      closedObject(ownRecord(OWN_PROTO_KEY, { type: "boolean" })),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(issueTree(parsed.error)).toContain("must not contain a");
    expect(issueTree(parsed.error)).toContain(OWN_PROTO_KEY);
  });

  it.each(
    PROTOTYPE_NAMES,
  )("rejects nested required %s unless the nested properties has an own matching schema", (name) => {
    const parsed = ClosedJsonSchemaSchema.safeParse(
      closedObject({ profile: closedObject({}, [name]) }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(
      parsed.error.issues.some(
        (issue) => issue.message === `required property "${name}" is not declared`,
      ),
    ).toBe(true);
  });

  it("write schema refuses an own __proto__ properties key", () => {
    const parsed = WriteClosedJsonSchemaSchema.safeParse(
      closedObject(ownRecord(OWN_PROTO_KEY, { type: "boolean" })),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(issueTree(parsed.error)).toContain("must not contain a");
    expect(issueTree(parsed.error)).toContain(OWN_PROTO_KEY);
  });

  it("publish request rejects an inherited required constructor on jsonSchema.properties", () => {
    const parsed = PublishEventDefinitionVersionRequestSchema.safeParse({
      entityType: "user",
      fields: [
        {
          name: "profile",
          type: "json",
          required: true,
          jsonSchema: closedObject({}, ["constructor"]),
        },
      ],
      dimensions: [],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected refusal");
    expect(
      parsed.error.issues.some(
        (issue) => issue.message === 'required property "constructor" is not declared',
      ),
    ).toBe(true);
  });
});
