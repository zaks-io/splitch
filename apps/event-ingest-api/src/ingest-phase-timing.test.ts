import { afterEach, describe, expect, it, vi } from "vitest";
import { createIngestPhaseTiming, ingestTimingOutcomeFor } from "./ingest-phase-timing";

afterEach(() => vi.restoreAllMocks());

describe("ingest phase timing", () => {
  it.each([
    [202, "accepted"],
    [400, "rejected"],
    [429, "rejected"],
    [500, "fault"],
    [503, "fault"],
  ] as const)("classifies HTTP %i as %s", (status, outcome) => {
    expect(ingestTimingOutcomeFor(new Response(null, { status }))).toBe(outcome);
  });

  it("emits stable phase durations without identity values", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ticks = [0, 1, 3, 5];
    const timing = createIngestPhaseTiming(
      { SPLITCH_PLATFORM_TARGET: "production" },
      { route: "internal_exposure", stream: "raw_events" },
      () => ticks.shift() ?? 5,
    );

    await timing.measure("auth", async () => undefined);
    timing.emit("accepted", {
      serializedBytes: 128,
      targetingKey: "user@example.com",
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      level: "info",
      message: "ingest_phase_timing",
      surface: "event-ingest-api",
      environment: "production",
      route: "internal_exposure",
      stream: "raw_events",
      outcome: "accepted",
      itemCount: 1,
      totalMs: 5,
      authMs: 2,
      serializedBytes: 128,
    });
    expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("user@example.com");
  });
});
