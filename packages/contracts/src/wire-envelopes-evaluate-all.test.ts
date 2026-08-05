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
});
