import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../src/config-store-harness-core";
import type { ControlPlaneApiEnv } from "../src/env";
import { runControlPlaneScheduled } from "../src/scheduled";
import { seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

const REQUEST_IDS = ["apr_archive_schedule_poison_a", "apr_archive_schedule_poison_b"];
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

describe("Approval Request scheduled archival", () => {
  it("logs the complete archival failure before waitUntil rejects", async () => {
    for (const id of REQUEST_IDS) {
      await seedApprovalArchiveFixture(h.d1, {
        id,
        resolvedAt: "2026-05-01T12:00:00.000Z",
      });
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];

    runControlPlaneScheduled(
      {
        cron: "0 8 * * *",
        scheduledTime: Date.parse("2026-08-07T12:00:00.000Z"),
        noRetry: vi.fn(),
      } as ScheduledController,
      scheduledEnv(),
      { waitUntil: (promise) => waits.push(promise) } as unknown as ExecutionContext,
    );
    const results = await Promise.allSettled(waits);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const row = consoleError.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .find((value) => value.message === "approval_request_archive_failed");
    expect(row).toMatchObject({
      level: "error",
      job: "approval-request-archive",
      cron: "0 8 * * *",
    });
    for (const id of REQUEST_IDS) {
      expect(row?.fault).toEqual(expect.stringContaining(id));
    }
    expect(row?.fault).toEqual(expect.stringContaining("read token is unavailable"));
  });
});

function scheduledEnv(): ControlPlaneApiEnv {
  return {
    DB: h.d1,
    CREDENTIAL_CACHE_BACKFILL: {
      getByName: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }),
    },
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://api.tinybird.test",
    TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "write-token",
  } as unknown as ControlPlaneApiEnv;
}
