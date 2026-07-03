import { makeMetricHandlers } from "./metric-handlers.js";
import { makeSegmentHandlers } from "./segment-handlers.js";
import type { MetricSegmentDeps } from "./metric-segment-shared.js";

export function makeMetricSegmentHandlers(deps: MetricSegmentDeps) {
  return {
    ...makeMetricHandlers(deps),
    ...makeSegmentHandlers(deps),
  };
}
