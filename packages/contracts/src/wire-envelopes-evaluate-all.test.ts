import { describe, expect, it } from "vitest";
import {
  EvaluateAllEntrySchema,
  EvaluateAllRequestSchema,
  EvaluateAllResponseSchema,
} from "./wire-envelopes-core";

describe("EvaluateAllRequestSchema", () => {
  it("accepts targetingKey/idType/attributes and rejects flagKey", () => {
    expect(
      EvaluateAllRequestSchema.parse({
        targetingKey: "user-1",
        idType: "user",
        attributes: { plan: "pro" },
      }),
    ).toEqual({
      targetingKey: "user-1",
      idType: "user",
      attributes: { plan: "pro" },
    });
    // flagKey is not part of the bulk request; Zod object strips unknown keys by
    // default, so the important check is that the schema does not require it.
    expect(
      EvaluateAllRequestSchema.safeParse({ targetingKey: "user-1", idType: "user" }).success,
    ).toBe(true);
  });
});

const PROTO_FLAG_ENTRY = {
  variant: false,
  variantName: null,
  reason: "DEFAULT",
  errorCode: null,
  exposureTicket: null,
} as const;

describe("EvaluateAllResponseSchema", () => {
  it("requires present-with-null optional fields and rejects rule metadata", () => {
    const body = EvaluateAllResponseSchema.parse({
      evaluations: {
        checkout: {
          variant: true,
          variantName: "treatment",
          reason: "SPLIT",
          errorCode: null,
          exposureTicket: "ticket.payload",
        },
        banner: {
          variant: null,
          variantName: null,
          reason: "ERROR",
          errorCode: "INTERNAL_SERVER_ERROR",
          exposureTicket: null,
        },
      },
    });
    expect(body.evaluations.checkout?.exposureTicket).toBe("ticket.payload");
    expect(body.evaluations.banner?.errorCode).toBe("INTERNAL_SERVER_ERROR");

    expect(
      EvaluateAllEntrySchema.safeParse({
        variant: true,
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: null,
        exposureTicket: null,
        ruleId: "rule-1",
      }).success,
    ).toBe(false);

    expect(
      EvaluateAllEntrySchema.safeParse({
        variant: true,
        variantName: "treatment",
        reason: "TARGETING_MATCH",
        errorCode: null,
        exposureTicket: null,
      }).success,
    ).toBe(false);

    expect(
      EvaluateAllEntrySchema.safeParse({
        variant: true,
        variantName: "treatment",
        reason: "ERROR",
        errorCode: null,
        exposureTicket: null,
      }).success,
    ).toBe(false);
  });

  it("fails loud on a __proto__ flag key instead of silently dropping it (Worker / zod)", () => {
    // JSON.parse creates __proto__ as an own property; Object.keys sees it.
    // zod 4.4.3's z.record would otherwise skip the key and return success.
    const input = JSON.parse(
      `{"evaluations":{"__proto__":${JSON.stringify(PROTO_FLAG_ENTRY)},"checkout":${JSON.stringify({
        variant: true,
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: null,
        exposureTicket: "ticket.payload",
      })}}}`,
    ) as unknown;

    const parsed = EvaluateAllResponseSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues.some((issue) => issue.path.includes("__proto__"))).toBe(true);
  });

  it("pins the SDK keep path: defineProperty preserves __proto__ as an own flag key", () => {
    // Mirror of the hand-maintained SDK validator (SPL-325): keep the key as an
    // own property on a normal Object.prototype map. Worker zod must fail loud
    // (test above); the SDK must not silently drop. Pin both interpretations here
    // so they cannot drift into the same silent-omit failure mode.
    const input = JSON.parse(
      `{"evaluations":{"__proto__":${JSON.stringify(PROTO_FLAG_ENTRY)}}}`,
    ) as { evaluations: Record<string, unknown> };

    const evaluations: Record<string, unknown> = {};
    for (const [flagKey, entry] of Object.entries(input.evaluations)) {
      Object.defineProperty(evaluations, flagKey, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    expect(Object.getPrototypeOf(evaluations)).toBe(Object.prototype);
    expect(Object.keys(evaluations)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(evaluations, "__proto__")?.value).toEqual(
      PROTO_FLAG_ENTRY,
    );
    expect(EvaluateAllResponseSchema.safeParse({ evaluations }).success).toBe(false);
  });
});
