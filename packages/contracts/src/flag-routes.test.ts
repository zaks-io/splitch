import { describe, expect, it } from "vitest";
import { FlagGetQuerySchema, FlagListQuerySchema } from "./routes/route-shapes";

describe("Flag list route", () => {
  it("accepts an omitted or non-empty Environment ID", () => {
    expect(FlagListQuerySchema.safeParse({}).success).toBe(true);
    expect(FlagListQuerySchema.safeParse({ environmentId: "env_prod" }).success).toBe(true);
  });

  it("rejects an empty Environment ID", () => {
    expect(FlagListQuerySchema.safeParse({ environmentId: "" }).success).toBe(false);
  });

  it("accepts hydrated reads for all Environments or an explicit subset", () => {
    expect(FlagListQuerySchema.safeParse({ include: "config" }).success).toBe(true);
    expect(
      FlagListQuerySchema.safeParse({ include: "config", envs: "env_dev,env_prod" }).success,
    ).toBe(true);
    expect(
      FlagGetQuerySchema.safeParse({ by: "key", include: "config", envs: "env_prod" }).success,
    ).toBe(true);
  });

  it("rejects an Environment subset without hydration", () => {
    expect(FlagListQuerySchema.safeParse({ envs: "env_prod" }).success).toBe(false);
    expect(FlagGetQuerySchema.safeParse({ envs: "env_prod" }).success).toBe(false);
  });

  it("keeps the legacy one-Environment summary distinct from hydration", () => {
    expect(
      FlagListQuerySchema.safeParse({ environmentId: "env_prod", include: "config" }).success,
    ).toBe(false);
  });
});
