import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMOTED_DATASOURCES = [
  "raw_events",
  "deduped_exposures",
  "metric_events",
  "environment_exposure_status_state",
];

export function assertPromotedForwardQueriesRemoved(root, fail) {
  for (const name of PROMOTED_DATASOURCES) {
    const contents = readFileSync(join(root, "datasources", `${name}.datasource`), "utf8");
    if (/^FORWARD_QUERY >/m.test(contents)) {
      fail(`${name} must not retain its completed one-release migration query`);
    }
  }
}
