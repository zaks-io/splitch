import { describe, expect, it } from "vitest";
import {
  ResolutionDetailsSchema,
  ResolutionReasonSchema,
  resolutionReasons,
} from "./leaf-schemas-runtime";

describe("ResolutionReasonSchema", () => {
  it("accepts every declared reason", () => {
    for (const r of resolutionReasons) {
      expect(ResolutionReasonSchema.safeParse(r).success).toBe(true);
    }
  });

  it("rejects an unknown reason", () => {
    expect(ResolutionReasonSchema.safeParse("FALLTHROUGH").success).toBe(false);
  });
});

describe("ResolutionDetailsSchema", () => {
  it("parses a non-error SPLIT result with a variant name", () => {
    const d = ResolutionDetailsSchema.parse({
      value: "on",
      variantName: "treatment",
      reason: "SPLIT",
    });
    expect(d.reason).toBe("SPLIT");
    expect(d.variantName).toBe("treatment");
  });

  it("parses an API-key TARGETING_MATCH result with ruleId", () => {
    const d = ResolutionDetailsSchema.parse({
      value: "on",
      variantName: "treatment",
      reason: "TARGETING_MATCH",
      ruleId: "rule-enterprise",
    });
    expect(d.reason).toBe("TARGETING_MATCH");
    expect(d.ruleId).toBe("rule-enterprise");
  });

  it("parses a JsonObject value", () => {
    const d = ResolutionDetailsSchema.parse({
      value: { color: "blue", count: 3 },
      variantName: "treatment",
      reason: "CACHED",
    });
    expect(d.value).toEqual({ color: "blue", count: 3 });
  });

  it("accepts a null variantName (no variant resolved)", () => {
    const d = ResolutionDetailsSchema.parse({
      value: false,
      variantName: null,
      reason: "DISABLED",
    });
    expect(d.variantName).toBeNull();
  });

  it("requires errorCode when reason is ERROR (ADR-0036 fail-loud)", () => {
    const d = ResolutionDetailsSchema.parse({
      value: false,
      variantName: null,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: "no such flag",
    });
    expect(d.errorCode).toBe("FLAG_NOT_FOUND");
  });

  it("rejects an ERROR result missing errorCode (no silent default)", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: false,
        variantName: null,
        reason: "ERROR",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown errorCode value", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: false,
        variantName: null,
        reason: "ERROR",
        errorCode: "NOT_A_REAL_CODE",
      }).success,
    ).toBe(false);
  });

  it("rejects errorCode present on a non-ERROR reason", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: "on",
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: "FLAG_NOT_FOUND",
      }).success,
    ).toBe(false);
  });

  it("rejects errorMessage present on a non-ERROR reason", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: "on",
        variantName: "treatment",
        reason: "DEFAULT",
        errorMessage: "stray message",
      }).success,
    ).toBe(false);
  });

  it("requires ruleId on TARGETING_MATCH", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: "on",
        variantName: "treatment",
        reason: "TARGETING_MATCH",
      }).success,
    ).toBe(false);
  });

  it("rejects ruleId on non-TARGETING_MATCH reasons", () => {
    expect(
      ResolutionDetailsSchema.safeParse({
        value: "on",
        variantName: "treatment",
        reason: "SPLIT",
        ruleId: "rule-enterprise",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing reason", () => {
    expect(
      ResolutionDetailsSchema.safeParse({ value: "on", variantName: "treatment" }).success,
    ).toBe(false);
  });
});
