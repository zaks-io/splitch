import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../src/config-store-harness-core";
import type { ControlPlaneApiEnv } from "../src/env";
import { runControlPlaneScheduled } from "../src/scheduled";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

describe("Metric Event claim retention scheduled adoption", () => {
  it("reports a halted backfill before waitUntil rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];

    runControlPlaneScheduled(
      {
        cron: "0 8 * * *",
        scheduledTime: Date.parse("2026-08-07T08:00:00.000Z"),
        noRetry: vi.fn(),
      } as ScheduledController,
      scheduledEnv(() =>
        Promise.reject(
          new Error(
            "Metric Event claim retention backfill returned 503: halted=missing-claim failedAttempts=0",
          ),
        ),
      ),
      { waitUntil: (promise) => waits.push(promise) } as unknown as ExecutionContext,
    );
    const results = await Promise.allSettled(waits);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const row = consoleError.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .find((value) => value.message === "metric_event_claim_retention_adoption_failed");
    expect(row).toMatchObject({
      level: "error",
      job: "metric-event-claim-retention-adoption",
      cron: "0 8 * * *",
    });
    expect(row?.fault).toEqual(expect.stringContaining("halted=missing-claim"));
  });
});

function scheduledEnv(adoptMetricEventClaimRetention: () => Promise<void>): ControlPlaneApiEnv {
  return {
    DB: h.d1,
    EVENT_INGEST_API: { adoptMetricEventClaimRetention },
    PRIVACY_JOBS_QUEUE: { send: () => Promise.resolve() },
    PRIVACY_EXPORTS: {
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
    },
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://api.tinybird.test",
    TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "write-token",
  } as unknown as ControlPlaneApiEnv;
}
