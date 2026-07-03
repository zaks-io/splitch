import { readStatsInputFromTinybird } from "./results.js";
import type { AnalysisApiEnv } from "./env.js";
import type { TinybirdReadTransport } from "./tinybird.js";

export interface ScheduledSnapshotDeps {
  cron: string;
  env: AnalysisApiEnv;
  logger?: Pick<Console, "log" | "error">;
  tinybird: TinybirdReadTransport;
}

export async function runScheduledSnapshot(deps: ScheduledSnapshotDeps): Promise<void> {
  const scope = scheduledScope(deps.env);
  if (scope === null) {
    deps.logger?.log(`splitch-analysis-api: Tinybird snapshot ${deps.cron} skipped`);
    return;
  }

  try {
    await readStatsInputFromTinybird(deps.tinybird, scope);
    deps.logger?.log(`splitch-analysis-api: Tinybird snapshot ${deps.cron} checked`);
  } catch (cause) {
    deps.logger?.error(`splitch-analysis-api: Tinybird snapshot ${deps.cron} failed`);
    throw cause;
  }
}

function scheduledScope(env: AnalysisApiEnv) {
  const appId = env.SPLITCH_SNAPSHOT_APP_ID;
  const environmentId = env.SPLITCH_SNAPSHOT_ENVIRONMENT_ID;
  const experimentId = env.SPLITCH_SNAPSHOT_EXPERIMENT_ID;
  if (!appId || !environmentId || !experimentId) {
    return null;
  }
  return {
    appId,
    environmentId,
    experimentId,
    runId: env.SPLITCH_SNAPSHOT_RUN_ID,
  };
}
