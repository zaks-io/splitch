import { RETRYABLE_EXPOSURE_REJECTION_CODES as ContractRetryable } from "../../contracts/src/leaves/exposures-wire";
import { describe, expect, it } from "vitest";
import { RETRYABLE_EXPOSURE_REJECTION_CODES as SdkRetryable } from "./exposure-retry";

/**
 * Spec ↔ contracts ↔ SDK agreement pin for exposures-endpoint.md retry taxonomy.
 */
describe("Exposure retry taxonomy parity (SPL-366)", () => {
  it("keeps the SDK retryable set identical to contracts", () => {
    expect([...SdkRetryable]).toEqual([...ContractRetryable]);
    expect([...SdkRetryable]).toEqual(["SERVICE_UNAVAILABLE"]);
  });
});
