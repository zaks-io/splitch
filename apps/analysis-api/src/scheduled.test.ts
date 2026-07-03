import { describe, expect, it } from "vitest";
import { copyWatermarkFromScheduledTime, runScheduledSnapshot } from "./scheduled.js";
import type { PipeParams, TinybirdCopyTransport } from "./tinybird.js";

const HOURLY_CRON = "0 * * * *";
const SCHEDULED_TIME_MS = Date.UTC(2026, 6, 3, 21, 0, 0, 123);
const WATERMARK_TS = "2026-07-03 21:00:00.123";

class FakeTinybirdCopy implements TinybirdCopyTransport {
  readonly calls: { pipeName: string; params: PipeParams }[] = [];

  async runCopyPipe(pipeName: string, params: PipeParams): Promise<void> {
    this.calls.push({ pipeName, params: { ...params } });
  }
}

describe("scheduled snapshot refresh", () => {
  it("invokes the deduped exposure Copy Pipe with the scheduled ingest watermark", async () => {
    const tinybird = new FakeTinybirdCopy();

    await runScheduledSnapshot({
      cron: HOURLY_CRON,
      logger: { log: () => undefined, error: () => undefined },
      scheduledTimeMs: SCHEDULED_TIME_MS,
      tinybird,
    });

    expect(tinybird.calls).toEqual([
      {
        pipeName: "cp_deduped_exposures",
        params: {
          _mode: "replace",
          copy_watermark_ts: WATERMARK_TS,
        },
      },
    ]);
  });

  it("fails loud on a malformed watermark before starting a copy job", async () => {
    const tinybird = new FakeTinybirdCopy();

    await expect(
      runScheduledSnapshot({
        cron: HOURLY_CRON,
        logger: { log: () => undefined, error: () => undefined },
        scheduledTimeMs: Number.NaN,
        tinybird,
      }),
    ).rejects.toThrow(/malformed snapshot copy watermark/);
    expect(tinybird.calls).toEqual([]);
  });

  it("formats Tinybird DateTime64 query parameters with millisecond precision", () => {
    expect(copyWatermarkFromScheduledTime(SCHEDULED_TIME_MS)).toBe(WATERMARK_TS);
  });
});
