import { describe, expect, it } from "vitest";
import {
  MetricKindSchema,
  MetricRefSchema,
  MetricSchema,
  metricKinds,
} from "./leaf-schemas-experiment";

const baseMetric = {
  id: "metric_1",
  appId: "app_1",
  key: "checkout-conversion",
  name: "Checkout Conversion",
  eventName: "checkout_completed",
  createdAt: "2024-01-01T00:00:00Z",
};

describe("MetricKindSchema", () => {
  it("accepts every declared kind", () => {
    for (const k of metricKinds) {
      expect(MetricKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(MetricKindSchema.safeParse("histogram").success).toBe(false);
    expect(MetricKindSchema.safeParse("").success).toBe(false);
  });
});

describe("MetricRefSchema", () => {
  it("parses a valid reference", () => {
    expect(MetricRefSchema.parse({ metricId: "metric_2" }).metricId).toBe("metric_2");
  });

  it("rejects a missing metricId", () => {
    expect(MetricRefSchema.safeParse({}).success).toBe(false);
  });
});

describe("MetricSchema — binomial", () => {
  it("parses without eventValueField or denominator", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial" });
    expect(m.kind).toBe("binomial");
  });

  it("parses a regular Metric carrying a downsideThresholdPct", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial", downsideThresholdPct: -0.5 });
    expect(m.downsideThresholdPct).toBe(-0.5);
  });
});

describe("MetricSchema — count / revenue require eventValueField", () => {
  it("parses count with eventValueField", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "count", eventValueField: "items" });
    expect(m.eventValueField).toBe("items");
  });

  it("parses revenue with eventValueField", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "revenue", eventValueField: "amount" });
    expect(m.kind).toBe("revenue");
  });

  it("rejects count without eventValueField", () => {
    expect(MetricSchema.safeParse({ ...baseMetric, kind: "count" }).success).toBe(false);
  });

  it("rejects revenue with a null eventValueField", () => {
    expect(
      MetricSchema.safeParse({ ...baseMetric, kind: "revenue", eventValueField: null }).success,
    ).toBe(false);
  });
});

describe("MetricSchema — ratio requires denominator", () => {
  it("parses ratio with a denominator MetricRef", () => {
    const m = MetricSchema.parse({
      ...baseMetric,
      kind: "ratio",
      denominator: { metricId: "metric_denom" },
    });
    expect(m.denominator?.metricId).toBe("metric_denom");
  });

  it("rejects ratio without a denominator", () => {
    expect(MetricSchema.safeParse({ ...baseMetric, kind: "ratio" }).success).toBe(false);
  });

  it("rejects ratio with a null denominator", () => {
    expect(
      MetricSchema.safeParse({ ...baseMetric, kind: "ratio", denominator: null }).success,
    ).toBe(false);
  });

  it("rejects a denominator that is not a MetricRef", () => {
    expect(
      MetricSchema.safeParse({ ...baseMetric, kind: "ratio", denominator: "metric_denom" }).success,
    ).toBe(false);
  });
});

describe("MetricSchema — required fields", () => {
  it("accepts an optional description", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial", description: "Conv rate" });
    expect(m.description).toBe("Conv rate");
  });

  it("rejects a missing eventName", () => {
    const { eventName: _, ...rest } = baseMetric;
    expect(MetricSchema.safeParse({ ...rest, kind: "binomial" }).success).toBe(false);
  });

  it("rejects a missing kind", () => {
    expect(MetricSchema.safeParse(baseMetric).success).toBe(false);
  });
});
