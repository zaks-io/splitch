import { FLAG_CHANGE_LOG_RETENTION_MS } from "./flag-change-log-retention";

/**
 * Effective change-log coverage start for inventory churn: the later of the
 * earliest surviving log row and the retention floor (`asOf` minus the cron
 * retention window). Null only when the App has no log rows yet.
 */
export function changeLogCoverageStartsAt(
  asOf: string,
  earliestSurvivingLogAt: string | null,
): string | null {
  if (earliestSurvivingLogAt === null) return null;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`changeLogCoverageStartsAt: asOf is not a valid instant: ${asOf}`);
  }
  const retentionBoundary = new Date(asOfMs - FLAG_CHANGE_LOG_RETENTION_MS).toISOString();
  return earliestSurvivingLogAt > retentionBoundary ? earliestSurvivingLogAt : retentionBoundary;
}

/** A month is complete only when its UTC start is at or after coverage start. */
export function monthChurnCoverage(
  month: string,
  coverageStartsAt: string,
): "complete" | "partial" {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`monthChurnCoverage: month must be YYYY-MM, got ${month}`);
  }
  const monthStart = `${month}-01T00:00:00.000Z`;
  return monthStart >= coverageStartsAt ? "complete" : "partial";
}
