import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors";
import { getRoute } from "./route-registry";

describe("Activation error disclosure contract", () => {
  it("adds one coarse non-retryable outcome without changing track", () => {
    const trackErrors = getRoute("sdk_track")?.errors ?? [];
    const activationErrors = getRoute("sdk_activate")?.errors ?? [];
    const trackSpecificErrors = trackErrors.filter((code) => code !== "UNSUPPORTED_MEDIA_TYPE");

    expect(activationErrors).toEqual([
      ...trackSpecificErrors.slice(0, -2),
      "ACTIVATION_NOT_AVAILABLE",
      ...trackSpecificErrors.slice(-2),
      "UNSUPPORTED_MEDIA_TYPE",
    ]);
    expect(
      ErrorResponseSchema.parse({
        code: "ACTIVATION_NOT_AVAILABLE",
        message: "Activation is not available for this Metric Event",
        details: {},
      }),
    ).toEqual({
      code: "ACTIVATION_NOT_AVAILABLE",
      message: "Activation is not available for this Metric Event",
      details: {},
    });
  });
});
