import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput } from "./parse-input";

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
});
