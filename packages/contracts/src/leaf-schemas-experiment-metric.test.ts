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
  eventDefinitionId: "checkout_completed",
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
  it("parses without eventFieldName or denominator", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial" });
    expect(m.kind).toBe("binomial");
  });

  it("parses a regular Metric carrying a downsideThresholdPct", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial", downsideThresholdPct: -0.5 });
    expect(m.downsideThresholdPct).toBe(-0.5);
  });
});

describe("MetricSchema — count / revenue require eventFieldName", () => {
  it("parses count with eventFieldName", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "count", eventFieldName: "items" });
    expect(m.eventFieldName).toBe("items");
  });

  it("parses revenue with eventFieldName", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "revenue", eventFieldName: "amount" });
    expect(m.kind).toBe("revenue");
  });

  it("rejects count without eventFieldName", () => {
    expect(MetricSchema.safeParse({ ...baseMetric, kind: "count" }).success).toBe(false);
  });

  it("rejects revenue with a null eventFieldName", () => {
    expect(
      MetricSchema.safeParse({ ...baseMetric, kind: "revenue", eventFieldName: null }).success,
    ).toBe(false);
  });

  it("rejects an eventFieldName on a Binomial Metric", () => {
    expect(
      MetricSchema.safeParse({ ...baseMetric, kind: "binomial", eventFieldName: "amount" }).success,
    ).toBe(false);
  });
});

describe("MetricSchema — ratio requires two operand Metrics", () => {
  it("parses ratio with distinct numerator and denominator MetricRefs", () => {
    const m = MetricSchema.parse({
      ...baseMetric,
      kind: "ratio",
      eventDefinitionId: null,
      numerator: { metricId: "metric_num" },
      denominator: { metricId: "metric_denom" },
    });
    expect(m.denominator?.metricId).toBe("metric_denom");
  });

  it("parses an explicitly incomplete legacy ratio so callers can repair it", () => {
    const m = MetricSchema.parse({
      ...baseMetric,
      kind: "ratio",
      configurationStatus: "needs_configuration",
      denominator: { metricId: "metric_denom" },
    });

    expect(m).toMatchObject({
      eventDefinitionId: "checkout_completed",
      configurationStatus: "needs_configuration",
      denominator: { metricId: "metric_denom" },
    });
  });

  it("rejects ratio without its operands", () => {
    expect(MetricSchema.safeParse({ ...baseMetric, kind: "ratio" }).success).toBe(false);
  });

  it("rejects an incomplete legacy ratio without its explicit status", () => {
    expect(
      MetricSchema.safeParse({
        ...baseMetric,
        kind: "ratio",
        denominator: { metricId: "metric_denom" },
      }).success,
    ).toBe(false);
  });

  it("rejects ratio with a null denominator", () => {
    expect(
      MetricSchema.safeParse({
        ...baseMetric,
        kind: "ratio",
        eventDefinitionId: null,
        numerator: { metricId: "metric_num" },
        denominator: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a denominator that is not a MetricRef", () => {
    expect(
      MetricSchema.safeParse({
        ...baseMetric,
        kind: "ratio",
        eventDefinitionId: null,
        numerator: { metricId: "metric_num" },
        denominator: "metric_denom",
      }).success,
    ).toBe(false);
  });

  it("rejects a direct Event Definition or identical operands", () => {
    const ratio = {
      ...baseMetric,
      kind: "ratio",
      numerator: { metricId: "metric_operand" },
      denominator: { metricId: "metric_operand" },
    };
    expect(MetricSchema.safeParse(ratio).success).toBe(false);
    expect(MetricSchema.safeParse({ ...ratio, eventDefinitionId: null }).success).toBe(false);
  });

  it("rejects Ratio operands on a non-Ratio Metric", () => {
    expect(
      MetricSchema.safeParse({
        ...baseMetric,
        kind: "binomial",
        numerator: { metricId: "metric_num" },
        denominator: { metricId: "metric_denom" },
      }).success,
    ).toBe(false);
  });
});

describe("MetricSchema — required fields", () => {
  it("accepts an optional description", () => {
    const m = MetricSchema.parse({ ...baseMetric, kind: "binomial", description: "Conv rate" });
    expect(m.description).toBe("Conv rate");
  });

  it("rejects a missing eventDefinitionId", () => {
    const { eventDefinitionId: _, ...rest } = baseMetric;
    expect(MetricSchema.safeParse({ ...rest, kind: "binomial" }).success).toBe(false);
  });

  it("rejects a missing kind", () => {
    expect(MetricSchema.safeParse(baseMetric).success).toBe(false);
  });
});
