import { describe, expect, it } from "vitest";
import { check, gateFor, reachedDuration, stats } from "./experiment-decision-gate-test-fixtures";

const STARTED = "2026-07-01T00:00:00.000Z";

describe("planned_duration gate check", () => {
  it("passes once the selected evidence spans the planned duration", () => {
    const gate = gateFor(stats());

    expect(gate.shipAllowed).toBe(true);
    expect(check(gate, "planned_duration")).toMatchObject({
      status: "pass",
      title: "Planned duration reached",
    });
  });

  it("measures the evidence watermark, not the clock, so day-one evidence fails on day seven", () => {
    const gate = gateFor(
      stats(),
      undefined,
      reachedDuration({ runStartedAt: STARTED, dataWatermark: "2026-07-02T00:00:00.000Z" }),
    );

    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toEqual(["planned_duration"]);
    expect(check(gate, "planned_duration").detail).toBe(
      "The selected evidence covers 1 day of the 7 days this Run planned at Start. Select evidence with a watermark at or after 2026-07-08T00:00:00.000Z.",
    );
  });

  it("never rounds a window just short of the plan up to it", () => {
    const gate = gateFor(
      stats(),
      undefined,
      reachedDuration({ dataWatermark: "2026-07-07T23:59:00.000Z" }),
    );

    expect(check(gate, "planned_duration")).toMatchObject({ status: "fail" });
    expect(check(gate, "planned_duration").detail).toContain("covers 6.9 days");
  });

  it("fails when Analysis reported no watermark to measure against", () => {
    const gate = gateFor(stats(), undefined, reachedDuration({ dataWatermark: null }));

    expect(check(gate, "planned_duration")).toMatchObject({
      status: "fail",
      title: "No evidence watermark to measure duration against",
    });
  });

  it("names a labeled override in the reason", () => {
    const gate = gateFor(
      stats(),
      undefined,
      reachedDuration({
        plannedDurationDays: 3,
        overrideReason: "holiday code freeze",
        dataWatermark: "2026-07-04T00:00:00.000Z",
      }),
    );

    expect(check(gate, "planned_duration")).toMatchObject({ status: "pass" });
    expect(check(gate, "planned_duration").detail).toContain(
      "labeled override: holiday code freeze",
    );
  });

  it("is not applicable, and blocks nothing, on a legacy Run with no recorded plan", () => {
    const gate = gateFor(
      stats(),
      undefined,
      reachedDuration({ plannedDurationDays: null, dataWatermark: "2026-07-01T01:00:00.000Z" }),
    );

    expect(gate.shipAllowed).toBe(true);
    expect(check(gate, "planned_duration")).toMatchObject({
      status: "not_applicable",
      title: "No planned duration recorded",
    });
  });
});
