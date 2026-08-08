import { describe, expect, it } from "vitest";
import { ExposureRedemptionClaimTransportError } from "./exposure-redemption-claim-errors";
import { logExposureRedemptionFault } from "./exposure-redemption-log";

describe("logExposureRedemptionFault causeChain", () => {
  it("records the full cause chain, not only the outer transport constant", () => {
    const errors: Array<{ message: string; detail: unknown }> = [];
    const cause = new ExposureRedemptionClaimTransportError(
      new Error("Network connection lost: durable object 7f3a stub reset"),
    );
    logExposureRedemptionFault(
      { error: (message, detail) => errors.push({ message, detail }) },
      "exposure_redemption_acknowledge_failed",
      {
        requestId: "req_1",
        appId: "app_1",
        environmentId: "env_1",
        exposureId: "550e8400-e29b-41d4-a716-446655440001",
      },
      cause,
    );
    expect(errors).toEqual([
      {
        message: "exposure_redemption_acknowledge_failed",
        detail: {
          requestId: "req_1",
          appId: "app_1",
          environmentId: "env_1",
          exposureId: "550e8400-e29b-41d4-a716-446655440001",
          causeChain: [
            "exposure redemption claim Durable Object transport failed",
            "Network connection lost: durable object 7f3a stub reset",
          ],
        },
      },
    ]);
  });
});
