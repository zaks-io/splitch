import { describe, expect, it } from "vitest";
import { EnvironmentExposureStatusResponseSchema } from "./environment-exposure-status";

describe("Environment Exposure status contract", () => {
  it("accepts only the closed not-received and received states", () => {
    expect(
      EnvironmentExposureStatusResponseSchema.parse({
        state: "not_received",
        firstExposureAt: null,
      }),
    ).toEqual({ state: "not_received", firstExposureAt: null });
    expect(
      EnvironmentExposureStatusResponseSchema.parse({
        state: "received",
        firstExposureAt: "2026-08-18T12:34:56.789Z",
      }),
    ).toEqual({ state: "received", firstExposureAt: "2026-08-18T12:34:56.789Z" });

    expect(
      EnvironmentExposureStatusResponseSchema.safeParse({
        state: "unavailable",
        firstExposureAt: null,
      }).success,
    ).toBe(false);
    expect(
      EnvironmentExposureStatusResponseSchema.safeParse({
        state: "not_received",
        firstExposureAt: "2026-08-18T12:34:56.789Z",
      }).success,
    ).toBe(false);
    expect(
      EnvironmentExposureStatusResponseSchema.safeParse({
        state: "received",
        firstExposureAt: null,
      }).success,
    ).toBe(false);
  });
});
