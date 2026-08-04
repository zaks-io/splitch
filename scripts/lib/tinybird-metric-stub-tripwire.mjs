import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Empty Metric / CUPED stubs (SPL-290) must not outlive real Metric Event ingest.
 * Marker is intentional: a pipe-header comment alone is not a gate.
 */
export const METRIC_STUB_UNTIL_MARKER = "# SPLITCH_EMPTY_STUB_UNTIL=metric_events";

const METRIC_STUB_PIPES = ["analysis_metric_values", "analysis_pre_period_covariates"];

/**
 * When `metric_events` exists under `infra/tinybird/datasources/`, every
 * Results Metric pipe still carrying the empty-stub marker fails loud.
 * Without this, Results would keep reporting zero-event Metrics forever after
 * ingest ships and nobody rewrote the stubs.
 *
 * @returns {string[]} human-readable failure messages (empty when the tripwire is clear)
 */
export function metricStubTripwireFailures(tinybirdRoot) {
  const metricEventsPath = join(tinybirdRoot, "datasources", "metric_events.datasource");
  if (!existsSync(metricEventsPath)) {
    return [];
  }

  const failures = [];
  for (const pipeName of METRIC_STUB_PIPES) {
    const pipePath = join(tinybirdRoot, "pipes", `${pipeName}.pipe`);
    if (!existsSync(pipePath)) {
      failures.push(
        `${pipeName}.pipe is missing while metric_events exists; ship a real Metric-value endpoint`,
      );
      continue;
    }
    const contents = readFileSync(pipePath, "utf8");
    if (contents.includes(METRIC_STUB_UNTIL_MARKER)) {
      failures.push(
        `${pipeName}.pipe still carries ${METRIC_STUB_UNTIL_MARKER} while metric_events.datasource exists; rewrite it to read real Metric Event data before Results silently reports zero-event Metrics forever`,
      );
    }
  }
  return failures;
}

export function assertMetricStubsRetiredWhenMetricEventsExist(tinybirdRoot, fail) {
  for (const message of metricStubTripwireFailures(tinybirdRoot)) {
    fail(message);
  }
}
