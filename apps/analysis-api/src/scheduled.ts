import type { TinybirdCopyTransport } from "./tinybird.js";

const SNAPSHOT_COPY_PIPE = "cp_deduped_exposures";
const SNAPSHOT_COPY_MODE = "replace";
const COPY_WATERMARK_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

export interface ScheduledSnapshotDeps {
  cron: string;
  logger?: Pick<Console, "log" | "error">;
  scheduledTimeMs: number;
  tinybird: TinybirdCopyTransport;
}

export async function runScheduledSnapshot(deps: ScheduledSnapshotDeps): Promise<void> {
  const watermarkTs = copyWatermarkFromScheduledTime(deps.scheduledTimeMs);

  try {
    await deps.tinybird.runCopyPipe(SNAPSHOT_COPY_PIPE, {
      _mode: SNAPSHOT_COPY_MODE,
      copy_watermark_ts: watermarkTs,
    });
    deps.logger?.log(
      `splitch-analysis-api: Tinybird snapshot ${deps.cron} triggered at watermark ${watermarkTs}`,
    );
  } catch (cause) {
    deps.logger?.error(`splitch-analysis-api: Tinybird snapshot ${deps.cron} failed`);
    throw cause;
  }
}

export function copyWatermarkFromScheduledTime(scheduledTimeMs: number): string {
  if (!Number.isFinite(scheduledTimeMs) || scheduledTimeMs < 0) {
    throw new Error("analysis-api: malformed snapshot copy watermark");
  }

  const date = new Date(scheduledTimeMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("analysis-api: malformed snapshot copy watermark");
  }

  const watermarkTs = date.toISOString().replace("T", " ").replace("Z", "");
  if (!COPY_WATERMARK_PATTERN.test(watermarkTs)) {
    throw new Error("analysis-api: malformed snapshot copy watermark");
  }
  return watermarkTs;
}
