import { CURRENT_ANALYSIS_VERSION } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { concludeRun } from "./experiment-conclusion-handler";
import {
  conclusionFixture,
  readyEnvelope,
  resultToken,
  type runRow,
} from "./experiment-conclusion-handler-test-fixtures";
import { statsOutput } from "./panel-experiments-test-fixtures";

const STARTED_AT = "2026-09-01T00:00:00.000Z";
const DAY_ONE_WATERMARK = "2026-09-02T00:00:00.000Z";
const DAY_SEVEN_NOW = "2026-09-08T00:05:00.000Z";
const WEEK_ONE_WATERMARK = "2026-09-08T00:00:00.000Z";

/** A Run started under the current engine with the default one-week plan. */
const committedRun = {
  startedAt: STARTED_AT,
  analysisVersion: CURRENT_ANALYSIS_VERSION,
  targetN: 5000,
  targetNSource: "default" as const,
  plannedDurationDays: 7,
};

async function conclude(
  watermark: string,
  nowIso: string,
  run: Partial<ReturnType<typeof runRow>> = committedRun,
) {
  const stats = statsOutput();
  const token = await resultToken(stats, run.analysisVersion ?? null);
  const fixture = conclusionFixture({
    expectedResultToken: token,
    analysisEnvelope: readyEnvelope(stats, token, watermark),
    dataWatermark: watermark,
    nowIso,
    run,
  });
  fixture.commit.mockRejectedValue(new Error("reached the commit"));
  const outcome = await concludeRun(fixture.deps, fixture.args).then(
    (response) => ({ response }),
    (error: Error) => ({ error }),
  );
  return { fixture, outcome };
}

describe("concludeRun planned duration (ADR-0059)", () => {
  it("refuses a day-seven Conclude that selects day-one evidence and writes nothing", async () => {
    const { fixture, outcome } = await conclude(DAY_ONE_WATERMARK, DAY_SEVEN_NOW);

    if (!("response" in outcome)) throw outcome.error;
    expect(outcome.response.status).toBe(409);
    expect(await outcome.response.json()).toMatchObject({
      code: "DECISION_BLOCKED",
      message: "Run conclusion is blocked: Run has not reached its planned duration",
      details: {
        failures: [
          {
            code: "DECISION_DURATION_INCOMPLETE",
            checkIds: ["planned_duration"],
            details: {
              plannedDurationDays: 7,
              observedDays: 1,
              runStartedAt: STARTED_AT,
              earliestDecisionWatermark: WEEK_ONE_WATERMARK,
              overrideReason: null,
            },
          },
        ],
      },
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("refuses a direct Conclude before the planned duration and writes nothing", async () => {
    const { fixture, outcome } = await conclude(DAY_ONE_WATERMARK, "2026-09-02T00:05:00.000Z");

    if (!("response" in outcome)) throw outcome.error;
    expect(outcome.response.status).toBe(409);
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("lets evidence that spans the planned duration through to the commit", async () => {
    const { fixture, outcome } = await conclude(WEEK_ONE_WATERMARK, DAY_SEVEN_NOW);

    expect(outcome).toEqual({ error: new Error("reached the commit") });
    expect(fixture.commit).toHaveBeenCalledTimes(1);
  });

  it("measures a labeled override against the evidence window too", async () => {
    const { outcome } = await conclude("2026-09-04T00:00:00.000Z", DAY_SEVEN_NOW, {
      ...committedRun,
      plannedDurationDays: 3,
      plannedDurationOverrideReason: "holiday code freeze",
    });

    expect(outcome).toEqual({ error: new Error("reached the commit") });
  });

  it("does not block a legacy Run that never recorded a planned duration", async () => {
    const { fixture, outcome } = await conclude(DAY_ONE_WATERMARK, DAY_SEVEN_NOW, {
      startedAt: STARTED_AT,
    });

    expect(outcome).toEqual({ error: new Error("reached the commit") });
    expect(fixture.commit).toHaveBeenCalledTimes(1);
  });

  it("refuses evidence minted under a different analysis version than the Run froze", async () => {
    const stats = statsOutput();
    const legacyToken = await resultToken(stats);
    const fixture = conclusionFixture({
      expectedResultToken: legacyToken,
      analysisEnvelope: readyEnvelope(stats, legacyToken, WEEK_ONE_WATERMARK),
      dataWatermark: WEEK_ONE_WATERMARK,
      run: committedRun,
    });

    await expect(concludeRun(fixture.deps, fixture.args)).rejects.toThrow(
      "Analysis result token is not bound to the selected Run configuration",
    );
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});
