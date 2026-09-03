import { describe, expect, it, vi } from "vitest";
import { readDownstreamAnalysisRows } from "./results-downstream-rows";

describe("readDownstreamAnalysisRows", () => {
  it("skips every downstream read when the Run has no analyzed Metrics", async () => {
    const readPipe = vi.fn(async () => {
      throw new Error("downstream reads must not run without analyzed Metrics");
    });

    await expect(
      readDownstreamAnalysisRows({
        tinybird: { readPipe },
        params: { app_id: "app_1", environment_id: "env_1", run_id: "run_1" },
        metricQueryConfig: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        toTs: "2026-01-02T00:00:00.000Z",
        activationGated: true,
        hasAnalyzedMetrics: false,
      }),
    ).resolves.toEqual({ metricRows: [], prePeriodRows: [], activationRows: [] });
    expect(readPipe).not.toHaveBeenCalled();
  });
});
