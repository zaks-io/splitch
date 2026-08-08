import { describe, expect, it } from "vitest";
import { errorCodes } from "../error-code";
import { isRetryableExposureRejection, RETRYABLE_EXPOSURE_REJECTION_CODES } from "./exposures-wire";

/**
 * Pins exposures-endpoint.md ingest/claim taxonomy: only SERVICE_UNAVAILABLE is
 * retryable per item. INTERNAL_SERVER_ERROR (deterministic claim-store faults) and
 * caller-payload codes must not be re-queued.
 */
describe("Exposure rejection retry taxonomy (exposures-endpoint.md)", () => {
  it("names SERVICE_UNAVAILABLE as the sole retryable per-item code", () => {
    expect([...RETRYABLE_EXPOSURE_REJECTION_CODES]).toEqual(["SERVICE_UNAVAILABLE"]);
  });

  it("treats SERVICE_UNAVAILABLE as retryable and every other ErrorCode as terminal", () => {
    expect(isRetryableExposureRejection("SERVICE_UNAVAILABLE")).toBe(true);
    expect(isRetryableExposureRejection(null)).toBe(false);
    for (const code of errorCodes) {
      if (code === "SERVICE_UNAVAILABLE") continue;
      expect(isRetryableExposureRejection(code)).toBe(false);
    }
  });

  it("marks INTERNAL_SERVER_ERROR non-retryable (deterministic claim-store faults)", () => {
    expect(isRetryableExposureRejection("INTERNAL_SERVER_ERROR")).toBe(false);
  });

  it("marks VALIDATION_ERROR and ticket faults non-retryable", () => {
    expect(isRetryableExposureRejection("VALIDATION_ERROR")).toBe(false);
    expect(isRetryableExposureRejection("EXPOSURE_TICKET_INVALID")).toBe(false);
    expect(isRetryableExposureRejection("EXPOSURE_TICKET_EXPIRED")).toBe(false);
    expect(isRetryableExposureRejection("EVENT_ID_CONFLICT")).toBe(false);
  });
});
