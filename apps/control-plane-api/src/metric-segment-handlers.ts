import { makeMetricHandlers } from "./metric-handlers";
import { makeSegmentHandlers } from "./segment-handlers";
import type { MetricSegmentDeps } from "./metric-segment-shared";

export function makeMetricSegmentHandlers(deps: MetricSegmentDeps) {
  return {
    ...makeMetricHandlers(deps),
    ...makeSegmentHandlers(deps),
  };
}
