import { describe, expect, it } from "vitest";
import { parsePreRegistrationIntent } from "./experiment-model";

const validFrozen = {
  hypothesis: "Treatment raises signup",
  primary_metric_id: "metric_goal",
  metrics: [{ metric_id: "metric_goal", desirability: "higher_is_better" as const }],
  ship_rule: {
    required_margin: 0.02,
    margin_scale: "absolute" as const,
    conflict_resolution: "primary_wins" as const,
  },
};

describe("parsePreRegistrationIntent", () => {
  it("treats recorded null as never registered", () => {
    expect(parsePreRegistrationIntent(null)).toBeUndefined();
  });

  it("parses a valid frozen blob into Start-body camelCase", () => {
    expect(parsePreRegistrationIntent(JSON.stringify(validFrozen))).toEqual({
      hypothesis: "Treatment raises signup",
      primaryMetricId: "metric_goal",
      metrics: [{ metricId: "metric_goal", desirability: "higher_is_better" }],
      shipRule: {
        requiredMargin: 0.02,
        marginScale: "absolute",
        conflictResolution: "primary_wins",
      },
      futility: "off",
    });
  });

  it("refuses an empty string instead of reading it as never registered", () => {
    expect(() => parsePreRegistrationIntent("")).toThrow(/pre_registration is empty/);
  });

  it("refuses a missing column instead of reading it as never registered", () => {
    expect(() => parsePreRegistrationIntent(undefined)).toThrow(/pre_registration is empty/);
  });

  it("refuses corrupted JSON instead of dropping the freeze", () => {
    expect(() => parsePreRegistrationIntent("{not-json")).toThrow(/not valid JSON/);
  });

  it("refuses a schema-invalid blob instead of dropping the freeze", () => {
    expect(() =>
      parsePreRegistrationIntent(JSON.stringify({ ...validFrozen, hypothesis: "" })),
    ).toThrow(/pre_registration is invalid/);
  });
});
