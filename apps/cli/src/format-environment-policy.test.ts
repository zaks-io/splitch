import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/sdk/control-plane";
import { describe, expect, it } from "vitest";
import { formatEnvironmentPolicy, isEnvironmentPolicy } from "./format-environment-policy.js";

describe("formatEnvironmentPolicy", () => {
  it("states the kill-switch-off exemption under enabledState", () => {
    const rendered = formatEnvironmentPolicy({
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    });
    expect(rendered).toContain("enabledState: confirm");
    expect(rendered).toContain(`  ${KILL_SWITCH_OFF_EXEMPTION}`);
    expect(rendered.indexOf("enabledState")).toBeLessThan(
      rendered.indexOf(KILL_SWITCH_OFF_EXEMPTION),
    );
  });

  it("accepts a well-formed Environment Policy shape", () => {
    expect(
      isEnvironmentPolicy({
        variantAvailability: "allow",
        targetingRolloutValue: "confirm",
        enabledState: "confirm",
        startExperimentRun: "allow",
      }),
    ).toBe(true);
    expect(isEnvironmentPolicy({ enabledState: "confirm" })).toBe(false);
  });
});
