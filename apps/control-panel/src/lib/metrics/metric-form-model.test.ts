import { describe, expect, it } from "vitest";
import {
  emptyMetricDraft,
  metricCreateInput,
  metricDraft,
  metricDraftIssues,
  metricKindOptions,
  metricUpdateInput,
} from "#lib/metrics/metric-form-model";

describe("Metric editor model", () => {
  it("supports all four aggregation types with their required fields", () => {
    expect(metricKindOptions(true).map(({ kind }) => kind)).toEqual([
      "binomial",
      "count",
      "revenue",
      "ratio",
    ]);

    expect(
      metricDraftIssues({
        ...emptyMetricDraft(),
        name: "Orders",
        key: "orders",
        eventDefinitionId: "order_completed",
        kind: "count",
      }),
    ).toContainEqual({
      path: "eventFieldName",
      message: "Enter the event value field for this count Metric.",
    });
    expect(
      metricDraftIssues({
        ...emptyMetricDraft(),
        name: "Rate",
        key: "rate",
        kind: "ratio",
      }),
    ).toContainEqual({
      path: "denominatorMetricId",
      message: "Choose a denominator Metric.",
    });
  });

  it("disables Ratio with an explanation until two operand Metrics exist", () => {
    expect(metricKindOptions(false).find(({ kind }) => kind === "ratio")).toEqual({
      kind: "ratio",
      label: "Ratio (create two Metrics first)",
      disabled: true,
    });
    expect(metricKindOptions(true).find(({ kind }) => kind === "ratio")).toEqual({
      kind: "ratio",
      label: "Ratio",
      disabled: false,
    });
  });

  it("builds type-appropriate create bodies without role fields", () => {
    const ratio = metricCreateInput("app_1", {
      ...emptyMetricDraft(),
      name: " Signup rate ",
      key: " signup-rate ",
      kind: "ratio",
      numeratorMetricId: "metric_signups",
      denominatorMetricId: "metric_visitors",
    });

    expect(ratio).toEqual({
      appId: "app_1",
      name: "Signup rate",
      key: "signup-rate",
      kind: "ratio",
      numerator: { metricId: "metric_signups" },
      denominator: { metricId: "metric_visitors" },
    });
    expect(JSON.stringify(ratio)).not.toMatch(/role|guardrail|activation/u);
  });

  it("keeps the aggregation type immutable in update bodies", () => {
    const draft = metricDraft({
      id: "metric_1",
      appId: "app_1",
      name: "Revenue",
      key: "revenue",
      kind: "revenue",
      eventDefinitionId: "purchase_completed",
      eventFieldName: "amount",
      createdAt: "2026-07-29T00:00:00.000Z",
    });

    expect(metricUpdateInput(draft)).toEqual({
      name: "Revenue",
      key: "revenue",
      description: "",
      eventDefinitionId: "purchase_completed",
      eventFieldName: "amount",
    });
    expect(metricUpdateInput(draft)).not.toHaveProperty("kind");
  });

  it("turns an incomplete legacy Ratio into a canonical operand repair", () => {
    const draft = metricDraft({
      id: "metric_ratio_legacy",
      appId: "app_1",
      name: "Legacy rate",
      key: "legacy-rate",
      kind: "ratio",
      eventDefinitionId: "event_definition_numerator",
      denominator: { metricId: "metric_denominator" },
      configurationStatus: "needs_configuration",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    draft.numeratorMetricId = "metric_numerator";

    expect(metricUpdateInput(draft)).toMatchObject({
      eventDefinitionId: null,
      numerator: { metricId: "metric_numerator" },
      denominator: { metricId: "metric_denominator" },
    });
  });
});
