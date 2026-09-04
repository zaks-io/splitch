import { describe, expect, it } from "vitest";
import {
  buildCreateExperimentInput,
  buildDecisionPatch,
  buildMeasurementPatch,
  decisionIssues,
  experimentBasicsIssues,
  hasIssue,
  isExperimentDraftStep,
  type MeasurementDraft,
  measurementIssues,
  splitDimensions,
  targetingKeyTypeIssue,
} from "#lib/experiments/experiment-draft-model";

const basics = {
  name: "Checkout copy",
  key: "checkout-copy",
  flagId: "flag_1",
  targetingKey: "userId",
  targetingKeyType: "user",
};

const measurement: MeasurementDraft = {
  metricIds: ["met_signup"],
  guardrailMetricIds: ["met_latency"],
  conversionHours: "24",
};

describe("experimentBasicsIssues", () => {
  it("passes a complete draft", () => {
    expect(hasIssue(experimentBasicsIssues(basics))).toBe(false);
  });

  it("reports a missing field on that field, not as one blanket message", () => {
    const issues = experimentBasicsIssues({ ...basics, name: "  ", flagId: "" });

    expect(issues.name).toMatch(/Name this Experiment/);
    expect(issues.flagId).toMatch(/Flag this Experiment controls/);
    expect(issues.key).toBeNull();
  });

  it("rejects a key the Control Plane would reject, before the round trip", () => {
    expect(experimentBasicsIssues({ ...basics, key: "Checkout Copy" }).key).toMatch(/lowercase/);
  });

  it("rejects a typo-shaped Entity type the Worker would reject, before the round trip", () => {
    expect(
      experimentBasicsIssues({ ...basics, targetingKeyType: "User" }).targetingKeyType,
    ).toMatch(/lowercase/);
    expect(
      experimentBasicsIssues({ ...basics, targetingKeyType: "delivery-driver" }).targetingKeyType,
    ).toMatch(/lowercase/);
  });

  it("accepts a non-blessed Entity type that matches the Worker shape", () => {
    expect(
      experimentBasicsIssues({ ...basics, targetingKeyType: "restaurant" }).targetingKeyType,
    ).toBeNull();
  });
});

describe("targetingKeyTypeIssue", () => {
  it("requires a nonempty Entity type", () => {
    expect(targetingKeyTypeIssue("  ")).toMatch(/Entity type is required/);
  });

  it.each(["User", "delivery-driver", "user.type", "_user", "user__type"])(
    "rejects typo-shaped value %j and names the shape rule",
    (value) => {
      expect(targetingKeyTypeIssue(value)).toMatch(/single underscores between segments/);
    },
  );

  it("names the length cap when the value is already lowercase alphanumerics", () => {
    expect(targetingKeyTypeIssue("a".repeat(64))).toMatch(/63 characters/);
  });

  it.each(["user", "account", "restaurant", "delivery_driver", "service_account"])(
    "accepts open-vocabulary value %j",
    (value) => {
      expect(targetingKeyTypeIssue(value)).toBeNull();
    },
  );
});

describe("buildCreateExperimentInput", () => {
  it("creates the draft with an empty goal Metric family, deferring that choice to the next step", () => {
    const input = buildCreateExperimentInput(
      { appId: "app_1", environmentId: "env_1" },
      { ...basics, name: "  Checkout copy  ", key: " checkout-copy " },
      "idem_1",
    );

    expect(input).toEqual({
      appId: "app_1",
      environmentId: "env_1",
      name: "Checkout copy",
      key: "checkout-copy",
      flagId: "flag_1",
      targetingKey: "userId",
      targetingKeyType: "user",
      metrics: [],
      idempotency_key: "idem_1",
    });
  });
});

describe("measurementIssues", () => {
  it("passes a draft with a goal Metric and a disjoint Guardrail set", () => {
    expect(hasIssue(measurementIssues(measurement))).toBe(false);
  });

  it("refuses an empty goal Metric family", () => {
    expect(measurementIssues({ ...measurement, metricIds: [] }).metricIds).toMatch(/goal Metric/);
  });

  it("refuses a Metric that is both a goal and a Guardrail", () => {
    const issues = measurementIssues({ ...measurement, guardrailMetricIds: ["met_signup"] });

    expect(issues.guardrailMetricIds).toMatch(/cannot be both/);
  });

  it.each(["soon", ""])("refuses the conversion window %j rather than coercing it", (hours) => {
    expect(measurementIssues({ ...measurement, conversionHours: hours }).conversionHours).toMatch(
      /hours/,
    );
  });
});

describe("buildMeasurementPatch", () => {
  it("sends Metric refs and a millisecond conversion window", () => {
    expect(buildMeasurementPatch(measurement)).toEqual({
      metrics: [{ metricId: "met_signup" }],
      guardrailMetrics: [{ metricId: "met_latency" }],
      conversionWindowMs: 86_400_000,
    });
  });

  it("leaves the Activation Metric alone: the shared Run draft fields own it", () => {
    expect(buildMeasurementPatch(measurement)).not.toHaveProperty("activationMetricId");
  });
});

describe("decisionIssues", () => {
  it("accepts a confidence level inside (0.5, 1)", () => {
    expect(decisionIssues({ confidenceLevel: "0.95", dimensions: "" }).confidenceLevel).toBeNull();
  });

  it.each(["1", "0.4", "", "high"])("refuses confidence level %s", (confidenceLevel) => {
    expect(decisionIssues({ confidenceLevel, dimensions: "" }).confidenceLevel).toMatch(
      /between 0.5 and 1/,
    );
  });
});

describe("buildDecisionPatch", () => {
  it("sends a numeric confidence level and pre-registered Primary Dimensions", () => {
    expect(buildDecisionPatch({ confidenceLevel: "0.9", dimensions: "country, plan" })).toEqual({
      confidenceLevel: 0.9,
      dimensions: ["country", "plan"],
    });
  });
});

describe("splitDimensions", () => {
  it("drops blanks rather than pre-registering an empty Dimension name", () => {
    expect(splitDimensions(" country , , plan ,")).toEqual(["country", "plan"]);
  });
});

describe("isExperimentDraftStep", () => {
  it("accepts the known steps and rejects anything else", () => {
    expect(isExperimentDraftStep("decision")).toBe(true);
    expect(isExperimentDraftStep("results")).toBe(false);
    expect(isExperimentDraftStep(undefined)).toBe(false);
  });
});
