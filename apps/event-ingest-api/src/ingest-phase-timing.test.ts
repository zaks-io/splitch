import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubSentrySpan } from "@splitch/privacy";
import type {
  PerformanceSpanDescriptor,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import { createIngestPhaseTiming, ingestTimingOutcomeFor } from "./ingest-phase-timing";

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

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
    const descriptors: PerformanceSpanDescriptor[] = [];
    const spans = recordingSpans(descriptors);
    const timing = createIngestPhaseTiming(
      { SPLITCH_PLATFORM_TARGET: "production" },
      { route: "internal_exposure", stream: "raw_events" },
      () => ticks.shift() ?? 5,
      spans,
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
    expect(descriptors).toEqual([
      {
        name: "Event ingest internal_exposure auth",
        op: "event.ingest.phase",
      },
    ]);
    expect(
      scrubSentrySpan({
        op: descriptors[0]?.op,
        description: descriptors[0]?.name,
      }),
    ).toEqual({
      op: "event.ingest.phase",
      description: "Event ingest internal_exposure auth",
    });
  });

  it("closes the configured Sentry span and preserves timing when a phase throws", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ticks = [0, 1, 4, 6];
    let closed = false;
    const startSpan = vi.fn(
      async (
        _descriptor: unknown,
        run: (span: { setAttribute(): void; setAttributes(): void }) => Promise<unknown>,
      ) => {
        try {
          return await run({ setAttribute() {}, setAttributes() {} });
        } finally {
          closed = true;
        }
      },
    );
    __setSentryModuleForTests({ startSpan } as unknown as Parameters<
      typeof __setSentryModuleForTests
    >[0]);
    const timing = createIngestPhaseTiming(
      { SENTRY_DSN: "https://public@example.invalid/1", SPLITCH_PLATFORM_TARGET: "production" },
      { route: "internal_exposure", stream: "raw_events" },
      () => ticks.shift() ?? 6,
    );
    const failure = new Error("queue unavailable");

    await expect(
      timing.measure("queue", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    timing.emit("fault", { serializedBytes: 128 });

    expect(startSpan).toHaveBeenCalledWith(
      {
        name: "Event ingest internal_exposure queue",
        op: "event.ingest.phase",
        attributes: undefined,
      },
      expect.any(Function),
    );
    expect(closed).toBe(true);
    expect(info.mock.calls[0]?.[0]).toMatchObject({ queueMs: 3, totalMs: 6 });
  });
});

function recordingSpans(descriptors: PerformanceSpanDescriptor[]): PerformanceSpanRecorder {
  return {
    async record(descriptor, run) {
      descriptors.push(descriptor);
      return run({ setAttribute() {}, setAttributes() {} });
    },
  };
}
