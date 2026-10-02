import { describe, expect, it } from "vitest";
import {
  analysisReturning,
  ids,
  repository,
  results,
} from "./panel-experiment-results-test-harness";
import { runRow, statsOutput } from "./panel-experiments-test-fixtures";

describe("panel Experiment Results planned duration (ADR-0059)", () => {
  const committedRun = {
    ...runRow(ids, 2),
    analysisVersion: "2026-10-02",
    plannedDurationDays: 7,
  };

  it("blocks a Run whose evidence watermark is short of its planned duration", async () => {
    const response = await results(
      analysisReturning(statsOutput(), {
        data_watermark: "2026-07-20T00:00:00.000Z",
        result_token: `sha256:${"b".repeat(64)}`,
      }),
      {},
      repository({ runs: [committedRun] }),
    );
    const body = (await response.json()) as {
      gate: { blockedBy: string[]; checks: { id: string; status: string; detail: string }[] };
    };

    expect(body.gate.blockedBy).toEqual(["planned_duration"]);
    expect(body.gate.checks.find((check) => check.id === "planned_duration")?.detail).toContain(
      "covers 1 day of the 7 days",
    );
  });

  it("reports the check as not applicable on a legacy Run instead of inventing a plan", async () => {
    const response = await results(analysisReturning(statsOutput()));
    const body = (await response.json()) as {
      gate: { checks: { id: string; status: string }[] };
    };

    expect(body.gate.checks.find((check) => check.id === "planned_duration")?.status).toBe(
      "not_applicable",
    );
  });
});
