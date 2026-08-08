import { describe, expect, it } from "vitest";
import { claimFailureCode, ExposureRedemptionClaimFault } from "./exposure-redemption-claim-fault";

describe("claimFailureCode", () => {
  it("maps transport faults to SERVICE_UNAVAILABLE", () => {
    expect(
      claimFailureCode(new ExposureRedemptionClaimFault("transport failed", { kind: "transport" })),
    ).toBe("SERVICE_UNAVAILABLE");
  });

  it("maps DO HTTP 400 to INTERNAL_SERVER_ERROR and other HTTP to SERVICE_UNAVAILABLE", () => {
    expect(
      claimFailureCode(new ExposureRedemptionClaimFault("HTTP 400", { kind: "http", status: 400 })),
    ).toBe("INTERNAL_SERVER_ERROR");
    expect(
      claimFailureCode(new ExposureRedemptionClaimFault("HTTP 503", { kind: "http", status: 503 })),
    ).toBe("SERVICE_UNAVAILABLE");
  });

  it("maps protocol violations and TypeError to INTERNAL_SERVER_ERROR", () => {
    expect(
      claimFailureCode(new ExposureRedemptionClaimFault("invalid outcome", { kind: "protocol" })),
    ).toBe("INTERNAL_SERVER_ERROR");
    expect(claimFailureCode(new TypeError("undefined is not a function"))).toBe(
      "INTERNAL_SERVER_ERROR",
    );
  });
});
