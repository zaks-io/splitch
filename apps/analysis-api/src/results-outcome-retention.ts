import { DedupeExposureRowSchema } from "@splitch/contracts";
import { ResultsInputError } from "./results-errors";

const OUTCOME_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

/** Sticky SRM membership can outlive the Metric Events and Activations it joins. */
export function assertOutcomeHistoryRetained(input: {
  exposures: readonly Record<string, unknown>[];
  hasAnalyzedMetrics: boolean;
  activationGated: boolean;
  now: number;
}): void {
  if (!input.hasAnalyzedMetrics && !input.activationGated) return;
  // Tinybird's TTL truncates server_received_at to seconds. Refuse the entire
  // population rather than dropping old Entities or interpreting expired events
  // as zero conversions. A pinned watermark does not restore expired facts.
  const oldestRetainedMs = input.now - OUTCOME_RETENTION_MS;
  if (
    input.exposures.some((raw) => {
      const row = DedupeExposureRowSchema.parse(raw);
      return (
        row.variant !== "__multiple__" &&
        Math.floor(Date.parse(row.first_exposure_ts) / 1_000) * 1_000 <= oldestRetainedMs
      );
    })
  ) {
    throw new ResultsInputError(
      "Outcome history cannot cover the selected Exposure population: Metric Events and " +
        "Activations expire after 90 days. This Run cannot be reanalyzed from retained facts; " +
        "a pinned data watermark does not recover expired outcomes.",
    );
  }
}
