import { describe, expect, it } from "vitest";
import { DeltaNudgeSchema } from "./delta-nudge.js";

const valid = { type: "config.changed", entity: "flag", id: "flag-1", version: 4 } as const;

describe("DeltaNudgeSchema", () => {
  it("accepts a well-formed config.changed nudge", () => {
    expect(DeltaNudgeSchema.parse(valid)).toEqual(valid);
  });

  it("accepts every documented entity", () => {
    for (const entity of ["flag", "experiment", "run", "segment"] as const) {
      expect(DeltaNudgeSchema.parse({ ...valid, entity }).entity).toBe(entity);
    }
  });

  it("rejects an unknown type discriminator", () => {
    expect(DeltaNudgeSchema.safeParse({ ...valid, type: "stats.changed" }).success).toBe(false);
  });

  it("rejects an unknown entity", () => {
    expect(DeltaNudgeSchema.safeParse({ ...valid, entity: "metric" }).success).toBe(false);
  });

  it("rejects an extra key (.strict)", () => {
    expect(DeltaNudgeSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    expect(DeltaNudgeSchema.safeParse({ ...valid, version: 1.5 }).success).toBe(false);
  });
});
