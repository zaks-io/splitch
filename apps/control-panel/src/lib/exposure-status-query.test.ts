import { describe, expect, it } from "vitest";
import {
  EXPOSURE_STATUS_POLL_INTERVAL_MS,
  exposureStatusDisplayState,
  exposureStatusRefetchInterval,
} from "./exposure-status-polling";

describe("Environment Exposure status polling", () => {
  it("polls only while a successful read says not_received", () => {
    expect(
      exposureStatusRefetchInterval({
        isError: false,
        data: { state: "not_received", firstExposureAt: null },
      }),
    ).toBe(EXPOSURE_STATUS_POLL_INTERVAL_MS);
    expect(
      exposureStatusRefetchInterval({
        isError: false,
        data: {
          state: "received",
          firstExposureAt: "2026-08-18T12:34:56.789Z",
        },
      }),
    ).toBe(false);
    expect(exposureStatusRefetchInterval({ isError: false, data: undefined })).toBe(false);
    expect(
      exposureStatusRefetchInterval({
        isError: true,
        data: { state: "not_received", firstExposureAt: null },
      }),
    ).toBe(false);
  });

  it("shows an error instead of stale not_received data after a failed poll", () => {
    expect(
      exposureStatusDisplayState({
        isPending: false,
        isError: true,
        data: { state: "not_received", firstExposureAt: null },
      }),
    ).toBe("error");
  });
});
