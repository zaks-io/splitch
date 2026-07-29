import { describe, expect, it } from "vitest";
import {
  emptyMetricDraft,
  METRIC_KINDS,
  metricCreateInput,
  metricDraft,
  metricDraftIssues,
  metricUpdateInput,
} from "./metric-form-model";

describe("Metric editor model", () => {
  it("supports all four aggregation types with their required fields", () => {
    expect(METRIC_KINDS.map(({ kind }) => kind)).toEqual(["binomial", "count", "revenue", "ratio"]);

    expect(
      metricDraftIssues({
        ...emptyMetricDraft(),
        name: "Orders",
        key: "orders",
        eventName: "order_completed",
        kind: "count",
      }),
    ).toContainEqual({
      path: "eventValueField",
      message: "Enter the event value field for this count Metric.",
    });
    expect(
      metricDraftIssues({
        ...emptyMetricDraft(),
        name: "Rate",
        key: "rate",
        eventName: "signed_up",
        kind: "ratio",
      }),
    ).toContainEqual({
      path: "denominatorMetricId",
      message: "Choose a denominator Metric.",
    });
  });

  it("builds type-appropriate create bodies without role fields", () => {
    const ratio = metricCreateInput("app_1", {
      ...emptyMetricDraft(),
      name: " Signup rate ",
      key: " signup-rate ",
      kind: "ratio",
      eventName: " signed_up ",
      denominatorMetricId: "metric_visitors",
    });

    expect(ratio).toEqual({
      appId: "app_1",
      name: "Signup rate",
      key: "signup-rate",
      kind: "ratio",
      eventName: "signed_up",
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
      eventName: "purchase_completed",
      eventValueField: "amount",
      createdAt: "2026-07-29T00:00:00.000Z",
    });

    expect(metricUpdateInput(draft)).toEqual({
      name: "Revenue",
      key: "revenue",
      description: "",
      eventName: "purchase_completed",
      eventValueField: "amount",
    });
    expect(metricUpdateInput(draft)).not.toHaveProperty("kind");
  });
});
