import { describe, expect, it } from "vitest";
import { MetricQueryConfigSchema } from "./stats-input-contract";

describe("MetricQueryConfigSchema window_offset_ms", () => {
  const window = { window_duration_ms: 1_000, cuped_lookback_ms: 2_000 };

  it.each(["binomial", "count", "revenue", "ratio"] as const)(
    "rejects window_offset_ms for %s Metrics",
    (metric_type) => {
      const base =
        metric_type === "ratio"
          ? {
              ...window,
              metric_id: "metric_cost_per_token",
              metric_type,
              numerator: {
                metric_id: "metric_cost",
                metric_type: "revenue" as const,
                event_definition_id: "event_llm_call",
                event_field_name: "cost",
              },
              denominator: {
                metric_id: "metric_tokens",
                metric_type: "count" as const,
                event_definition_id: "event_llm_call",
                event_field_name: "tokens",
              },
              window_offset_ms: 86_400_000,
            }
          : metric_type === "binomial"
            ? {
                ...window,
                metric_id: "metric_signup",
                metric_type,
                event_definition_id: "event_signup",
                event_field_name: null,
                window_offset_ms: 86_400_000,
              }
            : {
                ...window,
                metric_id: "metric_cost",
                metric_type,
                event_definition_id: "event_llm_call",
                event_field_name: "cost",
                window_offset_ms: 86_400_000,
              };
      expect(MetricQueryConfigSchema.safeParse(base).success).toBe(false);
    },
  );
});
