import { describe, expect, it } from "vitest";
import { CreateSegmentRequestSchema, PatchSegmentRequestSchema } from "./routes/route-shapes";

describe("Segment mutation routes", () => {
  it("rejects empty Conditions on create and patch", () => {
    expect(
      CreateSegmentRequestSchema.safeParse({ name: "Placeholder", conditions: [] }).success,
    ).toBe(false);
    expect(PatchSegmentRequestSchema.safeParse({ conditions: [] }).success).toBe(false);
  });
});
