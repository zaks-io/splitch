import { describe, expect, it } from "vitest";
import { metricDisplayName, withMetricNames } from "./metric-names";

describe("withMetricNames", () => {
  it("substitutes an ordinary Metric display name", () => {
    expect(withMetricNames("metric_x failed", new Map([["metric_x", "Checkout conversion"]]))).toBe(
      "Checkout conversion failed",
    );
  });

  it("treats $& as literal authored text, not the matched Metric id", () => {
    expect(withMetricNames("metric_x failed", new Map([["metric_x", "Revenue $&"]]))).toBe(
      "Revenue $& failed",
    );
  });

  it("treats $' as literal authored text, not the unmatched suffix", () => {
    expect(withMetricNames("metric_x failed", new Map([["metric_x", "Revenue $'"]]))).toBe(
      "Revenue $' failed",
    );
  });

  it("treats $ as literal authored text", () => {
    expect(withMetricNames("metric_x failed", new Map([["metric_x", "Revenue $"]]))).toBe(
      "Revenue $ failed",
    );
  });

  it("leaves a deleted Metric id in place when no display name remains", () => {
    expect(withMetricNames("metric_x failed", new Map())).toBe("metric_x failed");
  });
});

describe("metricDisplayName", () => {
  it("falls back to the raw Metric id after the catalog entry is gone", () => {
    expect(metricDisplayName("metric_x", new Map())).toBe("metric_x");
  });

  it("returns the authored display name when the catalog still has it", () => {
    expect(metricDisplayName("metric_x", new Map([["metric_x", "Revenue $&"]]))).toBe("Revenue $&");
  });
});
