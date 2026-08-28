import { describe, expect, it } from "vitest";
import { CreateSegmentRequestSchema, PatchSegmentRequestSchema } from "./routes/route-shapes";

describe("Segment mutation routes", () => {
  it("rejects empty Conditions on create and patch", () => {
    expect(
      CreateSegmentRequestSchema.safeParse({ name: "Placeholder", conditions: [] }).success,
    ).toBe(false);
    expect(PatchSegmentRequestSchema.safeParse({ conditions: [] }).success).toBe(false);
  });

  it("rejects an unknown create field instead of stripping it", () => {
    const result = CreateSegmentRequestSchema.safeParse({
      name: "Placeholder",
      conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
      extra: true,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["extra"],
    });
  });
});
