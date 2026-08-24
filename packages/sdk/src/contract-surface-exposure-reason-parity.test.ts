import { describe, expect, it } from "vitest";
import { EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema } from "../../contracts/src/sdk-data-plane-surface";
import { EvaluateAllResponseSchema } from "./generated/contract-surface.js";

const exposure = {
  exposureIdentity: "identity",
  exposureTicket: "ticket",
} as const;

function expectExposureReasonParity(reason: "DEFAULT" | "DISABLED", ok: boolean) {
  const input = {
    evaluations: {
      "new-checkout": {
        variant: false,
        variantName: reason === "DEFAULT" ? null : "off",
        reason,
        errorCode: null,
        ...exposure,
      },
    },
  };

  const compiledResult = EvaluateAllResponseSchema.safeParse(input);
  const zodResult = ZodEvaluateAllResponseSchema.safeParse(input);
  expect(compiledResult.success).toBe(ok);
  expect(zodResult.success).toBe(ok);
  if (ok && compiledResult.success && zodResult.success) {
    expect(compiledResult.data).toEqual(zodResult.data);
  }
}

describe("Evaluate All Exposure reason contract parity", () => {
  it("accepts Exposure fields for DEFAULT", () => {
    expectExposureReasonParity("DEFAULT", true);
  });

  it("rejects Exposure fields for DISABLED", () => {
    expectExposureReasonParity("DISABLED", false);
  });
});
