import {
  PublishEventDefinitionVersionRequestSchema,
  WriteClosedJsonSchemaSchema,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput } from "./parse-input";

const publishInputSchema = z.object({
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: PublishEventDefinitionVersionRequestSchema,
});

const unionFieldSchema = z.object({
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: z.object({
    fields: z.array(
      z.union([
        z
          .object({
            name: z.string(),
            type: z.literal("boolean"),
            required: z.boolean(),
          })
          .strict(),
        z
          .object({
            name: z.string(),
            type: z.literal("json"),
            required: z.boolean(),
          })
          .strict(),
      ]),
    ),
  }),
});

const closedJsonBodySchema = z.object({
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: WriteClosedJsonSchemaSchema,
});

describe("parseInput unknown-key paths", () => {
  it("lifts nested unrecognized_keys out of invalid_union", async () => {
    const parsed = await parseInput(
      unionFieldSchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({
          fields: [{ name: "x", type: "boolean", required: false, extra: true }],
        }),
      }),
      {},
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [{ path: ["body", "fields", "0", "extra"], message: 'Unrecognized key: "extra"' }],
      },
    });
  });

  it("does not promote leftover keys from a type-mismatched union branch", async () => {
    const parsed = await parseInput(
      unionFieldSchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({
          fields: [{ name: "payload", type: "array", required: false, items: { type: "null" } }],
        }),
      }),
      {},
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues.some((issue) => issue.message.includes("items"))).toBe(
      false,
    );
    expect(parsed.error.details.issues).toEqual([
      { path: ["body", "fields", "0"], message: expect.any(String) },
    ]);
  });

  it("reports only extra on a Closed JSON object, not sibling schema keys", async () => {
    const parsed = await parseInput(
      publishInputSchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({
          entityType: "user",
          fields: [
            {
              name: "payload",
              type: "json",
              required: false,
              jsonSchema: {
                type: "object",
                properties: { foo: { type: "string", enum: ["a"] } },
                additionalProperties: false,
                extra: true,
              },
            },
          ],
          dimensions: [],
        }),
      }),
      {},
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues).toEqual([
      {
        path: ["body", "fields", "0", "jsonSchema", "extra"],
        message: 'Unrecognized key: "extra"',
      },
    ]);
  });

  it("lifts only extra from a legitimate Closed JSON object", async () => {
    const parsed = await parseInput(
      closedJsonBodySchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({
          type: "object",
          properties: { foo: { type: "null" } },
          additionalProperties: false,
          extra: true,
        }),
      }),
      {},
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [{ path: ["body", "extra"], message: 'Unrecognized key: "extra"' }],
      },
    });
    expect(JSON.stringify(parsed.error.details)).not.toContain("properties");
    expect(JSON.stringify(parsed.error.details)).not.toContain("additionalProperties");
  });

  it("keeps invalid Closed JSON discriminator issues instead of a leftover key", async () => {
    const parsed = await parseInput(
      publishInputSchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({
          entityType: "user",
          fields: [
            {
              name: "payload",
              type: "json",
              required: false,
              jsonSchema: { type: "c", a: "value" },
            },
          ],
          dimensions: [],
        }),
      }),
      {},
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues.some((issue) => issue.path.join(".") === "body.a")).toBe(
      false,
    );
    expect(parsed.error.details.issues.some((issue) => issue.path.join(".").endsWith(".a"))).toBe(
      false,
    );
    expect(parsed.error.details.issues).toEqual([
      { path: ["body", "fields", "0", "jsonSchema"], message: expect.any(String) },
    ]);
  });

  it("keeps the invalid Closed JSON discriminator instead of an unrelated key", async () => {
    const parsed = await parseInput(
      closedJsonBodySchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify({ type: "c", a: "value" }),
      }),
      {},
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues.some((issue) => issue.path.includes("a"))).toBe(false);
    expect(parsed.error.details.issues).toEqual([
      { path: ["body", "type"], message: expect.stringMatching(/discriminator|Invalid/i) },
    ]);
  });

  it("rejects a depth-2000 type:null properties chain with 400 and never throws", async () => {
    const parsed = await parseInput(
      closedJsonBodySchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify(nestClosedJsonProperties(2000, { type: "null" })),
      }),
      {},
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues[0]?.path[0]).toBe("body");
    expect(parsed.error.details.issues[0]?.message).toMatch(/incoming depth/);
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
