import { describe, expect, it } from "vitest";
import { FlagListQuerySchema } from "./routes/route-shapes";

describe("Flag list route", () => {
  it("accepts an omitted or non-empty Environment ID", () => {
    expect(FlagListQuerySchema.safeParse({}).success).toBe(true);
    expect(FlagListQuerySchema.safeParse({ environmentId: "env_prod" }).success).toBe(true);
  });

  it("rejects an empty Environment ID", () => {
    expect(FlagListQuerySchema.safeParse({ environmentId: "" }).success).toBe(false);
  });
});
