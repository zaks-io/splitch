import { describe, expect, it } from "vitest";
import {
  FlagGetQuerySchema,
  FlagListQuerySchema,
  PrincipalFlagListQuerySchema,
} from "./routes/route-shapes";

describe("Flag list route", () => {
  it("accepts an omitted or non-empty Environment ID", () => {
    expect(FlagListQuerySchema.safeParse({}).success).toBe(true);
    expect(FlagListQuerySchema.safeParse({ environmentId: "env_prod" }).success).toBe(true);
  });

  it("reuses hydrated query semantics without accepting an App or legacy Environment summary", () => {
    expect(PrincipalFlagListQuerySchema.safeParse({}).success).toBe(true);
    expect(
      PrincipalFlagListQuerySchema.safeParse({ include: "config", envs: "env_dev,env_prod" })
        .success,
    ).toBe(true);
    expect(PrincipalFlagListQuerySchema.safeParse({ envs: "env_prod" }).success).toBe(false);
    expect(PrincipalFlagListQuerySchema.safeParse({ environmentId: "env_prod" }).success).toBe(
      false,
    );
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

  // `include` is the whole fail-loud contract for hydration: an unrecognized
  // value must be refused, not read as "no hydration requested". A caller who
  // typos it should get a 400, never a silently unhydrated body they then join
  // by hand -- which is the exact failure mode this endpoint exists to remove.
  it("refuses an include value it does not recognize", () => {
    for (const include of ["configs", "CONFIG", "", "config,variants", "true"]) {
      expect(FlagListQuerySchema.safeParse({ include }).success).toBe(false);
      expect(FlagGetQuerySchema.safeParse({ include }).success).toBe(false);
    }
  });
});
