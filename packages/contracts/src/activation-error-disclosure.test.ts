import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors";
import { getRoute } from "./route-registry";

describe("Activation error disclosure contract", () => {
  it("adds one coarse non-retryable outcome without changing track", () => {
    const trackErrors = getRoute("sdk_track")?.errors ?? [];
    const activationErrors = getRoute("sdk_activate")?.errors ?? [];

    expect(activationErrors).toEqual([
      ...trackErrors.slice(0, -2),
      "ACTIVATION_NOT_AVAILABLE",
      ...trackErrors.slice(-2),
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
