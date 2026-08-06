import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption";
import { APP_B, ENV_B, EXPOSURE_ID_A, EXPOSURE_ID_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

describe("MemoryExposureRedemptionClaimStore tenant scoping", () => {
  it("scopes ticket-fingerprint claims by App so identical fingerprints do not collide", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.record({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "shared-fingerprint",
    });

    const otherApp = await claims.lookup({
      appId: APP_B,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "shared-fingerprint",
    });
    expect(otherApp).toEqual({ status: "missing" });
  });

  it("scopes ticket-fingerprint claims by Environment", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.record({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "shared-fingerprint",
    });

    const otherEnv = await claims.lookup({
      appId: APP_ID,
      environmentId: ENV_B,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "shared-fingerprint",
    });
    expect(otherEnv).toEqual({ status: "missing" });
  });
});
