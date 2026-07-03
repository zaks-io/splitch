import { describe, expect, it } from "vitest";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FakeTinybird,
  RUN_ID,
} from "./results-test-support.js";
import { runScheduledSnapshot } from "./scheduled.js";

describe("scheduled snapshot stub", () => {
  it("skips safely without a local snapshot scope", async () => {
    const tinybird = new FakeTinybird();
    const logs: string[] = [];

    await runScheduledSnapshot({
      cron: "0 * * * *",
      env: {},
      logger: { log: (message) => logs.push(message), error: (message) => logs.push(message) },
      tinybird,
    });

    expect(logs[0]).toContain("skipped");
    expect(tinybird.calls).toEqual([]);
  });

  it("uses the same app-scoped Tinybird read path when snapshot scope is configured", async () => {
    const tinybird = new FakeTinybird();

    await runScheduledSnapshot({
      cron: "0 * * * *",
      env: {
        SPLITCH_SNAPSHOT_APP_ID: APP_ID,
        SPLITCH_SNAPSHOT_ENVIRONMENT_ID: ENVIRONMENT_ID,
        SPLITCH_SNAPSHOT_EXPERIMENT_ID: EXPERIMENT_ID,
        SPLITCH_SNAPSHOT_RUN_ID: RUN_ID,
      },
      logger: { log: () => undefined, error: () => undefined },
      tinybird,
    });

    expect(tinybird.calls).not.toEqual([]);
    expect(tinybird.calls.every((call) => call.params.app_id === APP_ID)).toBe(true);
  });
});
